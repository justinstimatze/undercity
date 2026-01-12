/**
 * Solo Orchestrator - Light Mode
 *
 * A simpler orchestration approach that can run for hours unattended:
 * 1. Start with cheapest capable model
 * 2. Run task → Verify → Commit if good
 * 3. Escalate to better model if problems detected
 * 4. Keep going until all tasks done
 *
 * Two modes:
 * - Standard: Single agent with adaptive escalation (haiku→sonnet→opus)
 * - Supervised: Opus orchestrates cheaper workers (high quality, efficient)
 *
 * Philosophy:
 * - Minimum tokens for maximum quality
 * - External verification loop (don't trust agent's "done")
 * - Adaptive escalation (start cheap, escalate if needed)
 * - Use Opus for judgment, cheaper models for execution
 * - Can run unattended for hours
 */

import { execFileSync, execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { assessComplexityFast, assessComplexityQuantitative, type ComplexityAssessment } from "./complexity.js";
import { type ContextBriefing, prepareContext } from "./context.js";
import { dualLogger } from "./dual-logger.js";
import { createAndCheckout } from "./git.js";
import { recordQueryResult } from "./live-metrics.js";
import { sessionLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import * as output from "./output.js";
import { type ModelTier, type ReviewResult, runEscalatingReview, type UnresolvedTicket } from "./review.js";
import type { AttemptRecord, ErrorCategory, TokenUsage } from "./types.js";
import { categorizeErrors, type VerificationResult, verifyWork } from "./verification.js";

/**
 * Extract explicitly mentioned file names from task description
 * e.g., "Fix bug in solo.ts" → ["solo.ts"]
 */
function extractExplicitFiles(task: string): string[] {
	const filePatterns = [
		/\b([\w-]+\.(?:ts|tsx|js|jsx|py|md|json))\b/g, // filename.ext
		/\b(src\/[\w/-]+\.(?:ts|tsx|js|jsx))\b/g, // src/path/file.ts
	];

	const files: string[] = [];
	for (const pattern of filePatterns) {
		const matches = task.matchAll(pattern);
		for (const match of matches) {
			files.push(match[1]);
		}
	}

	return [...new Set(files)];
}

const MODEL_NAMES: Record<ModelTier, string> = {
	haiku: "claude-3-5-haiku-20241022",
	sonnet: "claude-sonnet-4-20250514",
	opus: "claude-opus-4-5-20251101",
};

/**
 * Task status for tracking
 */
type TaskStatus = "pending" | "running" | "verifying" | "complete" | "failed" | "escalated";

/**
 * Task execution result
 */
export interface TaskResult {
	task: string;
	status: TaskStatus;
	model: ModelTier;
	attempts: number;
	verification?: VerificationResult;
	commitSha?: string;
	error?: string;
	durationMs: number;
	/** Detailed token usage tracking */
	tokenUsage?: {
		/** Tokens used per attempt */
		attempts: TokenUsage[];
		/** Total tokens across all attempts */
		total: number;
	};
	/** Tickets for issues that couldn't be resolved - queue as child tasks */
	unresolvedTickets?: UnresolvedTicket[];
}

/**
 * Solo orchestrator options
 */
export interface SoloOptions {
	/** Maximum attempts per task before failing */
	maxAttempts?: number;
	/** Starting model tier */
	startingModel?: ModelTier;
	/** Whether to auto-commit after each task */
	autoCommit?: boolean;
	/** Stream agent output */
	stream?: boolean;
	/** Verbose logging */
	verbose?: boolean;
	/** Branch name to work on */
	branch?: string;
	/** Whether to run typecheck as verification */
	runTypecheck?: boolean;
	/** Whether to run tests as verification */
	runTests?: boolean;
	/** Working directory for task execution (default: process.cwd()) */
	workingDirectory?: string;
	/** Enable escalating review passes before commit (haiku → sonnet → opus) */
	reviewPasses?: boolean;
	/** Maximum review passes per tier before escalating (haiku/sonnet) */
	maxReviewPassesPerTier?: number;
	/**
	 * Maximum review passes at opus tier (final tier has no escalation path).
	 * Defaults to maxReviewPassesPerTier * 3 if not set.
	 */
	maxOpusReviewPasses?: number;
	/** Use annealing review at opus tier (multi-angle advisory review) */
	annealingAtOpus?: boolean;
	/**
	 * Maximum fix attempts at the same model tier before escalating.
	 * Allows the model to retry fixing errors multiple times before moving to a stronger model.
	 * Default: 3 (allows 3 retries at same tier before escalating)
	 */
	maxRetriesPerTier?: number;
}

/**
 * Solo Orchestrator
 *
 * Runs tasks sequentially with verification and adaptive escalation.
 */
export class TaskWorker {
	private maxAttempts: number;
	private startingModel: ModelTier;
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private branch?: string;
	private runTypecheck: boolean;
	private runTests: boolean;
	private workingDirectory: string;
	private reviewPasses: boolean;
	private maxReviewPassesPerTier: number;
	private maxOpusReviewPasses: number;
	private annealingAtOpus: boolean;
	private maxRetriesPerTier: number;

	private currentModel: ModelTier;
	private attempts: number = 0;
	private currentBriefing?: ContextBriefing;
	private currentTaskId: string = "";

	/** Metrics tracker for token usage and efficiency */
	private metricsTracker: MetricsTracker;

	/** Track individual attempts for metrics */
	private attemptRecords: AttemptRecord[] = [];

	/** Track token usage for current task */
	private tokenUsageThisTask: TokenUsage[] = [];

	/** Track retries at same model tier (reset on escalation) */
	private sameModelRetries: number = 0;

	/** Pending tickets from review that couldn't be resolved */
	private pendingTickets: UnresolvedTicket[] = [];

	constructor(options: SoloOptions = {}) {
		this.maxAttempts = options.maxAttempts ?? 3;
		this.startingModel = options.startingModel ?? "sonnet";
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.branch = options.branch;
		this.runTypecheck = options.runTypecheck ?? true;
		this.runTests = options.runTests ?? true;
		this.workingDirectory = options.workingDirectory ?? process.cwd();
		this.reviewPasses = options.reviewPasses ?? false;
		this.maxReviewPassesPerTier = options.maxReviewPassesPerTier ?? 2;
		// Opus is final tier - no escalation path, so give it more attempts by default
		this.maxOpusReviewPasses = options.maxOpusReviewPasses ?? this.maxReviewPassesPerTier * 3;
		this.annealingAtOpus = options.annealingAtOpus ?? false;
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 3;
		this.currentModel = this.startingModel;
		this.metricsTracker = new MetricsTracker();
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			sessionLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Run a single task with verification and potential escalation
	 */
	async runTask(task: string): Promise<TaskResult> {
		const startTime = Date.now();
		this.attempts = 0;
		this.attemptRecords = [];
		this.tokenUsageThisTask = [];
		this.sameModelRetries = 0;
		this.pendingTickets = []; // Clear tickets from previous task

		// Ensure clean state before starting (in case previous task left dirty state)
		this.cleanupDirtyState();

		const taskId = `solo_${Date.now()}`;
		this.currentTaskId = taskId; // Store for use in other methods
		const sessionId = `session_${Date.now()}`;

		output.taskStart(taskId, task.substring(0, 60) + (task.length > 60 ? "..." : ""));

		// Pre-flight: Prepare context briefing (FREE - no LLM tokens)
		// Do this FIRST so we can use target files for quantitative complexity assessment
		output.workerPhase(taskId, "analyzing");
		let targetFiles: string[] = [];
		try {
			this.currentBriefing = await prepareContext(task);
			targetFiles = this.currentBriefing.targetFiles;
			const sigCount = this.currentBriefing.functionSignatures.length;
			output.debug(`Found ${targetFiles.length} target files, ${sigCount} signatures`, { taskId });
		} catch (error) {
			this.log("Context preparation failed", { error: String(error) });
			// Continue without briefing - agent will explore
		}

		// Assess complexity using quantitative metrics when we have target files
		// If task mentions specific files, prioritize those for metrics (more accurate)
		const explicitFiles = extractExplicitFiles(task);
		const filesForMetrics =
			explicitFiles.length > 0
				? targetFiles.filter((t) => explicitFiles.some((f) => t.includes(f) || t.endsWith(f)))
				: targetFiles.slice(0, 5); // Limit to 5 most relevant files

		let assessment: ComplexityAssessment;
		if (filesForMetrics.length > 0) {
			assessment = assessComplexityQuantitative(task, filesForMetrics, this.workingDirectory);
			const metricsInfo = assessment.metrics
				? ` (${assessment.metrics.totalLines} lines, ${assessment.metrics.functionCount} functions)`
				: "";
			output.info(`Complexity: ${assessment.level}${metricsInfo}`, {
				taskId,
				complexity: assessment.level,
				lines: assessment.metrics?.totalLines,
				functions: assessment.metrics?.functionCount,
			});
			if (assessment.metrics?.crossPackage) {
				output.debug(`Cross-package: ${assessment.metrics.packages.join(", ")}`, { taskId });
			}
			if (assessment.metrics?.avgCodeHealth !== undefined) {
				output.debug(`Code health: ${assessment.metrics.avgCodeHealth.toFixed(1)}/10`, { taskId });
			}
			if (assessment.metrics?.git.hotspots.length) {
				output.debug(`Git hotspots: ${assessment.metrics.git.hotspots.length} files`, { taskId });
			}
		} else if (targetFiles.length > 0) {
			// Had target files but none matched explicit - use first 5
			assessment = assessComplexityQuantitative(task, targetFiles.slice(0, 5), this.workingDirectory);
			const metricsInfo = assessment.metrics
				? ` (${assessment.metrics.totalLines} lines, ${assessment.metrics.functionCount} functions)`
				: "";
			output.info(`Complexity: ${assessment.level}${metricsInfo}`, { taskId, complexity: assessment.level });
		} else {
			// Fall back to keyword-based assessment
			assessment = assessComplexityFast(task);
			output.info(`Complexity: ${assessment.level} (keyword-based)`, { taskId, complexity: assessment.level });
		}

		this.currentModel = this.determineStartingModel(assessment);
		const reviewLevel = this.determineReviewLevel(assessment);

		// Start task tracking in metrics with the starting model
		this.metricsTracker.startTask(taskId, task, sessionId, this.currentModel);
		this.metricsTracker.recordAgentSpawn(this.currentModel === "opus" ? "reviewer" : "builder");

		this.log("Starting task", { task, model: this.currentModel, assessment: assessment.level, reviewLevel });
		output.info(`Model: ${this.currentModel}`, { taskId, model: this.currentModel });
		if (reviewLevel.review) {
			const reviewMode = reviewLevel.annealing ? "escalating + annealing" : "escalating";
			const reviewCap = reviewLevel.maxReviewTier !== "opus" ? ` (cap: ${reviewLevel.maxReviewTier})` : "";
			output.info(`Reviews: ${reviewMode}${reviewCap}`, { taskId, reviewMode, maxTier: reviewLevel.maxReviewTier });
		}

		// Set up branch if specified
		if (this.branch) {
			try {
				createAndCheckout(this.branch);
				this.log("Switched to branch", { branch: this.branch });
			} catch (error) {
				// Branch might already exist, that's fine
				this.log("Branch setup note", { error: String(error) });
			}
		}

		while (this.attempts < this.maxAttempts) {
			this.attempts++;
			this.sameModelRetries++;
			const attemptStart = Date.now();
			output.workerAttempt(taskId, this.attempts, this.maxAttempts, this.currentModel, {
				retry: this.sameModelRetries,
			});

			try {
				// Run the agent
				output.workerPhase(taskId, "executing", { model: this.currentModel });
				const _result = await this.executeAgent(task);

				// Verify the work
				output.workerPhase(taskId, "verifying");
				const verification = await verifyWork(this.runTypecheck, this.runTests, this.workingDirectory);

				// Categorize errors for tracking
				const errorCategories = categorizeErrors(verification);

				if (verification.passed) {
					output.workerVerification(taskId, true);
					// Run review passes if enabled (auto-selected or user-specified)
					let finalVerification = verification;
					if (reviewLevel.review) {
						output.workerPhase(taskId, "reviewing");
						const reviewResult = await runEscalatingReview(task, {
							useAnnealing: reviewLevel.annealing,
							maxReviewTier: reviewLevel.maxReviewTier,
							maxReviewPassesPerTier: this.maxReviewPassesPerTier,
							maxOpusReviewPasses: this.maxOpusReviewPasses,
							workingDirectory: this.workingDirectory,
							runTypecheck: this.runTypecheck,
							runTests: this.runTests,
							verbose: this.verbose,
						});
						if (!reviewResult.converged) {
							// Review couldn't resolve all issues - store tickets for later
							if (reviewResult.unresolvedTickets && reviewResult.unresolvedTickets.length > 0) {
								// Store tickets - they'll be passed through if we fail completely
								this.pendingTickets = reviewResult.unresolvedTickets;
							}
							output.warning("Review could not fully resolve issues, retrying task...", { taskId });
							this.lastFeedback = `Review found issues that couldn't be fully resolved: ${reviewResult.issuesFound.join(", ")}`;
							continue;
						}
						// Re-verify after reviews if issues were found and fixed
						if (reviewResult.issuesFound.length > 0) {
							finalVerification = await verifyWork(this.runTypecheck, this.runTests, this.workingDirectory);
							if (!finalVerification.passed) {
								output.warning("Final verification failed after reviews", { taskId });
								this.lastFeedback = finalVerification.feedback;
								continue;
							}
						}
					}

					// Success! Record the attempt and clear feedback
					this.attemptRecords.push({
						model: this.currentModel,
						durationMs: Date.now() - attemptStart,
						success: true,
					});
					this.lastFeedback = undefined;

					let commitSha: string | undefined;
					if (this.autoCommit && finalVerification.filesChanged > 0) {
						output.workerPhase(taskId, "committing");
						commitSha = await this.commitWork(task);
					}

					// Pass attempt records to metrics tracker before completing
					this.metricsTracker.recordAttempts(this.attemptRecords);

					// Complete task tracking
					this.metricsTracker.completeTask(true);

					return {
						task,
						status: "complete",
						model: this.currentModel,
						attempts: this.attempts,
						verification: finalVerification,
						commitSha,
						durationMs: Date.now() - startTime,
						tokenUsage: {
							attempts: this.tokenUsageThisTask,
							total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
						},
					};
				}

				// Verification failed - record attempt and store feedback
				this.attemptRecords.push({
					model: this.currentModel,
					durationMs: Date.now() - attemptStart,
					success: false,
					errorCategories,
				});
				this.lastFeedback = verification.feedback;

				const errorSummary = errorCategories.length > 0 ? errorCategories.join(", ") : verification.issues.join(", ");
				output.workerVerification(taskId, false, [errorSummary]);

				// Decide: retry same tier or escalate?
				const escalationDecision = this.shouldEscalate(verification, errorCategories);

				if (escalationDecision.shouldEscalate) {
					const previousModel = this.currentModel;
					const escalated = this.escalateModel();
					if (escalated) {
						// Get post-mortem from the failed tier before moving on
						output.debug(`Getting post-mortem from ${previousModel}...`, { taskId });
						this.lastPostMortem = await this.getPostMortem(task, verification.feedback, previousModel);

						// Update last attempt record with escalation info
						const lastAttempt = this.attemptRecords[this.attemptRecords.length - 1];
						lastAttempt.escalatedFrom = previousModel as "haiku" | "sonnet";
						lastAttempt.postMortemGenerated = true;

						// Reset same-model retry counter
						this.sameModelRetries = 0;
						output.workerEscalation(taskId, previousModel, this.currentModel, escalationDecision.reason);
					} else {
						// Already at max, one more try
						output.warning("At max model tier, final attempt...", { taskId, model: this.currentModel });
					}
				} else {
					// Retrying at same tier - just use feedback, no post-mortem
					output.debug(`Retrying at ${this.currentModel} (${escalationDecision.reason})`, { taskId });
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				output.error(`Error: ${errorMessage.substring(0, 100)}`, { taskId });

				// Record failed attempt
				this.attemptRecords.push({
					model: this.currentModel,
					durationMs: Date.now() - attemptStart,
					success: false,
					errorCategories: ["unknown"],
				});

				// Escalate on exceptions
				this.escalateModel();
				this.sameModelRetries = 0;
			}
		}

		// Failed after all attempts - clean up dirty state
		// Pass attempt records to metrics tracker before completing
		this.metricsTracker.recordAttempts(this.attemptRecords);
		this.metricsTracker.completeTask(false);
		this.cleanupDirtyState();

		return {
			task,
			status: "failed",
			model: this.currentModel,
			attempts: this.attempts,
			error: "Max attempts reached without passing verification",
			durationMs: Date.now() - startTime,
			tokenUsage: {
				attempts: this.tokenUsageThisTask,
				total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
			},
			// Include tickets for issues that couldn't be resolved - caller can queue these
			unresolvedTickets: this.pendingTickets.length > 0 ? this.pendingTickets : undefined,
		};
	}

	/**
	 * Clean up any uncommitted changes after a failed task
	 * This prevents dirty state from affecting subsequent tasks
	 */
	private cleanupDirtyState(): void {
		try {
			// Reset any staged and unstaged changes
			// CRITICAL: Must use workingDirectory, not process.cwd() - otherwise cleans wrong repo in worktree mode
			execSync("git checkout -- . 2>/dev/null || true", { encoding: "utf-8", cwd: this.workingDirectory });
			// Remove any untracked files created during the attempt
			execSync("git clean -fd 2>/dev/null || true", { encoding: "utf-8", cwd: this.workingDirectory });
			this.log("Cleaned up dirty state after failed task");
		} catch (error) {
			this.log("Failed to cleanup dirty state", { error: String(error) });
		}
	}

	/**
	 * Get a post-mortem analysis from a failed tier before escalating.
	 * Uses Haiku for speed/cost - the analysis doesn't need to be perfect,
	 * just helpful context for the next tier.
	 */
	private async getPostMortem(task: string, feedback: string, failedModel: ModelTier): Promise<string> {
		const prompt = `You just attempted this task and failed verification:

TASK: ${task}

VERIFICATION ERRORS:
${feedback}

Please provide a brief post-mortem analysis (2-4 sentences):
1. What approach did you likely take?
2. Why do you think it failed?
3. What should the next attempt try differently?

Be concise and specific. Focus on actionable insights.`;

		try {
			let result = "";
			// Always use Haiku for post-mortem - it's fast and cheap
			for await (const message of query({
				prompt,
				options: {
					model: MODEL_NAMES.haiku,
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					maxTurns: 1, // Single response, no tool use needed
					settingSources: ["project"], // Load disallowedTools from settings
				},
			})) {
				if (message.type === "result" && message.subtype === "success") {
					result = message.result;
				}
			}

			this.log("Post-mortem generated", { failedModel, length: result.length });
			return result || "No post-mortem analysis available.";
		} catch (error) {
			this.log("Failed to generate post-mortem", { error: String(error) });
			return "Post-mortem analysis failed - proceeding without it.";
		}
	}

	/**
	 * Run multiple tasks sequentially
	 */
	async runTasks(tasks: string[]): Promise<TaskResult[]> {
		const results: TaskResult[] = [];

		output.header("Solo Mode", `Processing ${tasks.length} task(s)`);

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			output.progress(`Task ${i + 1}/${tasks.length}`, { current: i + 1, total: tasks.length, label: "tasks" });

			const result = await this.runTask(task);
			results.push(result);

			if (result.status === "complete") {
				output.taskComplete(this.currentTaskId, `Complete in ${Math.round(result.durationMs / 1000)}s`, {
					commitSha: result.commitSha?.substring(0, 8),
				});
			} else {
				output.taskFailed(this.currentTaskId, `Failed after ${result.attempts} attempts`, result.error);
			}
		}

		// Summary
		const completed = results.filter((r) => r.status === "complete").length;
		const failed = results.filter((r) => r.status === "failed").length;

		output.summary("Summary", [
			{ label: "Completed", value: completed, status: completed > 0 ? "good" : "neutral" },
			{ label: "Failed", value: failed, status: failed > 0 ? "bad" : "neutral" },
		]);

		return results;
	}

	/**
	 * Determine starting model based on complexity assessment
	 */
	private determineStartingModel(assessment: ComplexityAssessment): ModelTier {
		// Override with user preference if set
		if (this.startingModel !== "sonnet") {
			return this.startingModel;
		}

		// Use assessment to pick model
		switch (assessment.level) {
			case "trivial":
				return "haiku";
			case "simple":
				return "haiku";
			case "standard":
				return "sonnet";
			case "complex":
				return "sonnet"; // Start with sonnet, escalate if needed
			case "critical":
				return "opus"; // Critical tasks go straight to opus
			default:
				return "sonnet";
		}
	}

	/**
	 * Determine review level based on complexity assessment
	 *
	 * Review escalation is capped by task complexity to save opus tokens:
	 * - trivial/simple/standard: haiku → sonnet only (no opus review)
	 * - complex/critical: haiku → sonnet → opus (full escalation + annealing)
	 *
	 * Rationale: 95% of tasks are trivial/simple/standard and don't benefit from
	 * opus review. The token cost isn't justified when sonnet can catch most issues.
	 */
	private determineReviewLevel(assessment: ComplexityAssessment): {
		review: boolean;
		annealing: boolean;
		maxReviewTier: ModelTier;
	} {
		// If user explicitly set annealing, respect it (full escalation)
		if (this.annealingAtOpus) {
			return { review: true, annealing: true, maxReviewTier: "opus" };
		}

		// If user explicitly disabled reviews, respect that
		if (!this.reviewPasses) {
			return { review: false, annealing: false, maxReviewTier: "sonnet" };
		}

		// Reviews are enabled - determine escalation cap based on complexity
		switch (assessment.level) {
			case "trivial":
			case "simple":
			case "standard":
				// Simple tasks get capped review: haiku → sonnet only (no opus)
				return { review: true, annealing: false, maxReviewTier: "sonnet" };
			case "complex":
			case "critical":
				// Complex/critical tasks get full escalation + annealing
				return { review: true, annealing: true, maxReviewTier: "opus" };
			default:
				// Default to capped review
				return { review: true, annealing: false, maxReviewTier: "sonnet" };
		}
	}

	/** Previous verification feedback for retry context */
	private lastFeedback?: string;

	/** Post-mortem analysis from previous tier (only set on escalation) */
	private lastPostMortem?: string;

	/**
	 * Execute the agent on current task
	 */
	private async executeAgent(task: string): Promise<string> {
		let result = "";

		// Build prompt with pre-flight briefing and verification feedback
		let contextSection = "";
		if (this.currentBriefing?.briefingDoc) {
			contextSection = `
${this.currentBriefing.briefingDoc}

---

`;
		}

		let retryContext = "";
		if (this.attempts > 1 && this.lastFeedback) {
			retryContext = `

PREVIOUS ATTEMPT FAILED. Here's what the verification tools found:
${this.lastFeedback}

Please fix these specific issues.`;
		}

		// Add post-mortem context if escalating from a different tier
		let postMortemContext = "";
		if (this.lastPostMortem) {
			postMortemContext = `

POST-MORTEM FROM PREVIOUS TIER:
${this.lastPostMortem}

Use this analysis to avoid repeating the same mistakes.`;
			// Clear after use - only applies to first attempt at new tier
			this.lastPostMortem = undefined;
		}

		const prompt = `${contextSection}
═══════════════════════════════════════════════════════════════════════════════
MANDATORY SCOPE CONSTRAINT - READ THIS FIRST
═══════════════════════════════════════════════════════════════════════════════

You are a SURGICAL tool. Your job is to make the MINIMUM changes needed.

FORBIDDEN ACTIONS (will cause task rejection):
• Modifying ANY file not directly required for this specific task
• Refactoring, cleaning up, or "improving" existing code
• Adding features, comments, or documentation beyond what's requested
• Fixing unrelated issues you notice while working
• Renaming variables/functions unless explicitly requested

THE ONLY FILES YOU MAY TOUCH are those DIRECTLY required to complete the task below.
If the task says "add a comment to X", you modify ONLY file X. Nothing else.

Scope creep = task failure. Stay focused.

═══════════════════════════════════════════════════════════════════════════════

TASK:
${task}${retryContext}${postMortemContext}

Guidelines:
- Start with the target files listed in the briefing above (if provided)
- Make the minimal changes needed - nothing more
- Follow existing code patterns and conventions
- Run typecheck before finishing to verify your changes
- If blocked, explain what's stopping you

GIT RULES:
- You may commit locally (git add, git commit)
- NEVER run "git push" - the orchestrator handles all pushes
- Pushing bypasses verification and is strictly forbidden

When done, provide a brief summary of ONLY the files you changed.`;

		// Token usage will be accumulated in this.tokenUsageThisTask

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[this.currentModel],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				// Defense-in-depth: explicitly block git push even if settings fail to load
				disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			},
		})) {
			// Track token usage
			const usage = this.metricsTracker.extractTokenUsage(message);
			if (usage) {
				this.metricsTracker.recordTokenUsage(message, this.currentModel);
				this.tokenUsageThisTask.push(usage);
			}

			// Stream output if enabled
			if (this.stream) {
				this.streamMessage(message);
			}

			if (message.type === "result") {
				// Record SDK metrics to live-metrics.json
				const msg = message as Record<string, unknown>;
				const usageData = msg.usage as Record<string, number> | undefined;
				const modelUsage = msg.modelUsage as Record<string, Record<string, number>> | undefined;

				recordQueryResult({
					success: msg.subtype === "success",
					rateLimited: msg.subtype === "error" && String(msg.result || "").includes("rate"),
					inputTokens: usageData?.inputTokens ?? 0,
					outputTokens: usageData?.outputTokens ?? 0,
					cacheReadTokens: usageData?.cacheReadInputTokens ?? 0,
					cacheCreationTokens: usageData?.cacheCreationInputTokens ?? 0,
					costUsd: (msg.total_cost_usd as number) ?? 0,
					durationMs: (msg.duration_ms as number) ?? 0,
					apiDurationMs: (msg.duration_api_ms as number) ?? 0,
					turns: (msg.num_turns as number) ?? 0,
					model: this.currentModel,
					modelUsage: modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>,
				});

				if (msg.subtype === "success") {
					result = msg.result as string;
				}
			}
		}

		return result;
	}

	/**
	 * Stream agent messages to console
	 */
	private streamMessage(message: unknown): void {
		const msg = message as Record<string, unknown>;
		const prefix = chalk.dim(`[${this.currentModel}]`);

		if (msg.type === "content_block_start") {
			const contentBlock = msg.content_block as { type?: string; name?: string } | undefined;
			if (contentBlock?.type === "tool_use" && contentBlock.name) {
				dualLogger.writeLine(`${prefix} ${chalk.yellow(contentBlock.name)}`);
			}
		}

		if (msg.type === "result" && msg.subtype === "success") {
			dualLogger.writeLine(`${prefix} ${chalk.green("✓")} Done`);
		}
	}

	/**
	 * Decide whether to escalate to a better model
	 *
	 * Strategy:
	 * - No changes made: escalate immediately (agent is stuck)
	 * - Trivial errors (lint/spell only): allow full maxRetriesPerTier attempts
	 * - Serious errors (typecheck/build/test): allow fewer retries (maxRetriesPerTier - 1)
	 *   to escalate faster for errors that likely need a smarter model
	 *
	 * The configurable maxRetriesPerTier (default: 3) allows multiple fix attempts
	 * at the same tier before escalating to a stronger model.
	 */
	private shouldEscalate(
		verification: VerificationResult,
		errorCategories: ErrorCategory[],
	): { shouldEscalate: boolean; reason: string } {
		// No changes made = agent is stuck, escalate immediately
		if (verification.filesChanged === 0) {
			return { shouldEscalate: true, reason: "no changes made" };
		}

		// Check if errors are only trivial (lint/spell)
		const trivialOnly = errorCategories.every((c) => c === "lint" || c === "spell");
		const hasSerious = errorCategories.some((c) => c === "typecheck" || c === "build" || c === "test");

		if (trivialOnly) {
			// Trivial errors: allow full maxRetriesPerTier attempts before escalating
			if (this.sameModelRetries < this.maxRetriesPerTier) {
				const remaining = this.maxRetriesPerTier - this.sameModelRetries;
				return { shouldEscalate: false, reason: `trivial error, ${remaining} retries left at tier` };
			}
			return { shouldEscalate: true, reason: `trivial errors persist after ${this.maxRetriesPerTier} retries` };
		}

		if (hasSerious) {
			// Serious errors: allow fewer retries (at least 2, but less than max for trivial)
			// This escalates faster for type/build/test errors that likely need a smarter model
			const seriousRetryLimit = Math.max(2, this.maxRetriesPerTier - 1);
			if (this.sameModelRetries < seriousRetryLimit) {
				const remaining = seriousRetryLimit - this.sameModelRetries;
				return { shouldEscalate: false, reason: `serious error, ${remaining} retries left at tier` };
			}
			return { shouldEscalate: true, reason: `serious errors after ${seriousRetryLimit} retries` };
		}

		// Default: escalate after maxRetriesPerTier
		if (this.sameModelRetries >= this.maxRetriesPerTier) {
			return { shouldEscalate: true, reason: `max retries at tier (${this.maxRetriesPerTier})` };
		}

		return { shouldEscalate: false, reason: "retrying" };
	}

	/**
	 * Escalate to the next model tier
	 */
	private escalateModel(): boolean {
		const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];
		const currentIndex = tiers.indexOf(this.currentModel);

		if (currentIndex < tiers.length - 1) {
			const previousModel = this.currentModel;
			const newModel = tiers[currentIndex + 1];
			// Note: output.workerEscalation is called by the caller with reason
			this.currentModel = newModel;
			// Record escalation in metrics tracker
			this.metricsTracker.recordEscalation(previousModel, newModel);
			return true;
		}

		return false;
	}

	/**
	 * Commit the work
	 */
	private async commitWork(task: string): Promise<string> {
		try {
			// Stage all tracked changes (not untracked files to avoid committing temp files)
			// CRITICAL: Must use workingDirectory, not process.cwd() - otherwise commits in wrong repo
			execFileSync("git", ["add", "-u"], { cwd: this.workingDirectory });

			// Also stage any new files that were created (but not in .gitignore)
			// Use git status to find untracked files and add them selectively
			try {
				const untrackedOutput = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
					encoding: "utf-8",
					cwd: this.workingDirectory,
				}).trim();
				if (untrackedOutput) {
					const untrackedFiles = untrackedOutput.split("\n").filter((f) => f.length > 0);
					for (const file of untrackedFiles) {
						execFileSync("git", ["add", file], { cwd: this.workingDirectory });
					}
				}
			} catch {
				// Ignore errors from untracked file handling
			}

			// Create commit message
			const shortTask = task.substring(0, 50) + (task.length > 50 ? "..." : "");
			const commitMessage = shortTask;

			// Commit (skip hooks - we already did verification)
			execFileSync("git", ["commit", "--no-verify", "-m", commitMessage], {
				cwd: this.workingDirectory,
			});

			// Get commit SHA
			const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", cwd: this.workingDirectory }).trim();

			this.log("Committed work", { sha, task: shortTask });
			return sha;
		} catch (error) {
			this.log("Commit failed", { error: String(error) });
			throw error;
		}
	}
}

/**
 * Create and run a task worker
 */
export async function runSolo(tasks: string[], options: SoloOptions = {}): Promise<TaskResult[]> {
	const orchestrator = new TaskWorker(options);
	return orchestrator.runTasks(tasks);
}
