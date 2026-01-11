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

import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { AnnealingReview } from "./annealing-review.js";
import { formatErrorsForAgent, getCache, parseTypeScriptErrors } from "./cache.js";
import { assessComplexityFast, assessComplexityQuantitative, type ComplexityAssessment } from "./complexity.js";
import { type ContextBriefing, prepareContext } from "./context.js";
import { dualLogger } from "./dual-logger.js";
import { createAndCheckout } from "./git.js";
import { raidLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import type { AttemptRecord, ErrorCategory, TokenUsage } from "./types.js";

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

/**
 * Model tiers for escalation
 */
type ModelTier = "haiku" | "sonnet" | "opus";

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
 * Verification result
 */
interface VerificationResult {
	passed: boolean;
	typecheckPassed: boolean;
	testsPassed: boolean;
	lintPassed: boolean;
	spellPassed: boolean;
	codeHealthPassed: boolean;
	filesChanged: number;
	linesChanged: number;
	issues: string[];
	/** Detailed feedback for the agent to act on */
	feedback: string;
}

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
	/** Maximum review passes per tier before escalating */
	maxReviewPassesPerTier?: number;
	/** Use annealing review at opus tier (multi-angle advisory review) */
	annealingAtOpus?: boolean;
}

/**
 * Review pass result
 */
export interface ReviewResult {
	model: ModelTier;
	foundIssues: boolean;
	issues: string[];
	suggestion?: string;
	converged: boolean;
}

/**
 * Solo Orchestrator
 *
 * Runs tasks sequentially with verification and adaptive escalation.
 */
export class SoloOrchestrator {
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
	private annealingAtOpus: boolean;

	private currentModel: ModelTier;
	private attempts: number = 0;
	private currentBriefing?: ContextBriefing;

	/** Metrics tracker for token usage and efficiency */
	private metricsTracker: MetricsTracker;

	/** Track individual attempts for metrics */
	private attemptRecords: AttemptRecord[] = [];

	/** Track token usage for current task */
	private tokenUsageThisTask: TokenUsage[] = [];

	/** Track retries at same model tier (reset on escalation) */
	private sameModelRetries: number = 0;

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
		this.annealingAtOpus = options.annealingAtOpus ?? false;
		this.currentModel = this.startingModel;
		this.metricsTracker = new MetricsTracker();
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			raidLogger.info(data ?? {}, message);
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

		// Ensure clean state before starting (in case previous task left dirty state)
		this.cleanupDirtyState();

		// Start quest tracking in metrics
		this.metricsTracker.startQuest(
			`solo_${Date.now()}`, // Generate unique quest ID
			task,
			`raid_${Date.now()}`, // Generate unique raid ID
		);

		console.log(chalk.cyan(`\n━━━ Task: ${task.substring(0, 60)}${task.length > 60 ? "..." : ""} ━━━`));

		// Pre-flight: Prepare context briefing (FREE - no LLM tokens)
		// Do this FIRST so we can use target files for quantitative complexity assessment
		console.log(chalk.dim("  Analyzing codebase..."));
		let targetFiles: string[] = [];
		try {
			this.currentBriefing = await prepareContext(task);
			targetFiles = this.currentBriefing.targetFiles;
			const sigCount = this.currentBriefing.functionSignatures.length;
			console.log(chalk.dim(`  Found ${targetFiles.length} target files, ${sigCount} signatures`));
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
			console.log(chalk.dim(`  Complexity: ${assessment.level}${metricsInfo}`));
			if (assessment.metrics?.crossPackage) {
				console.log(chalk.dim(`  Cross-package: ${assessment.metrics.packages.join(", ")}`));
			}
			if (assessment.metrics?.avgCodeHealth !== undefined) {
				console.log(chalk.dim(`  Code health: ${assessment.metrics.avgCodeHealth.toFixed(1)}/10`));
			}
			if (assessment.metrics?.git.hotspots.length) {
				console.log(chalk.dim(`  Git hotspots: ${assessment.metrics.git.hotspots.length} files`));
			}
		} else if (targetFiles.length > 0) {
			// Had target files but none matched explicit - use first 5
			assessment = assessComplexityQuantitative(task, targetFiles.slice(0, 5), this.workingDirectory);
			const metricsInfo = assessment.metrics
				? ` (${assessment.metrics.totalLines} lines, ${assessment.metrics.functionCount} functions)`
				: "";
			console.log(chalk.dim(`  Complexity: ${assessment.level}${metricsInfo}`));
		} else {
			// Fall back to keyword-based assessment
			assessment = assessComplexityFast(task);
			console.log(chalk.dim(`  Complexity: ${assessment.level} (keyword-based)`));
		}

		this.currentModel = this.determineStartingModel(assessment);
		const reviewLevel = this.determineReviewLevel(assessment);
		this.metricsTracker.recordAgentSpawn(this.currentModel === "opus" ? "sheriff" : "quester");

		this.log("Starting task", { task, model: this.currentModel, assessment: assessment.level, reviewLevel });
		console.log(chalk.dim(`  Model: ${this.currentModel}`));
		if (reviewLevel.review) {
			const reviewMode = reviewLevel.annealing ? "escalating + annealing" : "escalating";
			console.log(chalk.dim(`  Reviews: ${reviewMode}`));
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

		// Prepare token usage tracking
		const tokenUsageThisAttempt: TokenUsage[] = [];

		while (this.attempts < this.maxAttempts) {
			this.attempts++;
			this.sameModelRetries++;
			const attemptStart = Date.now();
			console.log(
				chalk.dim(
					`  Attempt ${this.attempts}/${this.maxAttempts} (${this.currentModel}, retry ${this.sameModelRetries})`,
				),
			);

			try {
				// Run the agent
				const _result = await this.executeAgent(task);

				// Verify the work
				const verification = await this.verifyWork();

				// Categorize errors for tracking
				const errorCategories = this.categorizeErrors(verification);

				if (verification.passed) {
					// Run review passes if enabled (auto-selected or user-specified)
					let finalVerification = verification;
					if (reviewLevel.review) {
						const reviewResult = await this.runEscalatingReview(task, reviewLevel.annealing);
						if (!reviewResult.converged) {
							// Review fix broke verification, retry
							console.log(chalk.yellow(`  Review fix broke verification, retrying...`));
							this.lastFeedback = `Review found issues: ${reviewResult.issuesFound.join(", ")}`;
							continue;
						}
						// Re-verify after reviews if issues were found and fixed
						if (reviewResult.issuesFound.length > 0) {
							finalVerification = await this.verifyWork();
							if (!finalVerification.passed) {
								console.log(chalk.yellow(`  Final verification failed after reviews`));
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
						commitSha = await this.commitWork(task);
					}

					// Complete quest tracking
					this.metricsTracker.completeQuest(true);

					return {
						task,
						status: "complete",
						model: this.currentModel,
						attempts: this.attempts,
						verification: finalVerification,
						commitSha,
						durationMs: Date.now() - startTime,
						tokenUsage: {
							attempts: tokenUsageThisAttempt,
							total: tokenUsageThisAttempt.reduce((sum, usage) => sum + usage.totalTokens, 0),
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
				console.log(chalk.yellow(`  Verification failed: ${errorSummary}`));

				// Decide: retry same tier or escalate?
				const escalationDecision = this.shouldEscalate(verification, errorCategories);

				if (escalationDecision.shouldEscalate) {
					const previousModel = this.currentModel;
					const escalated = this.escalateModel();
					if (escalated) {
						// Get post-mortem from the failed tier before moving on
						console.log(chalk.dim(`  Getting post-mortem from ${previousModel}...`));
						this.lastPostMortem = await this.getPostMortem(task, verification.feedback, previousModel);

						// Update last attempt record with escalation info
						const lastAttempt = this.attemptRecords[this.attemptRecords.length - 1];
						lastAttempt.escalatedFrom = previousModel as "haiku" | "sonnet";
						lastAttempt.postMortemGenerated = true;

						// Reset same-model retry counter
						this.sameModelRetries = 0;
					} else {
						// Already at max, one more try
						console.log(chalk.yellow("  At max model tier, final attempt..."));
					}
				} else {
					// Retrying at same tier - just use feedback, no post-mortem
					console.log(chalk.dim(`  Retrying at ${this.currentModel} (${escalationDecision.reason})`));
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.log(chalk.red(`  Error: ${errorMessage.substring(0, 100)}`));

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
		this.metricsTracker.completeQuest(false);
		this.cleanupDirtyState();

		return {
			task,
			status: "failed",
			model: this.currentModel,
			attempts: this.attempts,
			error: "Max attempts reached without passing verification",
			durationMs: Date.now() - startTime,
			tokenUsage: {
				attempts: tokenUsageThisAttempt,
				total: tokenUsageThisAttempt.reduce((sum, usage) => sum + usage.totalTokens, 0),
			},
		};
	}

	/**
	 * Clean up any uncommitted changes after a failed task
	 * This prevents dirty state from affecting subsequent tasks
	 */
	private cleanupDirtyState(): void {
		try {
			// Reset any staged and unstaged changes
			execSync("git checkout -- . 2>/dev/null || true", { encoding: "utf-8", cwd: process.cwd() });
			// Remove any untracked files created during the attempt
			execSync("git clean -fd 2>/dev/null || true", { encoding: "utf-8", cwd: process.cwd() });
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

		console.log(chalk.bold(`\nSolo Mode: Processing ${tasks.length} task(s)`));
		console.log(chalk.dim("─".repeat(60)));

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			console.log(chalk.cyan(`\n[${i + 1}/${tasks.length}]`));

			const result = await this.runTask(task);
			results.push(result);

			if (result.status === "complete") {
				console.log(chalk.green(`  ✓ Complete in ${Math.round(result.durationMs / 1000)}s`));
				if (result.commitSha) {
					console.log(chalk.dim(`    Commit: ${result.commitSha.substring(0, 8)}`));
				}
			} else {
				console.log(chalk.red(`  ✗ Failed after ${result.attempts} attempts`));
				if (result.error) {
					console.log(chalk.dim(`    ${result.error.substring(0, 80)}`));
				}
			}
		}

		// Summary
		const completed = results.filter((r) => r.status === "complete").length;
		const failed = results.filter((r) => r.status === "failed").length;

		console.log(chalk.bold("\n━━━ Summary ━━━"));
		console.log(`  ${chalk.green("✓")} Completed: ${completed}`);
		console.log(`  ${chalk.red("✗")} Failed: ${failed}`);

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
	 * Always does at least escalating review - even trivial changes can have bugs.
	 * Annealing (multi-angle advisory review) is added for complex/critical tasks.
	 */
	private determineReviewLevel(assessment: ComplexityAssessment): { review: boolean; annealing: boolean } {
		// If user explicitly set review options, respect them
		if (this.reviewPasses || this.annealingAtOpus) {
			return { review: this.reviewPasses, annealing: this.annealingAtOpus };
		}

		// Always review - even trivial changes can have bugs
		// Only question is whether to add annealing for complex/critical tasks
		switch (assessment.level) {
			case "trivial":
			case "simple":
			case "standard":
				// Escalating review only
				return { review: true, annealing: false };
			case "complex":
			case "critical":
				// Complex/critical tasks get full annealing review
				return { review: true, annealing: true };
			default:
				return { review: true, annealing: false };
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

		const prompt = `${contextSection}Complete this task:

${task}${retryContext}${postMortemContext}

Guidelines:
- Start with the target files listed in the briefing above (if provided)
- Make the minimal changes needed to complete the task
- Follow existing code patterns and conventions
- Ensure your changes compile and don't break existing functionality
- Run typecheck before finishing to verify your changes
- If you encounter issues you cannot resolve, explain what's blocking you

When done, provide a brief summary of what you changed.`;

		// Token usage will be accumulated in this.tokenUsageThisTask

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[this.currentModel],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
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

			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
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
	 * Verify the work was done correctly using local tools
	 *
	 * Uses the full suite of local verification:
	 * - Git diff (what changed)
	 * - TypeScript typecheck (type safety)
	 * - Biome lint (code quality)
	 * - Tests (correctness)
	 * - CodeScene (code health) - optional
	 * - Spell check - optional
	 *
	 * Returns detailed feedback the agent can act on.
	 */
	private async verifyWork(): Promise<VerificationResult> {
		const issues: string[] = [];
		const feedbackParts: string[] = [];
		let typecheckPassed = true;
		let testsPassed = true;
		let lintPassed = true;
		let spellPassed = true;
		try {
			// Only run spell check on typescript and markdown files
			execSync("pnpm spell 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 30000 });
			feedbackParts.push("✓ Spell check passed");
		} catch (error) {
			spellPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const spellingErrors = output.split("\n").filter((line) => line.includes("spelling error"));
			const errorCount = spellingErrors.length;
			issues.push(`Spelling issues (${errorCount})`);
			const relevantErrors = spellingErrors.slice(0, 3).join("\n");
			feedbackParts.push(`✗ SPELLING ISSUES - ${errorCount} found:\n${relevantErrors}`);
		}
		let codeHealthPassed = true;
		let filesChanged = 0;
		let linesChanged = 0;

		// 1. Check what changed
		let changedFiles: string[] = [];
		try {
			const diffStat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});

			// Parse diff stat for file count
			const filesMatch = diffStat.match(/(\d+) files? changed/);
			if (filesMatch) {
				filesChanged = parseInt(filesMatch[1], 10);
			}

			// Parse for lines changed
			const insertions = diffStat.match(/(\d+) insertions?/);
			const deletions = diffStat.match(/(\d+) deletions?/);
			linesChanged = (insertions ? parseInt(insertions[1], 10) : 0) + (deletions ? parseInt(deletions[1], 10) : 0);

			// Get list of changed files
			const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});
			changedFiles = diffNames.trim().split("\n").filter(Boolean);
		} catch {
			issues.push("No changes detected");
			feedbackParts.push("ERROR: No file changes were made. The task may not have been completed.");
		}

		// 2. Run typecheck (critical - must pass)
		if (this.runTypecheck) {
			try {
				execSync("pnpm typecheck 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
				feedbackParts.push("✓ Typecheck passed");
			} catch (error) {
				typecheckPassed = false;
				const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

				// Parse into structured errors (more compact than raw output)
				const structuredErrors = parseTypeScriptErrors(output);
				issues.push(`Typecheck failed (${structuredErrors.length} errors)`);

				// Format errors with suggestions
				const formattedErrors = formatErrorsForAgent(structuredErrors);
				feedbackParts.push(`✗ TYPECHECK FAILED:\n${formattedErrors}`);

				// Check cache for previous fixes
				const cache = getCache();
				for (const err of structuredErrors.slice(0, 3)) {
					const similarFixes = cache.findSimilarFixes(err.message);
					if (similarFixes.length > 0) {
						feedbackParts.push(`  💡 Similar error was fixed before: ${similarFixes[0].fix.slice(0, 50)}...`);
					}
				}
			}
		}

		// 3. Run lint check (important for code quality)
		try {
			execSync("pnpm lint 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
			feedbackParts.push("✓ Lint passed");
		} catch (error) {
			lintPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Count lint issues
			const issueCount = (output.match(/✖|error|warning/gi) || []).length;
			issues.push(`Lint issues (${issueCount})`);

			// Extract first few issues
			const lines = output
				.split("\n")
				.filter((l) => l.includes("error") || l.includes("warning"))
				.slice(0, 3);
			feedbackParts.push(`⚠ LINT ISSUES:\n${lines.join("\n")}`);
		}

		// 4. Run tests if enabled and tests exist for changed files
		if (this.runTests && changedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
			try {
				// Run tests with short timeout - we just want to know if they pass
				execSync("pnpm test --run 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 120000 });
				feedbackParts.push("✓ Tests passed");
			} catch (error) {
				testsPassed = false;
				const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

				// Extract failed test info
				const failedMatch = output.match(/(\d+) failed/);
				const failedCount = failedMatch ? failedMatch[1] : "some";
				issues.push(`Tests failed (${failedCount})`);

				// Find the FAIL lines
				const failLines = output
					.split("\n")
					.filter((l) => l.includes("FAIL") || l.includes("AssertionError"))
					.slice(0, 3);
				feedbackParts.push(`✗ TESTS FAILED:\n${failLines.join("\n")}`);
			}
		}

		// 5. CodeScene code health (optional, nice to have)
		try {
			// Only check changed files to be fast
			if (changedFiles.length > 0 && changedFiles.length <= 5) {
				const tsFiles = changedFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
				if (tsFiles.length > 0) {
					const result = execSync(`pnpm quality:check 2>&1 || true`, {
						encoding: "utf-8",
						cwd: process.cwd(),
						timeout: 30000,
					});

					// Check for code health issues
					if (result.includes("Code Health:") && result.includes("problematic")) {
						codeHealthPassed = false;
						issues.push("Code health issues detected");
						feedbackParts.push(`⚠ CODE HEALTH: Consider simplifying complex functions`);
					} else {
						feedbackParts.push("✓ Code health OK");
					}
				}
			}
		} catch {
			// CodeScene check is optional, don't fail on errors
		}

		// Build final feedback
		const feedback = feedbackParts.join("\n");

		// Pass if: changes were made AND typecheck passed (lint/tests are warnings)
		const passed = filesChanged > 0 && typecheckPassed;

		return {
			passed,
			typecheckPassed,
			testsPassed,
			lintPassed,
			spellPassed,
			codeHealthPassed,
			filesChanged,
			linesChanged,
			issues,
			feedback,
		};
	}

	/**
	 * Categorize errors from verification for tracking
	 */
	private categorizeErrors(verification: VerificationResult): ErrorCategory[] {
		const categories: ErrorCategory[] = [];

		if (!verification.lintPassed) categories.push("lint");
		if (!verification.spellPassed) categories.push("spell");
		if (!verification.typecheckPassed) categories.push("typecheck");
		if (!verification.testsPassed) categories.push("test");
		if (verification.filesChanged === 0) categories.push("no_changes");

		// Check for build issues (typecheck passed but build failed)
		if (verification.typecheckPassed && verification.issues.some((i) => i.toLowerCase().includes("build"))) {
			categories.push("build");
		}

		return categories.length > 0 ? categories : ["unknown"];
	}

	/**
	 * Run escalating review passes: haiku → sonnet → opus
	 * Each tier reviews until it converges (finds nothing), then escalates.
	 * @param task - The task being reviewed
	 * @param useAnnealing - Whether to use annealing review at opus tier
	 */
	private async runEscalatingReview(
		task: string,
		useAnnealing: boolean = this.annealingAtOpus,
	): Promise<{
		converged: boolean;
		issuesFound: string[];
		reviewPasses: number;
		finalTier: ModelTier;
		annealingInsights?: string[];
	}> {
		const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];
		const allIssuesFound: string[] = [];
		let totalPasses = 0;
		const annealingInsights: string[] = [];

		console.log(chalk.cyan("\n  ━━━ Review Passes ━━━"));

		for (const tier of tiers) {
			// At opus tier, optionally use annealing review (advisory mode)
			if (tier === "opus" && useAnnealing) {
				console.log(chalk.magenta(`  [opus] Annealing review (advisory mode)`));
				const insights = await this.runAnnealingReview(task);
				annealingInsights.push(...insights);

				// Still do a final convergence check with standard review
				const finalReview = await this.runSingleReview(task, "opus");
				totalPasses++;

				if (finalReview.foundIssues) {
					console.log(chalk.yellow(`  [opus] Final check: Found issues`));
					for (const issue of finalReview.issues) {
						console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
						allIssuesFound.push(issue);
					}
					if (finalReview.suggestion) {
						await this.applyReviewFix(task, finalReview);
						const verification = await this.verifyWork();
						if (!verification.passed) {
							return {
								converged: false,
								issuesFound: allIssuesFound,
								reviewPasses: totalPasses,
								finalTier: "opus",
								annealingInsights,
							};
						}
					}
				} else {
					console.log(chalk.green(`  [opus] Final check: Converged ✓`));
				}
				continue;
			}

			// Standard tier review loop
			let tierPasses = 0;
			let tierConverged = false;

			while (tierPasses < this.maxReviewPassesPerTier && !tierConverged) {
				tierPasses++;
				totalPasses++;

				const review = await this.runSingleReview(task, tier);

				if (review.foundIssues) {
					console.log(chalk.yellow(`  [${tier}] Pass ${tierPasses}: Found issues`));
					for (const issue of review.issues) {
						console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
						allIssuesFound.push(issue);
					}

					if (review.suggestion) {
						await this.applyReviewFix(task, review);
						const verification = await this.verifyWork();
						if (!verification.passed) {
							console.log(chalk.red(`  [${tier}] Verification failed after fix`));
							return {
								converged: false,
								issuesFound: allIssuesFound,
								reviewPasses: totalPasses,
								finalTier: tier,
							};
						}
					}
				} else {
					console.log(chalk.green(`  [${tier}] Pass ${tierPasses}: Converged ✓`));
					tierConverged = true;
				}
			}

			if (!tierConverged) {
				console.log(chalk.yellow(`  [${tier}] Max passes reached, escalating...`));
			}
		}

		console.log(chalk.green(`  All review tiers converged (${totalPasses} passes)`));
		return {
			converged: true,
			issuesFound: allIssuesFound,
			reviewPasses: totalPasses,
			finalTier: "opus",
			annealingInsights: annealingInsights.length > 0 ? annealingInsights : undefined,
		};
	}

	/**
	 * Run annealing review - multi-angle advisory review using tarot cards
	 */
	private async runAnnealingReview(task: string): Promise<string[]> {
		const annealing = new AnnealingReview({
			passesPerTemperature: 1,
			coolingRate: 0.4,
		});

		const schedule = annealing.generateSchedule().slice(0, 3);
		const insights: string[] = [];

		let diffOutput = "";
		try {
			diffOutput = execSync("git diff HEAD", {
				encoding: "utf-8",
				cwd: this.workingDirectory,
				maxBuffer: 1024 * 1024,
			});
		} catch {
			diffOutput = "Unable to get diff";
		}

		for (const pass of schedule) {
			const cardName = pass.isMajor
				? (pass.card as { name: string }).name
				: `${(pass.card as { rank: string }).rank} of ${(pass.card as { suit: string }).suit}`;

			console.log(chalk.dim(`    🃏 ${cardName}: ${pass.prompt.slice(0, 50)}...`));

			const annealingPrompt = `You are reviewing code through a specific lens. Be brief.

Task: ${task}
Lens: ${pass.prompt}

Changes:
\`\`\`diff
${diffOutput.slice(0, 6000)}
\`\`\`

Provide ONE key insight (1-2 sentences). If nothing notable, say "Nothing notable."`;

			try {
				let response = "";
				for await (const message of query({
					prompt: annealingPrompt,
					options: {
						maxTurns: 1,
						model: MODEL_NAMES.opus,
						permissionMode: "bypassPermissions",
						allowDangerouslySkipPermissions: true,
					},
				})) {
					if (message.type === "result" && message.subtype === "success") {
						response = message.result;
					}
				}

				if (response && !response.toLowerCase().includes("nothing notable")) {
					insights.push(`${cardName}: ${response.trim()}`);
					console.log(chalk.cyan(`      → ${response.trim().slice(0, 60)}...`));
				}
			} catch (error) {
				this.log("Annealing review card failed", { card: cardName, error: String(error) });
			}
		}

		if (insights.length > 0) {
			console.log(chalk.magenta(`    ${insights.length} insight(s) from annealing review`));
		}

		return insights;
	}

	/**
	 * Run a single review pass with the specified model
	 */
	private async runSingleReview(task: string, model: ModelTier): Promise<ReviewResult> {
		const modelId = MODEL_NAMES[model];

		let diffOutput = "";
		try {
			diffOutput = execSync("git diff HEAD", {
				encoding: "utf-8",
				cwd: this.workingDirectory,
				maxBuffer: 1024 * 1024,
			});
		} catch {
			diffOutput = "Unable to get diff";
		}

		const reviewPrompt = `You are reviewing code changes before commit. Be concise.

Task: ${task}

Changes:
\`\`\`diff
${diffOutput.slice(0, 8000)}
\`\`\`

Look for: bugs, edge cases, security issues, task mismatches.

If issues found:
ISSUES FOUND:
- [list each]
SUGGESTED FIX:
[brief fix]

If good:
NO ISSUES FOUND - Ready to commit.`;

		try {
			let response = "";

			for await (const message of query({
				prompt: reviewPrompt,
				options: {
					maxTurns: 1,
					model: modelId,
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
				},
			})) {
				if (message.type === "result" && message.subtype === "success") {
					response = message.result;
				}
			}

			const foundIssues = !response.includes("NO ISSUES FOUND");
			const issues: string[] = [];
			let suggestion: string | undefined;

			if (foundIssues) {
				const issuesMatch = response.match(/ISSUES FOUND:([\s\S]*?)(?:SUGGESTED FIX:|$)/i);
				if (issuesMatch) {
					const issueLines = issuesMatch[1].split("\n").filter((l) => l.trim().startsWith("-"));
					issues.push(...issueLines.map((l) => l.replace(/^-\s*/, "").trim()));
				}
				const suggestionMatch = response.match(/SUGGESTED FIX:([\s\S]*?)$/i);
				if (suggestionMatch) {
					suggestion = suggestionMatch[1].trim();
				}
			}

			return { model, foundIssues, issues, suggestion, converged: !foundIssues };
		} catch (error) {
			this.log("Review failed", { error: String(error), model });
			return { model, foundIssues: false, issues: [], converged: true };
		}
	}

	/**
	 * Apply a fix suggested by review
	 */
	private async applyReviewFix(_task: string, review: ReviewResult): Promise<void> {
		const fixPrompt = `The code review found these issues:
${review.issues.map((i) => `- ${i}`).join("\n")}

Suggested fix: ${review.suggestion}

Please fix these issues. Make minimal changes.`;

		try {
			for await (const message of query({
				prompt: fixPrompt,
				options: {
					maxTurns: 3,
					model: MODEL_NAMES[this.currentModel],
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
				},
			})) {
				if (this.stream) {
					this.streamMessage(message);
				}
			}
		} catch (error) {
			this.log("Failed to apply review fix", { error: String(error) });
		}
	}

	/**
	 * Decide whether to escalate to a better model
	 *
	 * Strategy:
	 * - Trivial errors (lint/spell only): retry same tier up to 2x
	 * - Serious errors (typecheck/build): escalate after 1 retry
	 * - No changes made: escalate immediately (agent is stuck)
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
			// Trivial errors: allow 2 retries at same tier before escalating
			if (this.sameModelRetries < 2) {
				return { shouldEscalate: false, reason: "trivial error, retry same tier" };
			}
			return { shouldEscalate: true, reason: "trivial errors persist after 2 retries" };
		}

		if (hasSerious) {
			// Serious errors: allow 1 retry at same tier, then escalate
			if (this.sameModelRetries < 2) {
				return { shouldEscalate: false, reason: "serious error, one more retry" };
			}
			return { shouldEscalate: true, reason: "serious errors after retry" };
		}

		// Default: escalate after 2 retries
		if (this.sameModelRetries >= 2) {
			return { shouldEscalate: true, reason: "max retries at tier" };
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
			const newModel = tiers[currentIndex + 1];
			console.log(chalk.yellow(`  Escalating: ${this.currentModel} → ${newModel}`));
			this.currentModel = newModel;
			return true;
		}

		return false;
	}

	/**
	 * Commit the work
	 */
	private async commitWork(task: string): Promise<string> {
		try {
			// Stage all changes
			execSync("git add -A", { cwd: process.cwd() });

			// Create commit message
			const shortTask = task.substring(0, 50) + (task.length > 50 ? "..." : "");
			const commitMessage = shortTask;

			// Commit (skip hooks - we already did verification)
			execSync(`git commit --no-verify -m "${commitMessage.replace(/"/g, '\\"')}"`, {
				cwd: process.cwd(),
			});

			// Get commit SHA
			const sha = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: process.cwd() }).trim();

			this.log("Committed work", { sha, task: shortTask });
			return sha;
		} catch (error) {
			this.log("Commit failed", { error: String(error) });
			throw error;
		}
	}
}

/**
 * Create and run a solo orchestrator
 */
export async function runSolo(tasks: string[], options: SoloOptions = {}): Promise<TaskResult[]> {
	const orchestrator = new SoloOrchestrator(options);
	return orchestrator.runTasks(tasks);
}

/**
 * Supervised Mode - Opus orchestrates cheaper workers
 *
 * Uses Opus for high-level planning and review, but delegates
 * actual implementation to Haiku/Sonnet for efficiency.
 *
 * Flow:
 * 1. Opus analyzes task and creates subtasks
 * 2. Opus assigns each subtask to appropriate model tier
 * 3. Workers execute subtasks
 * 4. Opus reviews output and decides next steps
 * 5. Opus commits when satisfied
 */
export class SupervisedOrchestrator {
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private workerModel: ModelTier;

	constructor(
		options: {
			autoCommit?: boolean;
			stream?: boolean;
			verbose?: boolean;
			/** Default worker model (haiku or sonnet) */
			workerModel?: "haiku" | "sonnet";
		} = {},
	) {
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.workerModel = options.workerModel ?? "sonnet";
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			raidLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Run a task with Opus supervision
	 */
	async runSupervised(goal: string): Promise<TaskResult> {
		const startTime = Date.now();

		console.log(chalk.bold.cyan("\n━━━ Supervised Mode ━━━"));
		console.log(chalk.dim(`Goal: ${goal.substring(0, 80)}${goal.length > 80 ? "..." : ""}`));
		console.log(chalk.dim(`Worker model: ${this.workerModel}`));
		console.log();

		// Phase 1: Opus plans the work
		console.log(chalk.yellow("📋 [Opus] Planning..."));
		const plan = await this.opusPlan(goal);

		if (!plan.subtasks || plan.subtasks.length === 0) {
			// Simple task - just do it directly with Opus
			console.log(chalk.dim("  Simple task, executing directly..."));
			return this.executeDirectly(goal, startTime);
		}

		console.log(chalk.dim(`  Created ${plan.subtasks.length} subtask(s)`));
		for (const subtask of plan.subtasks) {
			console.log(chalk.dim(`    • ${subtask.substring(0, 60)}${subtask.length > 60 ? "..." : ""}`));
		}

		// Phase 2: Workers execute subtasks
		let allPassed = true;
		const workerResults: Array<{ subtask: string; passed: boolean; result: string }> = [];

		for (let i = 0; i < plan.subtasks.length; i++) {
			const subtask = plan.subtasks[i];
			console.log(chalk.cyan(`\n🔧 [${this.workerModel}] Subtask ${i + 1}/${plan.subtasks.length}`));
			console.log(chalk.dim(`  ${subtask.substring(0, 70)}${subtask.length > 70 ? "..." : ""}`));

			const result = await this.workerExecute(subtask, plan.context);
			const verification = await this.verifyWork();

			workerResults.push({
				subtask,
				passed: verification.passed,
				result,
			});

			if (verification.passed) {
				console.log(chalk.green(`  ✓ Passed verification`));
			} else {
				console.log(chalk.yellow(`  ⚠ Issues: ${verification.issues.join(", ")}`));
				allPassed = false;
			}
		}

		// Phase 3: Opus reviews and potentially fixes
		if (!allPassed) {
			console.log(chalk.yellow("\n🔍 [Opus] Reviewing and fixing issues..."));
			await this.opusReview(goal, workerResults);

			// Re-verify
			const finalVerification = await this.verifyWork();
			if (finalVerification.passed) {
				console.log(chalk.green("  ✓ Issues resolved"));
				allPassed = true;
			} else {
				console.log(chalk.red(`  ✗ Still failing: ${finalVerification.issues.join(", ")}`));
			}
		}

		// Commit if successful
		let commitSha: string | undefined;
		if (allPassed && this.autoCommit) {
			try {
				commitSha = await this.commitWork(goal);
				console.log(chalk.green(`\n✓ Committed: ${commitSha.substring(0, 8)}`));
			} catch {
				console.log(chalk.yellow("\n⚠ Nothing to commit"));
			}
		}

		return {
			task: goal,
			status: allPassed ? "complete" : "failed",
			model: "opus", // Supervisor was opus
			attempts: 1,
			commitSha,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Opus plans the work and breaks into subtasks
	 */
	private async opusPlan(goal: string): Promise<{ subtasks: string[]; context: string }> {
		let result = "";

		const prompt = `You are a senior engineer planning implementation. Analyze this goal and decide:

1. If it's simple (single file, straightforward change): respond with just {"simple": true}
2. If complex: break it into 2-5 small, independent subtasks

Goal: ${goal}

For complex tasks, respond with JSON:
{
  "simple": false,
  "subtasks": ["subtask 1 description", "subtask 2 description", ...],
  "context": "any important context the workers need"
}

Keep subtasks focused and independent. Each should be completable in isolation.`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.opus,
				allowedTools: ["Read", "Grep", "Glob"], // Read-only for planning
				settingSources: ["project"],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		try {
			const jsonMatch = result.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (parsed.simple) {
					return { subtasks: [], context: "" };
				}
				return {
					subtasks: parsed.subtasks || [],
					context: parsed.context || "",
				};
			}
		} catch {
			// If parsing fails, treat as simple
		}

		return { subtasks: [], context: "" };
	}

	/**
	 * Worker executes a subtask
	 */
	private async workerExecute(subtask: string, context: string): Promise<string> {
		let result = "";

		const prompt = `Complete this subtask:

${subtask}

${context ? `Context: ${context}` : ""}

Guidelines:
- Make minimal, focused changes
- Follow existing patterns
- Ensure changes compile`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[this.workerModel],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, this.workerModel);
			}

			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		return result;
	}

	/**
	 * Opus reviews worker output and fixes issues
	 */
	private async opusReview(
		goal: string,
		workerResults: Array<{ subtask: string; passed: boolean; result: string }>,
	): Promise<void> {
		const failedTasks = workerResults.filter((r) => !r.passed);

		const prompt = `Review and fix these issues from worker tasks:

Original goal: ${goal}

Failed subtasks:
${failedTasks.map((t, i) => `${i + 1}. ${t.subtask}\n   Result: ${t.result.substring(0, 200)}`).join("\n\n")}

Fix any issues to complete the original goal. Run typecheck to verify.`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.opus,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, "opus");
			}
		}
	}

	/**
	 * Execute simple task directly with Opus
	 */
	private async executeDirectly(goal: string, startTime: number): Promise<TaskResult> {
		for await (const message of query({
			prompt: goal,
			options: {
				model: MODEL_NAMES.opus,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, "opus");
			}
		}

		const verification = await this.verifyWork();
		let commitSha: string | undefined;

		if (verification.passed && this.autoCommit) {
			try {
				commitSha = await this.commitWork(goal);
			} catch {
				// Nothing to commit
			}
		}

		return {
			task: goal,
			status: verification.passed ? "complete" : "failed",
			model: "opus",
			attempts: 1,
			verification,
			commitSha,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Stream messages to console
	 */
	private streamMessage(message: unknown, model: ModelTier): void {
		const msg = message as Record<string, unknown>;
		const prefix = chalk.dim(`[${model}]`);

		if (msg.type === "content_block_start") {
			const contentBlock = msg.content_block as { type?: string; name?: string } | undefined;
			if (contentBlock?.type === "tool_use" && contentBlock.name) {
				dualLogger.writeLine(`${prefix} ${chalk.yellow(contentBlock.name)}`);
			}
		}
	}

	/**
	 * Verify work using comprehensive local tools (same as SoloOrchestrator)
	 */
	private async verifyWork(): Promise<VerificationResult> {
		const issues: string[] = [];
		const feedbackParts: string[] = [];
		let typecheckPassed = true;
		let testsPassed = true;
		let lintPassed = true;
		let spellPassed = true;
		try {
			// Only run spell check on typescript and markdown files
			execSync("pnpm spell 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 30000 });
			feedbackParts.push("✓ Spell check passed");
		} catch (error) {
			spellPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const spellingErrors = output.split("\n").filter((line) => line.includes("spelling error"));
			const errorCount = spellingErrors.length;
			issues.push(`Spelling issues (${errorCount})`);
			const relevantErrors = spellingErrors.slice(0, 3).join("\n");
			feedbackParts.push(`✗ SPELLING ISSUES - ${errorCount} found:\n${relevantErrors}`);
		}
		const codeHealthPassed = true;
		let filesChanged = 0;
		let linesChanged = 0;

		// 1. Check what changed
		let changedFiles: string[] = [];
		try {
			const diffStat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});

			const filesMatch = diffStat.match(/(\d+) files? changed/);
			if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

			const insertions = diffStat.match(/(\d+) insertions?/);
			const deletions = diffStat.match(/(\d+) deletions?/);
			linesChanged = (insertions ? parseInt(insertions[1], 10) : 0) + (deletions ? parseInt(deletions[1], 10) : 0);

			const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});
			changedFiles = diffNames.trim().split("\n").filter(Boolean);
		} catch {
			issues.push("No changes detected");
			feedbackParts.push("ERROR: No file changes were made.");
		}

		// 2. Run typecheck (critical)
		try {
			execSync("pnpm typecheck 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
			feedbackParts.push("✓ Typecheck passed");
		} catch (error) {
			typecheckPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const errorLines = output.split("\n").filter((line) => line.includes("error TS"));
			const errorCount = errorLines.length;
			issues.push(`Typecheck failed (${errorCount} errors)`);
			const relevantErrors = errorLines.slice(0, 5).join("\n");
			feedbackParts.push(`✗ TYPECHECK FAILED - ${errorCount} type errors:\n${relevantErrors}`);
		}

		// 3. Run lint check
		try {
			execSync("pnpm lint 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
			feedbackParts.push("✓ Lint passed");
		} catch (error) {
			lintPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const issueCount = (output.match(/✖|error|warning/gi) || []).length;
			issues.push(`Lint issues (${issueCount})`);
			const lines = output
				.split("\n")
				.filter((l) => l.includes("error") || l.includes("warning"))
				.slice(0, 3);
			feedbackParts.push(`⚠ LINT ISSUES:\n${lines.join("\n")}`);
		}

		// 4. Run tests if changed files exist
		if (changedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
			try {
				execSync("pnpm test --run 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 120000 });
				feedbackParts.push("✓ Tests passed");
			} catch (error) {
				testsPassed = false;
				const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
				const failedMatch = output.match(/(\d+) failed/);
				const failedCount = failedMatch ? failedMatch[1] : "some";
				issues.push(`Tests failed (${failedCount})`);
				const failLines = output
					.split("\n")
					.filter((l) => l.includes("FAIL") || l.includes("AssertionError"))
					.slice(0, 3);
				feedbackParts.push(`✗ TESTS FAILED:\n${failLines.join("\n")}`);
			}
		}

		const feedback = feedbackParts.join("\n");
		const passed = filesChanged > 0 && typecheckPassed;

		return {
			passed,
			typecheckPassed,
			testsPassed,
			lintPassed,
			spellPassed,
			codeHealthPassed,
			filesChanged,
			linesChanged,
			issues,
			feedback,
		};
	}

	/**
	 * Commit work (skip hooks - we already did verification)
	 */
	private async commitWork(goal: string): Promise<string> {
		execSync("git add -A");
		const shortGoal = goal.substring(0, 50) + (goal.length > 50 ? "..." : "");
		execSync(`git commit --no-verify -m "${shortGoal.replace(/"/g, '\\"')}"`);
		return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
	}
}

/**
 * Run in supervised mode (Opus orchestrating workers)
 */
export async function runSupervised(
	goal: string,
	options: { autoCommit?: boolean; stream?: boolean; verbose?: boolean; workerModel?: "haiku" | "sonnet" } = {},
): Promise<TaskResult> {
	const orchestrator = new SupervisedOrchestrator(options);
	return orchestrator.runSupervised(goal);
}
