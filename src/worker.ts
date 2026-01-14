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
import {
	adjustModelFromMetrics,
	assessComplexityFast,
	assessComplexityQuantitative,
	type ComplexityAssessment,
} from "./complexity.js";
import { type ContextBriefing, prepareContext } from "./context.js";
import { captureDecision, parseAgentOutputForDecisions, updateDecisionOutcome } from "./decision-tracker.js";
import { dualLogger } from "./dual-logger.js";
import { generateToolsPrompt } from "./efficiency-tools.js";
import {
	clearPendingError,
	formatFixSuggestionsForPrompt,
	recordPendingError,
	recordSuccessfulFix,
} from "./error-fix-patterns.js";
import { createAndCheckout } from "./git.js";
import { logFastPathComplete, logFastPathFailed } from "./grind-events.js";
import { findRelevantLearnings, formatLearningsForPrompt, markLearningsUsed } from "./knowledge.js";
import { extractAndStoreLearnings } from "./knowledge-extractor.js";
import { recordQueryResult } from "./live-metrics.js";
import { sessionLogger } from "./logger.js";
import { getMetaTaskPrompt, parseMetaTaskResult } from "./meta-tasks.js";
import { MetricsTracker } from "./metrics.js";
import * as output from "./output.js";
import { readTaskAssignment, updateTaskCheckpoint } from "./persistence.js";
import { type ModelTier, runEscalatingReview, type UnresolvedTicket } from "./review.js";
import type { HandoffContext } from "./task.js";
import { formatCoModificationHints, formatFileSuggestionsForPrompt, recordTaskFiles } from "./task-file-patterns.js";
import { extractMetaTaskType, isMetaTask, isResearchTask, parseResearchResult } from "./task-schema.js";
import type { AttemptRecord, ErrorCategory, TaskCheckpoint, TokenUsage } from "./types.js";
import { categorizeErrors, type VerificationResult, verifyWork } from "./verification.js";

/**
 * Get a few-shot example for common task patterns to help the agent succeed.
 * Returns undefined for tasks that don't match known patterns.
 */
function getFewShotExample(task: string): string | undefined {
	const taskLower = task.toLowerCase();

	// Typo/comment tasks
	if (taskLower.includes("typo") || taskLower.includes("comment") || taskLower.includes("spelling")) {
		return `Task: "Fix typo in src/utils.ts"
Action: Read the file, find the typo, use Edit tool to fix it
Result: Changed "recieve" to "receive" on line 45`;
	}

	// Add/create function tasks
	if ((taskLower.includes("add") || taskLower.includes("create")) && taskLower.includes("function")) {
		return `Task: "Add validateEmail function to src/utils.ts"
Action: Read file to understand patterns, then Edit to add new function
Result: Added function following existing code style, exported it`;
	}

	// Fix bug tasks
	if (taskLower.includes("fix") && (taskLower.includes("bug") || taskLower.includes("error"))) {
		return `Task: "Fix null error in src/auth.ts:45"
Action: Read file, understand the code path, add null check
Result: Added optional chaining (?.) to prevent null access`;
	}

	// Update/change tasks
	if (taskLower.includes("update") || taskLower.includes("change") || taskLower.includes("modify")) {
		return `Task: "Update timeout value in config.ts to 30000"
Action: Read file, find the timeout setting, Edit to change value
Result: Changed timeout from 10000 to 30000`;
	}

	// Rename tasks
	if (taskLower.includes("rename")) {
		return `Task: "Rename getUserData to fetchUserProfile in src/api.ts"
Action: Read file, use Edit with replace_all to rename all occurrences
Result: Renamed function and all call sites`;
	}

	// Add test tasks
	if (taskLower.includes("test") && (taskLower.includes("add") || taskLower.includes("write"))) {
		return `Task: "Add tests for validateEmail in src/__tests__/utils.test.ts"
Action: Read the function to understand behavior, then write test cases
Result: Added 3 test cases: valid email, invalid email, empty string`;
	}

	return undefined;
}

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
	/** Result from meta-task (triage, prune, etc.) - orchestrator processes these */
	metaTaskResult?: import("./types.js").MetaTaskResult;
	/** Result from research task - findings, sources, next steps */
	researchResult?: import("./task-schema.js").ResearchResultSchemaType;
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
	/**
	 * Maximum fix attempts at opus tier (final tier has no escalation path).
	 * Opus is expensive but capable - give it more chances to succeed.
	 * Default: 7
	 */
	maxOpusRetries?: number;
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
	private maxOpusRetries: number;

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

	/** Track write operations during current execution (for Stop hook) */
	private writeCountThisExecution: number = 0;

	/** Track if current task is a meta-task (doesn't require file changes) */
	private isCurrentTaskMeta: boolean = false;

	/** Track if current task is a research task (doesn't require file changes) */
	private isCurrentTaskResearch: boolean = false;

	/** Handoff context from calling Claude Code session */
	private currentHandoffContext?: HandoffContext;

	/** Current agent session ID for resume on retry (preserves agent's exploration work) */
	private currentAgentSessionId?: string;

	/** Turn count from last agent execution (for performance analysis) */
	private lastAgentTurns: number = 0;

	/** Learning IDs injected into current task prompt (for tracking success) */
	private injectedLearningIds: string[] = [];

	/** Last agent output for knowledge extraction */
	private lastAgentOutput: string = "";

	/** Pending error signature (for tracking successful fixes) */
	private pendingErrorSignature: string | null = null;

	/** Files modified before current attempt (for tracking what fixed the error) */
	private filesBeforeAttempt: string[] = [];

	/** State directory for decision tracking and other operational learning */
	private stateDir: string = ".undercity";

	constructor(options: SoloOptions = {}) {
		// Default 7 attempts allows full escalation: 2 haiku + 2 sonnet + 3 opus
		this.maxAttempts = options.maxAttempts ?? 7;
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
		// 2 retries per tier before escalating (was 3, but that's too slow)
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 2;
		this.maxOpusRetries = options.maxOpusRetries ?? 7;
		this.currentModel = this.startingModel;
		this.metricsTracker = new MetricsTracker();
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			sessionLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Save a checkpoint to the assignment file for crash recovery.
	 * Fails silently if no assignment exists (e.g., running outside orchestrator).
	 */
	private saveCheckpoint(
		phase: TaskCheckpoint["phase"],
		lastVerification?: { passed: boolean; errors?: string[] },
	): void {
		try {
			const checkpoint: TaskCheckpoint = {
				phase,
				model: this.currentModel,
				attempts: this.attempts,
				savedAt: new Date(),
				lastVerification,
			};
			updateTaskCheckpoint(this.workingDirectory, checkpoint);
		} catch {
			// Silent failure - checkpoints are optional
		}
	}

	/**
	 * Build assignment context for agent priming.
	 * Returns context about the agent's identity and task assignment.
	 */
	private buildAssignmentContext(): string {
		const assignment = readTaskAssignment(this.workingDirectory);
		if (!assignment) {
			return "";
		}

		const lines: string[] = [
			"WORKER ASSIGNMENT:",
			`Task ID: ${assignment.taskId}`,
			`Branch: ${assignment.branch}`,
			`Model: ${assignment.model}`,
			`Max Attempts: ${assignment.maxAttempts}`,
		];

		if (assignment.experimentVariantId) {
			lines.push(`Experiment: ${assignment.experimentVariantId}`);
		}

		// Add checkpoint recovery context if resuming
		if (assignment.checkpoint) {
			const cp = assignment.checkpoint;
			lines.push("");
			lines.push("RECOVERY CONTEXT:");
			lines.push(`Last Phase: ${cp.phase}`);
			lines.push(`Attempts So Far: ${cp.attempts}`);
			if (cp.lastVerification) {
				lines.push(`Last Verification: ${cp.lastVerification.passed ? "PASSED" : "FAILED"}`);
				if (cp.lastVerification.errors && cp.lastVerification.errors.length > 0) {
					lines.push("Previous Errors:");
					for (const err of cp.lastVerification.errors) {
						lines.push(`  - ${err}`);
					}
				}
			}
		}

		lines.push("");
		return lines.join("\n");
	}

	/**
	 * Build handoff context section for the prompt
	 * Contains context passed from the calling Claude Code session
	 */
	private buildHandoffContextSection(): string {
		if (!this.currentHandoffContext) {
			return "";
		}

		const ctx = this.currentHandoffContext;
		const lines: string[] = [];
		lines.push("HANDOFF CONTEXT FROM CALLER:");
		lines.push("The session that dispatched this task provided the following context:");
		lines.push("");

		if (ctx.filesRead && ctx.filesRead.length > 0) {
			lines.push("Files already analyzed:");
			for (const file of ctx.filesRead) {
				lines.push(`  - ${file}`);
			}
			lines.push("");
		}

		if (ctx.decisions && ctx.decisions.length > 0) {
			lines.push("Key decisions/constraints established:");
			for (const decision of ctx.decisions) {
				lines.push(`  - ${decision}`);
			}
			lines.push("");
		}

		if (ctx.codeContext) {
			lines.push("Relevant code context:");
			lines.push(ctx.codeContext);
			lines.push("");
		}

		if (ctx.notes) {
			lines.push("Notes from caller:");
			lines.push(ctx.notes);
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Run a single task with verification and potential escalation
	 * @param task The task objective string
	 * @param handoffContext Optional context from calling Claude Code session
	 */
	async runTask(task: string, handoffContext?: HandoffContext): Promise<TaskResult> {
		const startTime = Date.now();
		this.attempts = 0;
		this.attemptRecords = [];
		this.tokenUsageThisTask = [];
		this.sameModelRetries = 0;
		this.pendingTickets = []; // Clear tickets from previous task
		this.currentHandoffContext = handoffContext; // Store for use in prompt building
		this.currentAgentSessionId = undefined; // Reset session ID for new task

		// Checkpoint: starting
		this.saveCheckpoint("starting");

		// Ensure clean state before starting (in case previous task left dirty state)
		this.cleanupDirtyState();

		// Record the base commit SHA before the agent runs
		// This is used by verification to detect if the agent actually made changes
		let baseCommit: string | undefined;
		try {
			baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf-8",
				cwd: this.workingDirectory,
			}).trim();
		} catch {
			// Ignore errors - baseCommit will be undefined
		}

		const taskId = `solo_${Date.now()}`;
		this.currentTaskId = taskId; // Store for use in other methods
		const sessionId = `session_${Date.now()}`;

		// Check if this is a meta-task (operates on task board, not code)
		this.isCurrentTaskMeta = isMetaTask(task);
		const metaType = this.isCurrentTaskMeta ? extractMetaTaskType(task) : null;

		// Check if this is a research task (gathers information, no code changes)
		this.isCurrentTaskResearch = !this.isCurrentTaskMeta && isResearchTask(task);

		if (this.isCurrentTaskMeta) {
			output.taskStart(taskId, `[meta:${metaType}] ${task.substring(task.indexOf("]") + 1, 60).trim()}...`);
		} else if (this.isCurrentTaskResearch) {
			output.taskStart(taskId, `[research] ${task.substring(0, 50)}...`);
		} else {
			output.taskStart(taskId, task.substring(0, 60) + (task.length > 60 ? "..." : ""));
		}

		// Fast-path: Try ast-grep for trivial mechanical tasks (rename, replace)
		// This bypasses the LLM entirely for ~100x speedup on qualifying tasks
		if (!this.isCurrentTaskMeta && !this.isCurrentTaskResearch) {
			const { tryFastPath } = await import("./fast-path.js");
			const fastResult = tryFastPath(task, this.workingDirectory);

			if (fastResult.handled) {
				if (fastResult.success) {
					output.success(`Fast-path completed: ${fastResult.filesChanged?.join(", ")}`, { taskId });

					// Verify the fast-path changes
					const verification = await verifyWork(this.runTypecheck, this.runTests, this.workingDirectory, baseCommit);
					if (verification.passed) {
						// Commit the changes
						if (this.autoCommit && fastResult.filesChanged?.length) {
							try {
								for (const file of fastResult.filesChanged) {
									execSync(`git add "${file}"`, { cwd: this.workingDirectory, stdio: "pipe" });
								}
								execSync(`git commit -m "${task.substring(0, 50)}"`, { cwd: this.workingDirectory, stdio: "pipe" });
								output.success("Fast-path changes committed", { taskId });
							} catch (e) {
								output.warning("Fast-path commit failed, changes staged", { taskId, error: String(e) });
							}
						}

						const durationMs = Date.now() - startTime;
						output.info(`Fast-path completed in ${durationMs}ms (vs ~60s with LLM)`, { taskId, durationMs });

						// Log fast-path success for metrics tracking
						logFastPathComplete({
							batchId: sessionId,
							taskId,
							objective: task,
							durationMs,
							modifiedFiles: fastResult.filesChanged,
							tool: "ast-grep",
						});

						return {
							status: "complete",
							task,
							model: "haiku" as ModelTier, // fast-path is cheaper than haiku
							attempts: 0,
							durationMs,
							tokenUsage: { attempts: [], total: 0 },
						};
					} else {
						output.warning("Fast-path changes failed verification, falling back to LLM", { taskId });
						// Log fast-path failure due to verification
						logFastPathFailed({
							batchId: sessionId,
							taskId,
							objective: task,
							error: "Verification failed after fast-path changes",
							tool: "ast-grep",
						});
						// Revert changes and fall through to LLM
						execSync("git checkout -- .", { cwd: this.workingDirectory, stdio: "pipe" });
					}
				} else {
					output.debug(`Fast-path attempted but failed: ${fastResult.error}`, { taskId });
					// Log fast-path failure
					logFastPathFailed({
						batchId: sessionId,
						taskId,
						objective: task,
						error: fastResult.error || "Unknown error",
						tool: "ast-grep",
					});
					// Fall through to LLM
				}
			}
		}

		// Pre-flight: Prepare context briefing (FREE - no LLM tokens)
		// Do this FIRST so we can use target files for quantitative complexity assessment
		output.workerPhase(taskId, "analyzing");
		const phaseTimings: Record<string, number> = {};
		const phaseStart = Date.now();
		let targetFiles: string[] = [];
		try {
			// CRITICAL: Must pass workingDirectory so context is prepared from worktree, not main repo
			this.currentBriefing = await prepareContext(task, { cwd: this.workingDirectory });
			targetFiles = this.currentBriefing.targetFiles;
			const sigCount = this.currentBriefing.functionSignatures.length;
			output.debug(`Found ${targetFiles.length} target files, ${sigCount} signatures`, { taskId });
		} catch (error) {
			this.log("Context preparation failed", { error: String(error) });
			// Continue without briefing - agent will explore
		}
		phaseTimings.contextPrep = Date.now() - phaseStart;

		// Checkpoint: context gathered
		this.saveCheckpoint("context");

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

		// Adjust model based on historical success rates (unless model explicitly set)
		if (this.startingModel === "sonnet") {
			// "sonnet" is the default - user didn't override
			const adjustedModel = await adjustModelFromMetrics(this.currentModel, assessment.level);
			if (adjustedModel !== this.currentModel) {
				output.debug(`Metrics adjustment: ${this.currentModel} → ${adjustedModel}`, {
					taskId,
					originalModel: this.currentModel,
					adjustedModel,
					complexity: assessment.level,
				});
				this.currentModel = adjustedModel;
			}
		}

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
				// Checkpoint: executing
				this.saveCheckpoint("executing");

				// Run the agent
				output.workerPhase(taskId, "executing", { model: this.currentModel });
				const agentStart = Date.now();
				const agentOutput = await this.executeAgent(task);
				phaseTimings.agentExecution = Date.now() - agentStart;

				// Meta-tasks: parse recommendations, skip code verification
				if (this.isCurrentTaskMeta && metaType) {
					output.workerPhase(taskId, "parsing");
					const metaResult = parseMetaTaskResult(agentOutput, metaType);

					if (metaResult) {
						output.workerVerification(taskId, true);
						output.info(`Meta-task produced ${metaResult.recommendations.length} recommendations`, { taskId });

						this.attemptRecords.push({
							model: this.currentModel,
							durationMs: Date.now() - attemptStart,
							success: true,
						});

						this.metricsTracker.recordAttempts(this.attemptRecords);
						this.metricsTracker.completeTask(true);

						return {
							task,
							status: "complete",
							model: this.currentModel,
							attempts: this.attempts,
							durationMs: Date.now() - startTime,
							tokenUsage: {
								attempts: this.tokenUsageThisTask,
								total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
							},
							metaTaskResult: metaResult,
						};
					}

					// Failed to parse - retry
					output.warning("Failed to parse meta-task result, retrying...", { taskId });
					this.lastFeedback =
						"Your response could not be parsed as valid recommendations. Please return a JSON object with a 'recommendations' array.";
					continue;
				}

				// Research tasks: skip code verification, just check that file was written
				if (this.isCurrentTaskResearch) {
					// Check if the research file was created
					const hasWrittenFile = this.writeCountThisExecution > 0;

					if (hasWrittenFile) {
						output.workerVerification(taskId, true);
						output.info("Research findings written to .undercity/research/", { taskId });

						this.attemptRecords.push({
							model: this.currentModel,
							durationMs: Date.now() - attemptStart,
							success: true,
						});

						// Commit the research file
						let commitSha: string | undefined;
						if (this.autoCommit) {
							output.workerPhase(taskId, "committing");
							commitSha = await this.commitWork(task);
						}

						this.metricsTracker.recordAttempts(this.attemptRecords);
						this.metricsTracker.completeTask(true);

						// Parse output for structured result if available
						const researchResult = parseResearchResult(agentOutput) ?? undefined;

						return {
							task,
							status: "complete",
							model: this.currentModel,
							attempts: this.attempts,
							durationMs: Date.now() - startTime,
							commitSha,
							tokenUsage: {
								attempts: this.tokenUsageThisTask,
								total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
							},
							researchResult,
						};
					}

					// No file written - retry
					output.warning("Research task did not write findings file, retrying...", { taskId });
					this.lastFeedback =
						"You must write your research findings to the specified markdown file. Please create the file with your findings.";
					continue;
				}

				// Standard implementation tasks: verify code changes
				// Checkpoint: verifying
				this.saveCheckpoint("verifying");

				output.workerPhase(taskId, "verifying");
				const verifyStart = Date.now();
				const verification = await verifyWork(this.runTypecheck, this.runTests, this.workingDirectory, baseCommit);
				phaseTimings.verification = Date.now() - verifyStart;

				// Categorize errors for tracking
				const errorCategories = categorizeErrors(verification);

				if (verification.passed) {
					output.workerVerification(taskId, true);

					// Record successful fix if we had a pending error
					if (this.pendingErrorSignature) {
						try {
							// Get list of files changed in this attempt
							const currentFiles = this.getModifiedFiles();
							const newFiles = currentFiles.filter((f) => !this.filesBeforeAttempt.includes(f));
							const changedFiles = newFiles.length > 0 ? newFiles : currentFiles;

							recordSuccessfulFix(
								this.currentTaskId,
								changedFiles,
								`Fixed ${errorCategories.join(", ") || "verification"} error`,
							);
							output.debug(`Recorded fix for error pattern`, { taskId, files: changedFiles.length });
						} catch {
							// Non-critical
						}
						this.pendingErrorSignature = null;
					}

					// Warnings are logged but don't block success
					// Cost-benefit: An extra agent call + verification for minor issues isn't worth it
					// The warnings are in verification.feedback if someone wants to see them
					let finalVerification = verification;
					if (verification.hasWarnings) {
						output.debug("Verification passed with warnings (skipping retry)", {
							taskId,
							warnings: verification.feedback.slice(0, 200),
						});
					}

					// Run review passes if enabled (auto-selected or user-specified)
					if (reviewLevel.review) {
						// Checkpoint: reviewing (with verification status)
						this.saveCheckpoint("reviewing", { passed: true });

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
							finalVerification = await verifyWork(this.runTypecheck, this.runTests, this.workingDirectory, baseCommit);
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
						// Checkpoint: committing
						this.saveCheckpoint("committing", { passed: true });

						output.workerPhase(taskId, "committing");
						commitSha = await this.commitWork(task);
					}

					// Pass attempt records to metrics tracker before completing
					this.metricsTracker.recordAttempts(this.attemptRecords);

					// Complete task tracking
					this.metricsTracker.completeTask(true);

					// Log phase timings for performance analysis
					const totalMs = Date.now() - startTime;
					const msPerTurn = this.lastAgentTurns > 0 ? Math.round(phaseTimings.agentExecution / this.lastAgentTurns) : 0;
					output.info(
						`Phase timings: context=${phaseTimings.contextPrep}ms, agent=${phaseTimings.agentExecution}ms (${this.lastAgentTurns} turns, ${msPerTurn}ms/turn), verify=${phaseTimings.verification}ms, total=${totalMs}ms`,
						{ taskId, phaseTimings, totalMs, turns: this.lastAgentTurns, msPerTurn },
					);

					// Knowledge compounding: extract learnings from successful task
					// Use process.cwd() (main repo) for knowledge storage, not worktree
					try {
						const extracted = extractAndStoreLearnings(taskId, this.lastAgentOutput);
						if (extracted.length > 0) {
							output.debug(`Extracted ${extracted.length} learnings from task`, { taskId });
						}
						// Mark injected learnings as successfully used
						if (this.injectedLearningIds.length > 0) {
							markLearningsUsed(this.injectedLearningIds, true);
							output.debug(`Marked ${this.injectedLearningIds.length} learnings as used (success)`, { taskId });
						}
					} catch (error) {
						// Knowledge extraction is non-critical - don't fail task
						sessionLogger.debug({ error: String(error) }, "Knowledge extraction failed");
					}

					// Record task-file patterns for future suggestions
					// Use getFilesFromLastCommit since we already committed
					try {
						const modifiedFiles = this.getFilesFromLastCommit();
						if (modifiedFiles.length > 0) {
							recordTaskFiles(taskId, task, modifiedFiles, true);
							output.debug(`Recorded task-file pattern: ${modifiedFiles.length} files`, { taskId });
						}
					} catch {
						// Non-critical
					}

					// Update decision outcomes for this task (success)
					try {
						const { loadDecisionStore } = await import("./decision-tracker.js");
						const store = loadDecisionStore(this.stateDir);
						const taskDecisions = store.resolved.filter(
							(d) => d.taskId === taskId && d.resolution.outcome === undefined,
						);
						for (const decision of taskDecisions) {
							updateDecisionOutcome(decision.id, "success", this.stateDir);
						}
						if (taskDecisions.length > 0) {
							output.debug(`Updated ${taskDecisions.length} decision outcomes to success`, { taskId });
						}
					} catch {
						// Non-critical
					}

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

				// Record error pattern for learning
				const primaryCategory = errorCategories[0] || "unknown";
				const errorMessage = verification.issues[0] || verification.feedback.slice(0, 200);
				try {
					this.pendingErrorSignature = recordPendingError(
						this.currentTaskId,
						primaryCategory,
						errorMessage,
						this.getModifiedFiles(),
					);
					this.filesBeforeAttempt = this.getModifiedFiles();
				} catch {
					// Non-critical
				}

				// Check for fix suggestions from previous similar errors
				let fixSuggestion = "";
				try {
					fixSuggestion = formatFixSuggestionsForPrompt(primaryCategory, errorMessage);
					if (fixSuggestion) {
						output.debug("Found fix suggestions from previous errors", { taskId });
					}
				} catch {
					// Non-critical
				}

				// Check for co-modification hints (files that usually change together)
				let coModHints = "";
				try {
					const modifiedFiles = this.getModifiedFiles();
					if (modifiedFiles.length > 0) {
						coModHints = formatCoModificationHints(modifiedFiles);
						if (coModHints) {
							output.debug("Found co-modification hints", { taskId, fileCount: modifiedFiles.length });
						}
					}
				} catch {
					// Non-critical
				}

				// Combine feedback with fix suggestions and co-modification hints
				let enhancedFeedback = verification.feedback;
				if (fixSuggestion) {
					enhancedFeedback += `\n\n${fixSuggestion}`;
				}
				if (coModHints) {
					enhancedFeedback += `\n\n${coModHints}`;
				}
				this.lastFeedback = enhancedFeedback;

				// Checkpoint: verification failed with errors
				this.saveCheckpoint("verifying", {
					passed: false,
					errors: verification.issues.slice(0, 5), // Keep first 5 errors
				});

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

		// Mark injected learnings as used (with failure)
		// This decreases confidence in learnings that didn't help
		if (this.injectedLearningIds.length > 0) {
			try {
				markLearningsUsed(this.injectedLearningIds, false);
			} catch {
				// Non-critical
			}
		}

		// Clear any pending error (we failed to fix it)
		if (this.pendingErrorSignature) {
			try {
				clearPendingError(this.currentTaskId);
			} catch {
				// Non-critical
			}
			this.pendingErrorSignature = null;
		}

		// Record failed task pattern (helps track which keywords are risky)
		try {
			const modifiedFiles = this.getModifiedFiles();
			recordTaskFiles(taskId, task, modifiedFiles, false);
			output.debug(`Recorded failed task pattern`, { taskId });
		} catch {
			// Non-critical
		}

		// Update decision outcomes for this task (failure)
		try {
			const { loadDecisionStore } = await import("./decision-tracker.js");
			const store = loadDecisionStore(this.stateDir);
			const taskDecisions = store.resolved.filter((d) => d.taskId === taskId && d.resolution.outcome === undefined);
			for (const decision of taskDecisions) {
				updateDecisionOutcome(decision.id, "failure", this.stateDir);
			}
		} catch {
			// Non-critical
		}

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
		// Note: Complex tasks now start on sonnet, so review should match
		switch (assessment.level) {
			case "trivial":
			case "simple":
			case "standard":
			case "complex":
				// Simple and complex tasks get capped review: haiku → sonnet only
				// Complex tasks execution was demoted from opus to sonnet, review follows
				return { review: true, annealing: false, maxReviewTier: "sonnet" };
			case "critical":
				// Only critical tasks get opus review + annealing
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
	 *
	 * Uses session resume on retry to preserve agent's exploration work.
	 * Instead of starting fresh, we continue the conversation with feedback.
	 */
	private async executeAgent(task: string): Promise<string> {
		let result = "";

		// Meta-tasks use specialized prompts and don't require file changes
		const metaType = this.isCurrentTaskMeta ? extractMetaTaskType(task) : null;

		// Check if this is a retry with an existing session to resume
		const isRetry = this.attempts > 1 && this.lastFeedback;
		const canResume = isRetry && this.currentAgentSessionId && !this.lastPostMortem;
		// Note: Don't resume if we have a post-mortem (model escalation = new session needed)

		let prompt: string;
		let resumePrompt: string | undefined;

		if (canResume) {
			// Build a continuation prompt with verification feedback
			// The agent keeps its full context from the previous attempt
			resumePrompt = `VERIFICATION FAILED. Here's what needs to be fixed:

${this.lastFeedback}

Please fix these specific issues. You have all the context from your previous work - focus on addressing these errors.`;
			prompt = ""; // Not used when resuming
			sessionLogger.info(
				{ sessionId: this.currentAgentSessionId, attempt: this.attempts },
				"Resuming agent session with verification feedback",
			);
		} else if (this.isCurrentTaskMeta && metaType) {
			// Meta-task: use the meta-task template
			const metaPrompt = getMetaTaskPrompt(metaType);
			const objectiveWithoutPrefix = task.replace(/^\[(?:meta:\w+|plan)\]\s*/i, "");

			let retryContext = "";
			if (this.attempts > 1 && this.lastFeedback) {
				retryContext = `

PREVIOUS ATTEMPT FAILED:
${this.lastFeedback}

Please fix these issues and return valid JSON.`;
			}

			prompt = `${metaPrompt}

OBJECTIVE: ${objectiveWithoutPrefix}${retryContext}

Working directory: ${this.workingDirectory}
Read the task board from .undercity/tasks.json to analyze.
Return your analysis as JSON in the format specified above.`;
		} else if (this.isCurrentTaskResearch) {
			// Research task: gather information, write findings to markdown file
			const objectiveWithoutPrefix = task.replace(/^\[research\]\s*/i, "");

			// Generate a filename from the objective
			const slug = objectiveWithoutPrefix
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 50);
			const timestamp = new Date().toISOString().split("T")[0];
			const outputPath = `.undercity/research/${timestamp}-${slug}.md`;

			let retryContext = "";
			if (this.attempts > 1 && this.lastFeedback) {
				retryContext = `

PREVIOUS ATTEMPT FEEDBACK:
${this.lastFeedback}

Please provide more detailed findings and ensure the markdown file is written.`;
			}

			prompt = `You are a research assistant. Your task is to gather information and document findings.

RESEARCH OBJECTIVE:
${objectiveWithoutPrefix}${retryContext}

INSTRUCTIONS:
1. Use web search, documentation, and any available resources to research this topic
2. Focus on gathering accurate, relevant information
3. Cite sources when possible
4. Provide actionable insights

OUTPUT:
Write your findings to: ${outputPath}

Use this markdown structure:
\`\`\`markdown
# Research: ${objectiveWithoutPrefix}

## Summary
Brief summary of key findings.

## Findings
- **Finding 1**: Description (Source: URL)
- **Finding 2**: Description (Source: URL)

## Recommendations
- Actionable next steps based on research

## Sources
- [Source Name](URL)
\`\`\`

The file MUST be created at ${outputPath} for this task to succeed.`;
		} else {
			// Standard implementation task: build prompt with context
			let contextSection = "";

			// Add assignment context for worker identity and recovery
			const assignmentContext = this.buildAssignmentContext();
			if (assignmentContext) {
				contextSection += `${assignmentContext}\n---\n\n`;
			}

			// Add handoff context from calling Claude Code session
			if (this.currentHandoffContext) {
				contextSection += this.buildHandoffContextSection();
				contextSection += "\n---\n\n";
			}

			if (this.currentBriefing?.briefingDoc) {
				contextSection += `${this.currentBriefing.briefingDoc}

---

`;
			}

			// Add efficiency tools section if any tools are available
			const toolsPrompt = generateToolsPrompt();
			if (toolsPrompt) {
				contextSection += `${toolsPrompt}

---

`;
			}

			// Add relevant learnings from previous tasks
			// Use process.cwd() (main repo) for knowledge, not worktree
			const relevantLearnings = findRelevantLearnings(task, 5);
			if (relevantLearnings.length > 0) {
				const learningsPrompt = formatLearningsForPrompt(relevantLearnings);
				contextSection += `${learningsPrompt}

---

`;
				// Track which learnings we're injecting (we'll mark them used after task completes)
				this.injectedLearningIds = relevantLearnings.map((l) => l.id);
			} else {
				this.injectedLearningIds = [];
			}

			// Add file suggestions based on task-file patterns
			const fileSuggestions = formatFileSuggestionsForPrompt(task);
			if (fileSuggestions) {
				contextSection += `${fileSuggestions}

---

`;
			}

			// Add co-modification hints based on target files from context
			if (this.currentBriefing?.targetFiles && this.currentBriefing.targetFiles.length > 0) {
				const coModHints = formatCoModificationHints(this.currentBriefing.targetFiles);
				if (coModHints) {
					contextSection += `${coModHints}

---

`;
				}
			}

			// For first attempt after escalation, include post-mortem
			let postMortemContext = "";
			if (this.lastPostMortem) {
				postMortemContext = `

POST-MORTEM FROM PREVIOUS TIER:
${this.lastPostMortem}

Use this analysis to avoid repeating the same mistakes.`;
				// Clear after use - only applies to first attempt at new tier
				this.lastPostMortem = undefined;
			}

			// Get few-shot example if applicable for this task type
			const fewShotExample = getFewShotExample(task);
			const exampleSection = fewShotExample ? `\nEXAMPLE OF SIMILAR TASK:\n${fewShotExample}\n` : "";

			prompt = `${contextSection}TASK:
${task}${postMortemContext}${exampleSection}
RULES:
1. If the task requires creating new files, create them (Write tool creates parent directories)
2. If editing existing files, read them first before editing
3. Minimal changes only - nothing beyond task scope
4. No questions - decide and proceed`;
		}

		// Token usage will be accumulated in this.tokenUsageThisTask

		// Reset write counter for this execution
		this.writeCountThisExecution = 0;

		// Build hooks - meta-tasks don't need the "must write files" check
		// Research tasks now write to .undercity/research/*.md so they use the normal hook
		const stopHooks = this.isCurrentTaskMeta
			? [] // Meta-tasks return recommendations, not file changes
			: [
					{
						hooks: [
							async () => {
								if (this.writeCountThisExecution === 0) {
									sessionLogger.info(
										{ model: this.currentModel, writes: 0 },
										"Stop hook rejected: agent tried to finish with 0 writes",
									);
									return {
										continue: false,
										reason:
											"You haven't made any code changes yet. Your task requires creating or editing files. If the task specifies a new file path, use the Write tool to create it (parent directories are created automatically). Please implement the required changes before finishing.",
									};
								}
								return { continue: true };
							},
						],
					},
				];

		// Set maxTurns based on model tier - prevents runaway exploration
		// Simple tasks (haiku): 10 turns, Standard (sonnet): 15, Complex (opus): 25
		const maxTurnsPerModel: Record<ModelTier, number> = {
			haiku: 10,
			sonnet: 15,
			opus: 25,
		};
		const maxTurns = maxTurnsPerModel[this.currentModel];
		sessionLogger.debug({ model: this.currentModel, maxTurns }, `Agent maxTurns: ${maxTurns}`);

		// Build query parameters - use resume if we have a session to continue
		const queryOptions = {
			model: MODEL_NAMES[this.currentModel],
			permissionMode: "bypassPermissions" as const,
			allowDangerouslySkipPermissions: true,
			settingSources: ["project"] as ("project" | "user")[],
			// CRITICAL: Use workingDirectory so agent edits files in the correct location (worktree)
			cwd: this.workingDirectory,
			// Limit turns to prevent runaway exploration - simple tasks don't need 20+ turns
			maxTurns,
			// Defense-in-depth: explicitly block git push even if settings fail to load
			disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			// Stop hook: prevent agent from finishing without making changes (disabled for meta-tasks)
			hooks:
				stopHooks.length > 0
					? {
							Stop: stopHooks,
						}
					: undefined,
		};

		// Use resume to continue the session, or prompt to start fresh
		const queryParams = canResume
			? { resume: this.currentAgentSessionId!, prompt: resumePrompt!, options: queryOptions }
			: { prompt, options: queryOptions };

		// Log prompt size for performance analysis
		const promptSize = prompt?.length || resumePrompt?.length || 0;
		sessionLogger.info({ promptSize, hasContext: !!this.currentBriefing }, `Agent prompt size: ${promptSize} chars`);

		const queryStart = Date.now();
		let lastMsgTime = queryStart;
		let msgCount = 0;

		for await (const message of query(queryParams)) {
			msgCount++;
			const now = Date.now();
			const delta = now - lastMsgTime;
			const msgType = (message as Record<string, unknown>).type as string;

			// Log slow messages (>5s between messages)
			if (delta > 5000) {
				const msg = message as Record<string, unknown>;
				const subtype = msg.subtype as string | undefined;
				const toolName =
					msgType === "assistant"
						? ((msg.message as Record<string, unknown>)?.content as Array<{ type: string; name?: string }>)?.find(
								(c) => c.type === "tool_use",
							)?.name
						: undefined;
				sessionLogger.info(
					{ msgCount, msgType, subtype, toolName, deltaMs: delta, totalMs: now - queryStart },
					`Slow message gap: ${delta}ms waiting for ${msgType}${toolName ? `:${toolName}` : ""}`,
				);
			}
			lastMsgTime = now;

			// Track token usage
			const usage = this.metricsTracker.extractTokenUsage(message);
			if (usage) {
				this.metricsTracker.recordTokenUsage(message, this.currentModel);
				this.tokenUsageThisTask.push(usage);
			}

			// Track write operations for Stop hook
			this.trackWriteOperations(message);

			// Stream output if enabled
			if (this.stream) {
				this.streamMessage(message);
			}

			if (message.type === "result") {
				// Record SDK metrics to live-metrics.json
				const msg = message as Record<string, unknown>;
				const usageData = msg.usage as Record<string, number> | undefined;
				const modelUsage = msg.modelUsage as Record<string, Record<string, number>> | undefined;

				// Capture session ID for potential resume on retry
				// The SDK returns conversationId in the result message
				if (!this.currentAgentSessionId && msg.conversationId) {
					this.currentAgentSessionId = msg.conversationId as string;
					sessionLogger.debug({ sessionId: this.currentAgentSessionId }, "Captured agent session ID for resume");
				}

				// Capture turn count for performance analysis
				this.lastAgentTurns = (msg.num_turns as number) ?? 0;

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
					turns: this.lastAgentTurns,
					model: this.currentModel,
					modelUsage: modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>,
				});

				if (msg.subtype === "success") {
					result = msg.result as string;
				}
			}
		}

		// Store output for knowledge extraction
		this.lastAgentOutput = result;

		// Parse agent output for decision points and capture them
		try {
			const decisions = parseAgentOutputForDecisions(result, this.currentTaskId);
			for (const d of decisions) {
				const captured = captureDecision(this.currentTaskId, d.question, d.context, d.options, this.stateDir);
				sessionLogger.debug(
					{ decisionId: captured.id, category: captured.category },
					"Captured decision point from agent output",
				);
			}
		} catch {
			// Non-critical - continue without decision capture
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
	 * Track write operations from SDK messages for the Stop hook
	 */
	/** Pending write tools awaiting result (maps tool_use_id to tool name) */
	private pendingWriteTools: Map<string, { name: string; filePath?: string }> = new Map();

	private trackWriteOperations(message: unknown): void {
		const msg = message as Record<string, unknown>;

		// Check assistant messages for tool use REQUESTS
		if (msg.type === "assistant") {
			const betaMessage = msg.message as
				| {
						content?: Array<{
							type: string;
							name?: string;
							id?: string;
							input?: { file_path?: string };
						}>;
				  }
				| undefined;
			if (betaMessage?.content) {
				for (const block of betaMessage.content) {
					if (block.type === "tool_use" && block.name && block.id) {
						if (["Write", "Edit", "NotebookEdit"].includes(block.name)) {
							const filePath = block.input?.file_path;
							this.pendingWriteTools.set(block.id, { name: block.name, filePath });
							sessionLogger.debug({ tool: block.name, filePath, toolId: block.id }, "Write tool requested");
						}
					}
				}
			}
		}

		// Check for tool RESULTS (success or failure)
		if (msg.type === "user") {
			const userMessage = msg.message as
				| {
						content?: Array<{
							type: string;
							tool_use_id?: string;
							content?: string;
							is_error?: boolean;
						}>;
				  }
				| undefined;
			if (userMessage?.content) {
				for (const block of userMessage.content) {
					if (block.type === "tool_result" && block.tool_use_id) {
						const pendingTool = this.pendingWriteTools.get(block.tool_use_id);
						if (pendingTool) {
							this.pendingWriteTools.delete(block.tool_use_id);
							const isError = block.is_error === true;
							const contentHasError = block.content?.toLowerCase().includes("error") ?? false;
							const succeeded = !isError && !contentHasError;

							if (succeeded) {
								this.writeCountThisExecution++;
								sessionLogger.debug(
									{
										tool: pendingTool.name,
										filePath: pendingTool.filePath,
										writeCount: this.writeCountThisExecution,
									},
									`Write succeeded (total: ${this.writeCountThisExecution})`,
								);
							} else {
								sessionLogger.debug(
									{
										tool: pendingTool.name,
										filePath: pendingTool.filePath,
										isError,
										contentPreview: block.content?.slice(0, 100),
									},
									"Write tool FAILED - not counting",
								);
							}
						}
					}
				}
			}
		}
	}

	/**
	 * Decide whether to escalate to a better model
	 *
	 * Strategy:
	 * - No changes made: escalate immediately (agent is stuck)
	 * - At opus tier: use maxOpusRetries (default 7) - more attempts at final tier
	 * - Trivial errors (lint/spell only): allow full maxRetriesPerTier attempts
	 * - Serious errors (typecheck/build/test): allow fewer retries (maxRetriesPerTier - 1)
	 *   to escalate faster for errors that likely need a smarter model
	 */
	private shouldEscalate(
		verification: VerificationResult,
		errorCategories: ErrorCategory[],
	): { shouldEscalate: boolean; reason: string } {
		// No changes made = agent is stuck, escalate immediately
		if (verification.filesChanged === 0) {
			return { shouldEscalate: true, reason: "no changes made" };
		}

		// At opus tier, use maxOpusRetries for more attempts (no escalation available)
		if (this.currentModel === "opus") {
			if (this.sameModelRetries < this.maxOpusRetries) {
				const remaining = this.maxOpusRetries - this.sameModelRetries;
				return { shouldEscalate: false, reason: `opus tier, ${remaining} retries left` };
			}
			return { shouldEscalate: true, reason: `max opus retries (${this.maxOpusRetries})` };
		}

		// Check if errors are only trivial (lint/spell)
		const trivialOnly = errorCategories.every((c) => c === "lint" || c === "spell");
		const hasSerious = errorCategories.some((c) => c === "typecheck" || c === "build" || c === "test");

		if (trivialOnly) {
			if (this.sameModelRetries < this.maxRetriesPerTier) {
				const remaining = this.maxRetriesPerTier - this.sameModelRetries;
				return { shouldEscalate: false, reason: `trivial error, ${remaining} retries left at tier` };
			}
			return { shouldEscalate: true, reason: `trivial errors persist after ${this.maxRetriesPerTier} retries` };
		}

		if (hasSerious) {
			// Serious errors: allow fewer retries to escalate faster
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
			// Clear session ID - new model tier needs fresh session
			this.currentAgentSessionId = undefined;
			// Record escalation in metrics tracker
			this.metricsTracker.recordEscalation(previousModel, newModel);
			return true;
		}

		return false;
	}

	/**
	 * Get list of modified files in the working directory (uncommitted changes)
	 */
	private getModifiedFiles(): string[] {
		try {
			const result = execFileSync("git", ["diff", "--name-only", "HEAD"], {
				encoding: "utf-8",
				cwd: this.workingDirectory,
			}).trim();
			if (!result) return [];
			return result.split("\n").filter((f) => f.length > 0);
		} catch {
			return [];
		}
	}

	/**
	 * Get list of files from the last commit (after commit has been made)
	 */
	private getFilesFromLastCommit(): string[] {
		try {
			const result = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
				encoding: "utf-8",
				cwd: this.workingDirectory,
			}).trim();
			if (!result) return [];
			return result.split("\n").filter((f) => f.length > 0);
		} catch {
			return [];
		}
	}

	/**
	 * Commit the work
	 */
	private async commitWork(task: string): Promise<string> {
		try {
			// Check if there are any uncommitted changes (agent may have already committed)
			const statusOutput = execFileSync("git", ["status", "--porcelain"], {
				encoding: "utf-8",
				cwd: this.workingDirectory,
			}).trim();

			// If working directory is clean, agent already committed - return current HEAD
			if (!statusOutput) {
				const sha = execFileSync("git", ["rev-parse", "HEAD"], {
					encoding: "utf-8",
					cwd: this.workingDirectory,
				}).trim();
				this.log("Agent already committed, using existing commit", { sha });
				return sha;
			}

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
