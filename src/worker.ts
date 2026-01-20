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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { type PMResearchResult, pmResearch } from "./automated-pm.js";
import { recordPlanCreationOutcome, recordPlanReviewOutcome } from "./ax-programs.js";
import {
	adjustModelFromMetrics,
	assessComplexityFast,
	assessComplexityQuantitative,
	type ComplexityAssessment,
} from "./complexity.js";
import { type ContextBriefing, type ContextMode, prepareContext } from "./context.js";
import { captureDecision, parseAgentOutputForDecisions, updateDecisionOutcome } from "./decision-tracker.js";
import { dualLogger } from "./dual-logger.js";
import { generateToolsPrompt } from "./efficiency-tools.js";
import {
	clearPendingError,
	formatFixSuggestionsForPrompt,
	getFailureWarningsForTask,
	recordPendingError,
	recordPermanentFailure,
	recordSuccessfulFix,
	tryAutoRemediate,
} from "./error-fix-patterns.js";
import { createAndCheckout } from "./git.js";
import { logFastPathComplete, logFastPathFailed } from "./grind-events.js";
import { findRelevantLearnings, formatLearningsCompact, markLearningsUsed } from "./knowledge.js";
import { extractAndStoreLearnings } from "./knowledge-extractor.js";
import { recordQueryResult } from "./live-metrics.js";
import { sessionLogger } from "./logger.js";
import { getMetaTaskPrompt, parseMetaTaskResult } from "./meta-tasks.js";
import { MetricsTracker } from "./metrics.js";
import * as output from "./output.js";
import { readTaskAssignment, updateTaskCheckpoint } from "./persistence.js";
import { runEscalatingReview, type UnresolvedTicket } from "./review.js";
import { addTask, type HandoffContext } from "./task.js";
import { formatCoModificationHints, formatFileSuggestionsForPrompt, recordTaskFiles } from "./task-file-patterns.js";
import { formatExecutionPlanAsContext, isTestTask, planTaskWithReview, type TieredPlanResult } from "./task-planner.js";
import { extractMetaTaskType, isMetaTask, isResearchTask, parseResearchResult } from "./task-schema.js";
import {
	type AttemptRecord,
	type ErrorCategory,
	type MetaTaskType,
	MODEL_NAMES,
	type ModelTier,
	type TaskCheckpoint,
	type TokenUsage,
} from "./types.js";
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

/**
 * Result of pre-flight task validation
 */
interface TaskValidationResult {
	valid: boolean;
	reason?: string;
	missingFiles?: string[];
	suggestion?: string;
}

/**
 * Pre-validate task targets before executing
 * Catches impossible tasks early to avoid wasting tokens
 */
function validateTaskTargets(task: string, cwd: string): TaskValidationResult {
	const taskLower = task.toLowerCase();

	// Skip validation for create/new tasks - they're supposed to create files
	const isCreateTask =
		taskLower.includes("create ") ||
		taskLower.includes("add new ") ||
		taskLower.includes("implement new ") ||
		taskLower.includes("write new ");

	if (isCreateTask) {
		return { valid: true };
	}

	// Extract full file paths mentioned in task
	const fullPathPattern = /\b(src\/[\w\-/]+\.(?:ts|tsx|js|jsx|json|md))\b/g;
	const fullPaths: string[] = [];
	for (const match of task.matchAll(fullPathPattern)) {
		fullPaths.push(match[1]);
	}

	// Check if these paths exist
	const missingFiles: string[] = [];
	for (const filePath of fullPaths) {
		if (!existsSync(join(cwd, filePath))) {
			missingFiles.push(filePath);
		}
	}

	if (missingFiles.length > 0) {
		return {
			valid: false,
			reason: `Referenced files do not exist: ${missingFiles.join(", ")}`,
			missingFiles,
			suggestion: "Update task to reference existing files or change to a 'create' task",
		};
	}

	return { valid: true };
}

/**
 * Check if a task might already be complete by scanning recent commits
 * Returns a hint if likely done, undefined otherwise
 */
function checkTaskMayBeComplete(task: string, cwd: string): string | undefined {
	try {
		// Extract keywords from task
		const keywords = task
			.toLowerCase()
			.replace(/[[\]]/g, "")
			.split(/\s+/)
			.filter(
				(word) =>
					word.length > 3 && !["task", "this", "that", "with", "from", "should", "make", "ensure"].includes(word),
			);

		if (keywords.length === 0) return undefined;

		// Check last 20 commits
		const commits = execSync("git log --oneline -20", { cwd, encoding: "utf-8" })
			.trim()
			.split("\n")
			.map((line) => {
				const [sha, ...rest] = line.split(" ");
				return { sha, message: rest.join(" ").toLowerCase() };
			});

		for (const commit of commits) {
			const matches = keywords.filter((kw) => commit.message.includes(kw)).length;
			const matchRatio = matches / keywords.length;

			if (matchRatio > 0.5 && matches >= 2) {
				return `Recent commit ${commit.sha} may have already addressed this: "${commit.message}". Verify before making changes.`;
			}
		}
	} catch {
		// Non-critical - continue without hint
	}
	return undefined;
}

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
	/** Task was already complete (no changes needed, content was correct) */
	taskAlreadyComplete?: boolean;
	/** Task needs decomposition - agent couldn't act on it (too vague) */
	needsDecomposition?: {
		reason: string;
		/** Suggested subtasks from the agent */
		suggestedSubtasks?: string[];
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
	/**
	 * Enable pre-execution planning phase.
	 * Haiku creates plan, sonnet reviews - catches issues before execution.
	 * Default: true
	 */
	enablePlanning?: boolean;
	/**
	 * Skip optional verification checks (spell, security, code health).
	 * Use for trivial tasks to reduce overhead. Critical checks
	 * (typecheck, tests, lint, build) still run.
	 * Default: false
	 */
	skipOptionalVerification?: boolean;
	/**
	 * Maximum model tier to escalate to.
	 * Caps escalation at this tier - useful for cost control.
	 * Default: "opus" (no cap)
	 */
	maxTier?: ModelTier;
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
	private skipOptionalVerification: boolean;
	private maxTier: ModelTier;

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

	/** Track writes per file to detect thrashing (same file edited repeatedly without progress) */
	private writesPerFile: Map<string, number> = new Map();

	/** Maximum writes to a single file before failing (prevents token burn on stuck edits) */
	private static readonly MAX_WRITES_PER_FILE = 6;

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

	/** Count of no-op edits (content already correct) - signals task may be complete */
	private noOpEditCount: number = 0;

	/** Pending error signature (for tracking successful fixes) */
	private pendingErrorSignature: string | null = null;

	/** Last error category (for recordPermanentFailure) */
	private lastErrorCategory: string | null = null;

	/** Last error message (for recordPermanentFailure) */
	private lastErrorMessage: string | null = null;

	/** Detailed error output for permanent failure recording */
	private lastDetailedErrors: string[] = [];

	/** Files modified before current attempt (for tracking what fixed the error) */
	private filesBeforeAttempt: string[] = [];

	/** Whether auto-remediation was already attempted this task (prevent infinite loops) */
	private autoRemediationAttempted: boolean = false;

	/** State directory for decision tracking and other operational learning */
	private stateDir: string = ".undercity";

	/** Agent reported task is already complete (with reason) */
	private taskAlreadyCompleteReason: string | null = null;

	/** Agent reported invalid target - file/function doesn't exist */
	private invalidTargetReason: string | null = null;

	/** Agent reported task needs decomposition - too vague to act on */
	private needsDecompositionReason: string | null = null;

	/** Count of consecutive attempts that ended with 0 writes */
	private consecutiveNoWriteAttempts: number = 0;

	/** Result from pre-execution planning phase */
	private executionPlan: TieredPlanResult | null = null;

	/** Whether to run pre-execution planning (tiered: haiku plans, sonnet reviews) */
	private enablePlanning: boolean;

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
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 3;
		this.maxOpusRetries = options.maxOpusRetries ?? 7;
		// Enable planning by default - haiku plans, sonnet reviews
		this.enablePlanning = options.enablePlanning ?? true;
		// Skip optional verification for trivial tasks to reduce overhead
		this.skipOptionalVerification = options.skipOptionalVerification ?? false;
		// Maximum tier to escalate to (default: opus = no cap)
		this.maxTier = options.maxTier ?? "opus";
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

		// Add last attempt context for retry tasks
		if (ctx.lastAttempt) {
			lines.push("⚠️ PREVIOUS ATTEMPT FAILED:");
			lines.push(`This task was attempted before and failed. Learn from these mistakes:`);
			lines.push("");
			lines.push(`  Model used: ${ctx.lastAttempt.model}`);
			lines.push(`  Error type: ${ctx.lastAttempt.category}`);
			lines.push(`  Attempts: ${ctx.lastAttempt.attemptCount}`);
			if (ctx.lastAttempt.filesModified.length > 0) {
				lines.push(`  Files modified during attempt:`);
				for (const file of ctx.lastAttempt.filesModified.slice(0, 10)) {
					lines.push(`    - ${file}`);
				}
			}
			lines.push("");
			lines.push("  Error message:");
			// Truncate long error messages
			const errorPreview = ctx.lastAttempt.error.slice(0, 500);
			lines.push(`    ${errorPreview}${ctx.lastAttempt.error.length > 500 ? "..." : ""}`);
			lines.push("");
			lines.push("  DO NOT repeat the same approach that caused this error.");
			lines.push("  Try a different strategy or ask for clarification if the task is unclear.");
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
		const context = this.initializeTaskContext(task, handoffContext);
		const { taskId, sessionId, metaType, baseCommit } = context;

		// Pre-validate task targets to catch impossible tasks early
		if (!this.isCurrentTaskMeta && !this.isCurrentTaskResearch) {
			const validation = validateTaskTargets(task, this.workingDirectory);
			if (!validation.valid) {
				sessionLogger.warn(
					{
						taskId,
						reason: validation.reason,
						missingFiles: validation.missingFiles,
						suggestion: validation.suggestion,
					},
					"Task validation failed - target files do not exist",
				);
				output.error(`Task ${taskId} validation failed: ${validation.reason}`);
				return {
					task,
					status: "failed",
					model: this.currentModel,
					attempts: 0,
					error: `INVALID_TARGET: ${validation.reason}`,
					durationMs: Date.now() - startTime,
				};
			}
		}

		// Fast-path: Try ast-grep for trivial mechanical tasks
		if (!this.isCurrentTaskMeta && !this.isCurrentTaskResearch) {
			const fastResult = await this.tryFastPath(task, taskId, sessionId, baseCommit, startTime);
			if (fastResult) return fastResult;
		}

		// Pre-execution planning phase: haiku plans, sonnet reviews
		if (this.enablePlanning && !this.isCurrentTaskMeta && !this.isCurrentTaskResearch) {
			output.workerPhase(taskId, "planning");
			const planResult = await this.runPlanningPhase(task, taskId);
			if (planResult) return planResult;
		}

		// Route research tasks through automated PM
		// PM does web research, writes design doc, and generates follow-up tasks
		if (this.isCurrentTaskResearch) {
			return this.runPMResearchTask(task, taskId, startTime);
		}

		// Prepare context and assess complexity
		const { reviewLevel, phaseTimings } = await this.prepareContextAndAssessComplexity(task, taskId);

		// Main execution loop
		while (this.attempts < this.maxAttempts) {
			this.attempts++;
			this.sameModelRetries++;
			const attemptStart = Date.now();
			output.workerAttempt(taskId, this.attempts, this.maxAttempts, this.currentModel, {
				retry: this.sameModelRetries,
			});

			try {
				this.saveCheckpoint("executing");
				output.workerPhase(taskId, "executing", { model: this.currentModel });
				const agentStart = Date.now();
				const agentOutput = await this.executeAgent(task);
				phaseTimings.agentExecution = Date.now() - agentStart;

				// Handle meta-tasks
				if (this.isCurrentTaskMeta && metaType) {
					const result = this.handleMetaTaskResult(agentOutput, metaType, task, taskId, attemptStart, startTime);
					if (result) return result;
					continue;
				}

				// Handle research tasks
				if (this.isCurrentTaskResearch) {
					const result = await this.handleResearchTaskResult(agentOutput, task, taskId, attemptStart, startTime);
					if (result) return result;
					continue;
				}

				// Handle standard implementation tasks
				const result = await this.handleImplementationTaskResult(
					task,
					taskId,
					baseCommit,
					reviewLevel,
					attemptStart,
					startTime,
					phaseTimings,
				);
				if (result) return result;
			} catch (error) {
				this.handleAttemptError(error, taskId, attemptStart);
			}
		}

		// Failed after all attempts
		return this.buildFailureResult(task, taskId, startTime);
	}

	/**
	 * Initialize task context and state for a new task run
	 */
	private initializeTaskContext(
		task: string,
		handoffContext?: HandoffContext,
	): {
		taskId: string;
		sessionId: string;
		metaType: MetaTaskType | null;
		baseCommit: string | undefined;
	} {
		// Read assignment to check for checkpoint from crash recovery
		const assignment = readTaskAssignment(this.workingDirectory);
		const checkpoint = assignment?.checkpoint;

		// Restore state from checkpoint if recovering, otherwise start fresh
		if (checkpoint) {
			this.attempts = checkpoint.attempts;
			// Restore model from checkpoint if it was escalated
			if (checkpoint.model && checkpoint.model !== this.currentModel) {
				sessionLogger.info(
					{ previousModel: checkpoint.model, currentModel: this.currentModel },
					"Restoring model from checkpoint",
				);
				this.currentModel = checkpoint.model;
			}
			sessionLogger.info({ phase: checkpoint.phase, attempts: checkpoint.attempts }, "Resuming from checkpoint");
		} else {
			this.attempts = 0;
			this.consecutiveNoWriteAttempts = 0;
		}

		this.attemptRecords = [];
		this.tokenUsageThisTask = [];
		this.sameModelRetries = 0;
		this.pendingTickets = [];
		this.currentHandoffContext = handoffContext;
		this.currentAgentSessionId = undefined;
		this.executionPlan = null;
		this.autoRemediationAttempted = false;

		this.saveCheckpoint("starting");
		this.cleanupDirtyState();

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
		this.currentTaskId = taskId;
		const sessionId = `session_${Date.now()}`;

		this.isCurrentTaskMeta = isMetaTask(task);
		const metaType = this.isCurrentTaskMeta ? extractMetaTaskType(task) : null;
		this.isCurrentTaskResearch = !this.isCurrentTaskMeta && isResearchTask(task);

		if (this.isCurrentTaskMeta) {
			output.taskStart(taskId, `[meta:${metaType}] ${task.substring(task.indexOf("]") + 1, 60).trim()}...`);
		} else if (this.isCurrentTaskResearch) {
			output.taskStart(taskId, `[research] ${task.substring(0, 50)}...`);
		} else {
			output.taskStart(taskId, task.substring(0, 60) + (task.length > 60 ? "..." : ""));
		}

		return { taskId, sessionId, metaType, baseCommit };
	}

	/**
	 * Try fast-path execution for trivial mechanical tasks
	 */
	private async tryFastPath(
		task: string,
		taskId: string,
		sessionId: string,
		baseCommit: string | undefined,
		startTime: number,
	): Promise<TaskResult | null> {
		const { tryFastPath } = await import("./fast-path.js");
		const fastResult = tryFastPath(task, this.workingDirectory);

		if (!fastResult.handled) return null;

		if (fastResult.success) {
			output.success(`Fast-path completed: ${fastResult.filesChanged?.join(", ")}`, { taskId });
			const verification = await verifyWork({
				runTypecheck: this.runTypecheck,
				runTests: this.runTests,
				workingDirectory: this.workingDirectory,
				baseCommit,
				skipOptionalChecks: this.skipOptionalVerification,
			});

			if (verification.passed) {
				if (this.autoCommit && fastResult.filesChanged?.length) {
					try {
						for (const file of fastResult.filesChanged) {
							execFileSync("git", ["add", file], { cwd: this.workingDirectory, stdio: "pipe" });
						}
						execFileSync("git", ["commit", "-m", task.substring(0, 50)], {
							cwd: this.workingDirectory,
							stdio: "pipe",
						});
						output.success("Fast-path changes committed", { taskId });
					} catch (e) {
						output.warning("Fast-path commit failed, changes staged", { taskId, error: String(e) });
					}
				}

				const durationMs = Date.now() - startTime;
				output.info(`Fast-path completed in ${durationMs}ms (vs ~60s with LLM)`, { taskId, durationMs });
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
					model: "haiku" as ModelTier,
					attempts: 0,
					durationMs,
					tokenUsage: { attempts: [], total: 0 },
				};
			}

			output.warning("Fast-path changes failed verification, falling back to LLM", { taskId });
			logFastPathFailed({
				batchId: sessionId,
				taskId,
				objective: task,
				error: "Verification failed after fast-path changes",
				tool: "ast-grep",
			});
			execSync("git checkout -- .", { cwd: this.workingDirectory, stdio: "pipe" });
		} else {
			output.debug(`Fast-path attempted but failed: ${fastResult.error}`, { taskId });
			logFastPathFailed({
				batchId: sessionId,
				taskId,
				objective: task,
				error: fastResult.error || "Unknown error",
				tool: "ast-grep",
			});
		}

		return null;
	}

	/**
	 * Run pre-execution planning phase
	 *
	 * Tiered planning: haiku creates plan, sonnet reviews.
	 * Catches issues before expensive execution:
	 * - Task already complete
	 * - Task needs decomposition
	 * - Invalid targets
	 * - Missing context
	 *
	 * Returns TaskResult if task should be skipped, null to continue execution.
	 */
	private async runPlanningPhase(task: string, taskId: string): Promise<TaskResult | null> {
		const startTime = Date.now();

		try {
			sessionLogger.info({ taskId, task: task.substring(0, 50) }, "Starting planning phase");
			this.executionPlan = await planTaskWithReview(task, this.workingDirectory, "haiku");

			const planDuration = Date.now() - startTime;
			sessionLogger.info(
				{
					taskId,
					approved: this.executionPlan.review.approved,
					proceedWithExecution: this.executionPlan.proceedWithExecution,
					plannerModel: this.executionPlan.plannerModel,
					reviewerModel: this.executionPlan.reviewerModel,
					durationMs: planDuration,
				},
				"Planning phase complete",
			);

			// If plan says skip execution, return early
			if (!this.executionPlan.proceedWithExecution) {
				const skipReason = this.executionPlan.skipReason || "Plan not approved";

				// Check for decomposition signal
				if (this.executionPlan.plan.needsDecomposition?.needed) {
					output.info(`Task needs decomposition: ${skipReason}`, { taskId });
					return {
						task,
						status: "failed",
						model: this.currentModel,
						attempts: 0,
						error: "NEEDS_DECOMPOSITION",
						durationMs: planDuration,
						needsDecomposition: {
							reason: skipReason,
							suggestedSubtasks: this.executionPlan.plan.needsDecomposition.suggestedSubtasks,
						},
					};
				}

				// Check for already complete signal - but still run verification to confirm
				// This prevents hallucinated "already complete" claims from being trusted
				if (this.executionPlan.plan.alreadyComplete?.likely) {
					output.info(`Planner claims task already complete, verifying: ${skipReason}`, { taskId });
					const verification = await verifyWork({
						runTypecheck: this.runTypecheck,
						runTests: this.runTests,
						workingDirectory: this.workingDirectory,
						skipOptionalChecks: this.skipOptionalVerification,
					});
					if (verification.passed) {
						output.success(`Task verified as already complete: ${skipReason}`, { taskId });
						return {
							task,
							status: "complete",
							model: this.currentModel,
							attempts: 0,
							durationMs: planDuration,
							tokenUsage: { attempts: [], total: 0 },
						};
					}
					// Verification failed - planner was wrong, continue with execution
					output.warning(`Planner claimed complete but verification failed, proceeding with execution`, {
						taskId,
					});
				}

				// Plan rejected for other reasons
				output.warning(`Plan not approved: ${skipReason}`, { taskId });
				const issues = this.executionPlan.review.issues?.join("; ") || "Unknown";
				return {
					task,
					status: "failed",
					model: this.currentModel,
					attempts: 0,
					error: `PLAN_REJECTED: ${issues}`,
					durationMs: planDuration,
				};
			}

			// Plan approved - execution will continue
			output.success("Plan approved, proceeding with execution", {
				taskId,
				filesToModify: this.executionPlan.plan.filesToModify.length,
				steps: this.executionPlan.plan.steps.length,
			});

			return null; // Continue with execution
		} catch (error) {
			sessionLogger.warn({ error: String(error), taskId }, "Planning phase failed, proceeding without plan");
			this.executionPlan = null;
			return null; // Continue with execution even if planning fails
		}
	}

	/**
	 * Prepare context briefing and assess task complexity
	 */
	private async prepareContextAndAssessComplexity(
		task: string,
		taskId: string,
	): Promise<{
		assessment: ComplexityAssessment;
		reviewLevel: { review: boolean; annealing: boolean; maxReviewTier: ModelTier };
		phaseTimings: Record<string, number>;
	}> {
		output.workerPhase(taskId, "analyzing");
		const phaseTimings: Record<string, number> = {};
		const phaseStart = Date.now();
		let targetFiles: string[] = [];

		try {
			const contextMode: ContextMode = this.startingModel === "opus" ? "full" : "compact";
			this.currentBriefing = await prepareContext(task, { cwd: this.workingDirectory, mode: contextMode });
			targetFiles = this.currentBriefing.targetFiles;
			const sigCount = this.currentBriefing.functionSignatures.length;
			output.debug(`Found ${targetFiles.length} target files, ${sigCount} signatures`, { taskId });
		} catch (error) {
			this.log("Context preparation failed", { error: String(error) });
		}
		phaseTimings.contextPrep = Date.now() - phaseStart;
		this.saveCheckpoint("context");

		const explicitFiles = extractExplicitFiles(task);
		const filesForMetrics =
			explicitFiles.length > 0
				? targetFiles.filter((t) => explicitFiles.some((f) => t.includes(f) || t.endsWith(f)))
				: targetFiles.slice(0, 5);

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
			assessment = assessComplexityQuantitative(task, targetFiles.slice(0, 5), this.workingDirectory);
			const metricsInfo = assessment.metrics
				? ` (${assessment.metrics.totalLines} lines, ${assessment.metrics.functionCount} functions)`
				: "";
			output.info(`Complexity: ${assessment.level}${metricsInfo}`, { taskId, complexity: assessment.level });
		} else {
			assessment = assessComplexityFast(task);
			output.info(`Complexity: ${assessment.level} (keyword-based)`, { taskId, complexity: assessment.level });
		}

		this.currentModel = this.determineStartingModel(assessment, task);

		if (this.startingModel === "sonnet") {
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

		this.metricsTracker.startTask(taskId, task, `session_${Date.now()}`, this.currentModel);
		this.metricsTracker.recordAgentSpawn(this.currentModel === "opus" ? "reviewer" : "builder");

		this.log("Starting task", { task, model: this.currentModel, assessment: assessment.level, reviewLevel });
		output.info(`Model: ${this.currentModel}`, { taskId, model: this.currentModel });
		if (reviewLevel.review) {
			const reviewMode = reviewLevel.annealing ? "escalating + annealing" : "escalating";
			const reviewCap = reviewLevel.maxReviewTier !== "opus" ? ` (cap: ${reviewLevel.maxReviewTier})` : "";
			output.info(`Reviews: ${reviewMode}${reviewCap}`, { taskId, reviewMode, maxTier: reviewLevel.maxReviewTier });
		}

		if (this.branch) {
			try {
				createAndCheckout(this.branch);
				this.log("Switched to branch", { branch: this.branch });
			} catch (error) {
				this.log("Branch setup note", { error: String(error) });
			}
		}

		return { assessment, reviewLevel, phaseTimings };
	}

	/**
	 * Handle meta-task result parsing and return
	 */
	private handleMetaTaskResult(
		agentOutput: string,
		metaType: MetaTaskType,
		task: string,
		taskId: string,
		attemptStart: number,
		startTime: number,
	): TaskResult | null {
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

		output.warning("Failed to parse meta-task result, retrying...", { taskId });
		this.lastFeedback =
			"Your response could not be parsed as valid recommendations. Please return a JSON object with a 'recommendations' array.";
		return null;
	}

	/**
	 * Handle research task result and return
	 */
	private async handleResearchTaskResult(
		agentOutput: string,
		task: string,
		taskId: string,
		attemptStart: number,
		startTime: number,
	): Promise<TaskResult | null> {
		const hasWrittenFile = this.writeCountThisExecution > 0;

		if (hasWrittenFile) {
			output.workerVerification(taskId, true);
			output.info("Research findings written to .undercity/research/", { taskId });

			this.attemptRecords.push({
				model: this.currentModel,
				durationMs: Date.now() - attemptStart,
				success: true,
			});

			let commitSha: string | undefined;
			if (this.autoCommit) {
				output.workerPhase(taskId, "committing");
				commitSha = await this.commitWork(task);
			}

			this.metricsTracker.recordAttempts(this.attemptRecords);
			this.metricsTracker.completeTask(true);

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

		output.warning("Research task did not write findings file, retrying...", { taskId });
		this.lastFeedback =
			"You must write your research findings to the specified markdown file. Please create the file with your findings.";
		return null;
	}

	/**
	 * Run PM-based research for research tasks
	 * Uses automated PM to research topic, write design doc, and generate follow-up tasks
	 */
	private async runPMResearchTask(task: string, taskId: string, startTime: number): Promise<TaskResult> {
		output.workerPhase(taskId, "pm-research");
		sessionLogger.info({ taskId, task }, "Running PM-based research");

		// Extract topic from task (remove [research] prefix)
		const topic = task.replace(/^\[research\]\s*/i, "").trim();

		try {
			// Run PM research
			const result = await pmResearch(topic, this.workingDirectory);

			// Generate filename from topic
			const slug = topic
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 50);
			const timestamp = new Date().toISOString().split("T")[0];
			const outputPath = join(this.workingDirectory, ".undercity", "research", `${timestamp}-${slug}.md`);

			// Ensure research directory exists
			const researchDir = join(this.workingDirectory, ".undercity", "research");
			if (!existsSync(researchDir)) {
				mkdirSync(researchDir, { recursive: true });
			}

			// Write structured design doc
			const designDoc = this.formatPMResearchAsDesignDoc(topic, result);
			writeFileSync(outputPath, designDoc);
			sessionLogger.info({ taskId, outputPath }, "PM research design doc written");

			// Add generated task proposals to board
			const addedTasks: string[] = [];
			for (const proposal of result.taskProposals) {
				try {
					const newTask = addTask(proposal.objective, {
						priority: proposal.suggestedPriority || 5,
						tags: proposal.tags,
					});
					addedTasks.push(newTask.id);
					sessionLogger.info(
						{ taskId: newTask.id, objective: proposal.objective },
						"Added follow-up task from PM research",
					);
				} catch (error) {
					sessionLogger.warn({ error: String(error), proposal }, "Failed to add task proposal");
				}
			}

			output.info(`PM research complete: ${result.findings.length} findings, ${addedTasks.length} tasks added`, {
				taskId,
			});

			// Commit the research output
			let commitSha: string | undefined;
			if (this.autoCommit) {
				try {
					execFileSync("git", ["add", outputPath], { cwd: this.workingDirectory });
					const commitMsg = `[research] ${topic.slice(0, 50)}`;
					execFileSync("git", ["commit", "-m", commitMsg], { cwd: this.workingDirectory });
					commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: this.workingDirectory,
						encoding: "utf-8",
					}).trim();
				} catch {
					// Commit may fail if no changes - that's ok
				}
			}

			return {
				task,
				status: "complete",
				model: "sonnet", // PM research uses sonnet
				attempts: 1,
				durationMs: Date.now() - startTime,
				commitSha,
				researchResult: {
					summary: `Research on: ${topic}`,
					findings: result.findings.map((f) => ({
						finding: f,
						confidence: 0.8,
						category: "fact" as const,
					})),
					nextSteps: [...result.recommendations, ...addedTasks.map((id) => `Task ${id} added to board`)],
					sources: result.sources,
				},
			};
		} catch (error) {
			sessionLogger.error({ error: String(error), taskId }, "PM research failed");
			return {
				task,
				status: "failed",
				model: "sonnet",
				attempts: 1,
				error: `PM research failed: ${String(error)}`,
				durationMs: Date.now() - startTime,
			};
		}
	}

	/**
	 * Format PM research result as a structured design document
	 */
	private formatPMResearchAsDesignDoc(topic: string, result: PMResearchResult): string {
		const lines: string[] = [
			`# Research: ${topic}`,
			"",
			`_Generated by automated PM on ${new Date().toISOString()}_`,
			"",
			"## Summary",
			"",
		];

		if (result.findings.length > 0) {
			lines.push("### Key Findings");
			lines.push("");
			for (const finding of result.findings) {
				lines.push(`- ${finding}`);
			}
			lines.push("");
		}

		if (result.recommendations.length > 0) {
			lines.push("### Recommendations");
			lines.push("");
			for (const rec of result.recommendations) {
				lines.push(`- ${rec}`);
			}
			lines.push("");
		}

		if (result.sources.length > 0) {
			lines.push("### Sources");
			lines.push("");
			for (const source of result.sources) {
				lines.push(`- ${source}`);
			}
			lines.push("");
		}

		if (result.taskProposals.length > 0) {
			lines.push("## Generated Tasks");
			lines.push("");
			for (const proposal of result.taskProposals) {
				lines.push(`### ${proposal.objective}`);
				lines.push("");
				lines.push(`**Rationale:** ${proposal.rationale}`);
				lines.push(`**Priority:** ${proposal.suggestedPriority}`);
				if (proposal.tags && proposal.tags.length > 0) {
					lines.push(`**Tags:** ${proposal.tags.join(", ")}`);
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	/**
	 * Handle standard implementation task verification and result
	 */
	private async handleImplementationTaskResult(
		task: string,
		taskId: string,
		baseCommit: string | undefined,
		reviewLevel: { review: boolean; annealing: boolean; maxReviewTier: ModelTier },
		attemptStart: number,
		startTime: number,
		phaseTimings: Record<string, number>,
	): Promise<TaskResult | null> {
		this.saveCheckpoint("verifying");
		output.workerPhase(taskId, "verifying");
		const verifyStart = Date.now();
		const verification = await verifyWork({
			runTypecheck: this.runTypecheck,
			runTests: this.runTests,
			workingDirectory: this.workingDirectory,
			baseCommit,
			skipOptionalChecks: this.skipOptionalVerification,
		});
		phaseTimings.verification = Date.now() - verifyStart;

		const errorCategories = categorizeErrors(verification);

		// Check for invalid target - fail immediately, no retries
		if (this.invalidTargetReason !== null) {
			sessionLogger.warn(
				{ taskId, reason: this.invalidTargetReason },
				"Task failed: invalid target (file/function doesn't exist)",
			);
			return {
				task,
				status: "failed",
				model: this.currentModel,
				attempts: this.attempts,
				verification,
				error: `INVALID_TARGET: ${this.invalidTargetReason}`,
				durationMs: Date.now() - startTime,
				tokenUsage: {
					attempts: this.tokenUsageThisTask,
					total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
				},
			};
		}

		// Check for needs decomposition - return to orchestrator for decomposition
		if (this.needsDecompositionReason !== null) {
			sessionLogger.info(
				{ taskId, reason: this.needsDecompositionReason },
				"Task needs decomposition - returning to orchestrator",
			);
			// Parse suggested subtasks from the reason if present
			// Format: "NEEDS_DECOMPOSITION: subtask1; subtask2; subtask3" or just a description
			const suggestedSubtasks = this.needsDecompositionReason.includes(";")
				? this.needsDecompositionReason
						.split(";")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

			return {
				task,
				status: "failed", // Mark as failed so orchestrator handles it
				model: this.currentModel,
				attempts: this.attempts,
				verification,
				error: `NEEDS_DECOMPOSITION: ${this.needsDecompositionReason}`,
				durationMs: Date.now() - startTime,
				tokenUsage: {
					attempts: this.tokenUsageThisTask,
					total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
				},
				needsDecomposition: {
					reason: this.needsDecompositionReason,
					suggestedSubtasks,
				},
			};
		}

		// Check for task already complete
		// IMPORTANT: Even if agent claims complete, verification must pass.
		// This prevents hallucinated "already complete" claims from being trusted.
		const taskAlreadyComplete =
			verification.passed &&
			verification.filesChanged === 0 &&
			(this.taskAlreadyCompleteReason !== null || this.noOpEditCount > 0);

		if (taskAlreadyComplete) {
			return this.buildAlreadyCompleteResult(task, taskId, verification, startTime);
		}

		if (verification.passed) {
			return await this.handleVerificationSuccess(
				task,
				taskId,
				baseCommit,
				verification,
				reviewLevel,
				errorCategories,
				attemptStart,
				startTime,
				phaseTimings,
			);
		}

		// Verification failed - try auto-remediation before escalating to AI
		if (!this.autoRemediationAttempted) {
			const primaryCategory = errorCategories[0] || "unknown";
			const errorMessage = verification.issues.slice(0, 3).join("; ");

			const remediation = tryAutoRemediate(primaryCategory, errorMessage, this.workingDirectory, this.stateDir);

			this.autoRemediationAttempted = true;

			if (remediation.applied) {
				output.info(`Auto-remediation applied for ${primaryCategory}`, {
					taskId,
					patchedFiles: remediation.patchedFiles,
				});

				// Re-verify after auto-fix
				const reVerification = await verifyWork({
					runTypecheck: this.runTypecheck,
					runTests: this.runTests,
					workingDirectory: this.workingDirectory,
					baseCommit,
					skipOptionalChecks: this.skipOptionalVerification,
				});

				if (reVerification.passed) {
					output.success(`Auto-remediation fixed ${primaryCategory} error`, { taskId });
					return await this.handleVerificationSuccess(
						task,
						taskId,
						baseCommit,
						reVerification,
						reviewLevel,
						errorCategories,
						attemptStart,
						startTime,
						phaseTimings,
					);
				}
				output.debug(`Auto-remediation applied but verification still failed`, { taskId });
			} else if (remediation.attempted) {
				output.debug(`Auto-remediation patch failed to apply`, {
					taskId,
					error: remediation.error,
				});
			}
		}

		// Verification failed (and auto-remediation didn't help)
		this.handleVerificationFailure(task, taskId, verification, errorCategories, attemptStart);
		return null;
	}

	/**
	 * Build result for task that was already complete
	 */
	private buildAlreadyCompleteResult(
		task: string,
		taskId: string,
		verification: VerificationResult,
		startTime: number,
	): TaskResult {
		const reason = this.taskAlreadyCompleteReason || "no-op edits detected";
		output.workerVerification(taskId, true);
		sessionLogger.info({ taskId, reason, noOpEdits: this.noOpEditCount }, "Task already complete");

		return {
			task,
			status: "complete",
			model: this.currentModel,
			attempts: this.attempts,
			verification,
			commitSha: undefined,
			durationMs: Date.now() - startTime,
			tokenUsage: {
				attempts: this.tokenUsageThisTask,
				total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
			},
			taskAlreadyComplete: true,
		};
	}

	/**
	 * Handle successful verification - run reviews, commit, record learnings
	 */
	private async handleVerificationSuccess(
		task: string,
		taskId: string,
		baseCommit: string | undefined,
		verification: VerificationResult,
		reviewLevel: { review: boolean; annealing: boolean; maxReviewTier: ModelTier },
		errorCategories: ErrorCategory[],
		attemptStart: number,
		startTime: number,
		phaseTimings: Record<string, number>,
	): Promise<TaskResult | null> {
		output.workerVerification(taskId, true);

		// Record successful fix if we had a pending error
		if (this.pendingErrorSignature) {
			try {
				const currentFiles = this.getModifiedFiles();
				const newFiles = currentFiles.filter((f) => !this.filesBeforeAttempt.includes(f));
				const changedFiles = newFiles.length > 0 ? newFiles : currentFiles;
				recordSuccessfulFix({
					taskId: this.currentTaskId,
					filesChanged: changedFiles,
					editSummary: `Fixed ${errorCategories.join(", ") || "verification"} error`,
					workingDirectory: this.workingDirectory,
					baseCommit,
					stateDir: this.stateDir,
				});
				output.debug(`Recorded fix for error pattern`, { taskId, files: changedFiles.length });
			} catch {
				// Non-critical
			}
			this.pendingErrorSignature = null;
		}

		let finalVerification = verification;
		if (verification.hasWarnings) {
			output.debug("Verification passed with warnings (skipping retry)", {
				taskId,
				warnings: verification.feedback.slice(0, 200),
			});
		}

		// Run review passes if enabled
		if (reviewLevel.review) {
			const reviewResult = await this.runReviewPasses(task, taskId, baseCommit, reviewLevel);
			if (!reviewResult.continue) {
				return null; // Retry needed
			}
			if (reviewResult.verification) {
				finalVerification = reviewResult.verification;
			}
		}

		// Success! Record and commit
		this.attemptRecords.push({
			model: this.currentModel,
			durationMs: Date.now() - attemptStart,
			success: true,
		});
		this.lastFeedback = undefined;

		let commitSha: string | undefined;
		if (this.autoCommit && finalVerification.filesChanged > 0) {
			this.saveCheckpoint("committing", { passed: true });
			output.workerPhase(taskId, "committing");
			commitSha = await this.commitWork(task);
		}

		this.metricsTracker.recordAttempts(this.attemptRecords);
		this.metricsTracker.completeTask(true);

		// Log phase timings
		const totalMs = Date.now() - startTime;
		const msPerTurn = this.lastAgentTurns > 0 ? Math.round(phaseTimings.agentExecution / this.lastAgentTurns) : 0;
		output.info(
			`Phase timings: context=${phaseTimings.contextPrep}ms, agent=${phaseTimings.agentExecution}ms (${this.lastAgentTurns} turns, ${msPerTurn}ms/turn), verify=${phaseTimings.verification}ms, total=${totalMs}ms`,
			{ taskId, phaseTimings, totalMs, turns: this.lastAgentTurns, msPerTurn },
		);

		// Post-success operations (learnings, patterns, decisions)
		await this.recordSuccessLearnings(taskId, task);

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

	/**
	 * Run review passes and return whether to continue or retry
	 */
	private async runReviewPasses(
		task: string,
		taskId: string,
		baseCommit: string | undefined,
		reviewLevel: { review: boolean; annealing: boolean; maxReviewTier: ModelTier },
	): Promise<{ continue: boolean; verification?: VerificationResult }> {
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
			if (reviewResult.unresolvedTickets && reviewResult.unresolvedTickets.length > 0) {
				this.pendingTickets = reviewResult.unresolvedTickets;
			}
			output.warning("Review could not fully resolve issues, retrying task...", { taskId });
			this.lastFeedback = `Review found issues that couldn't be fully resolved: ${reviewResult.issuesFound.join(", ")}`;
			return { continue: false };
		}

		if (reviewResult.issuesFound.length > 0) {
			const finalVerification = await verifyWork({
				runTypecheck: this.runTypecheck,
				runTests: this.runTests,
				workingDirectory: this.workingDirectory,
				baseCommit,
				skipOptionalChecks: this.skipOptionalVerification,
			});
			if (!finalVerification.passed) {
				output.warning("Final verification failed after reviews", { taskId });
				this.lastFeedback = finalVerification.feedback;
				return { continue: false };
			}
			return { continue: true, verification: finalVerification };
		}

		return { continue: true };
	}

	/**
	 * Record learnings and patterns after successful task completion
	 */
	private async recordSuccessLearnings(taskId: string, task: string): Promise<void> {
		// Knowledge extraction
		try {
			const extracted = await extractAndStoreLearnings(taskId, this.lastAgentOutput, this.stateDir);
			if (extracted.length > 0) {
				output.debug(`Extracted ${extracted.length} learnings from task`, { taskId });
			}
			if (this.injectedLearningIds.length > 0) {
				markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
				output.debug(`Marked ${this.injectedLearningIds.length} learnings as used (success)`, { taskId });
			}
		} catch (error) {
			sessionLogger.debug({ error: String(error) }, "Knowledge extraction failed");
		}

		// Task-file patterns
		try {
			const modifiedFiles = this.getFilesFromLastCommit();
			if (modifiedFiles.length > 0) {
				recordTaskFiles(taskId, task, modifiedFiles, true);
				output.debug(`Recorded task-file pattern: ${modifiedFiles.length} files`, { taskId });
			}
		} catch {
			// Non-critical
		}

		// Decision outcomes
		try {
			const { loadDecisionStore } = await import("./decision-tracker.js");
			const store = loadDecisionStore(this.stateDir);
			const taskDecisions = store.resolved.filter((d) => d.taskId === taskId && d.resolution.outcome === undefined);
			for (const decision of taskDecisions) {
				updateDecisionOutcome(decision.id, "success", this.stateDir);
			}
			if (taskDecisions.length > 0) {
				output.debug(`Updated ${taskDecisions.length} decision outcomes to success`, { taskId });
			}
		} catch {
			// Non-critical
		}

		// Plan outcome recording (for Ax few-shot learning)
		if (this.executionPlan?.proceedWithExecution) {
			try {
				const plan = this.executionPlan.plan;
				const briefing = this.currentBriefing?.briefingDoc || "";

				recordPlanCreationOutcome(
					{ task, contextBriefing: briefing },
					{
						filesToRead: plan.filesToRead,
						filesToModify: plan.filesToModify,
						filesToCreate: plan.filesToCreate,
						steps: plan.steps,
						risks: plan.risks,
						expectedOutcome: plan.expectedOutcome,
						alreadyComplete: plan.alreadyComplete?.likely || false,
						needsDecomposition: plan.needsDecomposition?.needed || false,
						reasoning: "",
					},
					true, // Task succeeded
					this.stateDir,
				);

				recordPlanReviewOutcome(
					{ task, plan: JSON.stringify(plan) },
					{
						approved: this.executionPlan.review.approved,
						issues: this.executionPlan.review.issues,
						suggestions: this.executionPlan.review.suggestions,
						skipExecution: this.executionPlan.review.skipExecution?.skip || false,
						reasoning: "",
					},
					true, // Review was accurate (task succeeded after approval)
					this.stateDir,
				);

				output.debug("Recorded plan outcomes for Ax learning", { taskId });
			} catch {
				// Non-critical
			}
		}
	}

	/**
	 * Handle verification failure - record errors, prepare feedback, decide escalation
	 */
	private handleVerificationFailure(
		task: string,
		taskId: string,
		verification: VerificationResult,
		errorCategories: ErrorCategory[],
		attemptStart: number,
	): void {
		this.attemptRecords.push({
			model: this.currentModel,
			durationMs: Date.now() - attemptStart,
			success: false,
			errorCategories,
		});

		// Record error pattern for learning
		const primaryCategory = errorCategories[0] || "unknown";
		const errorMessage = verification.issues[0] || verification.feedback.slice(0, 200);
		// Store for potential permanent failure recording
		this.lastErrorCategory = primaryCategory;
		this.lastErrorMessage = errorMessage;
		// Capture detailed errors: all issues plus relevant lines from feedback
		this.lastDetailedErrors = [
			...verification.issues,
			...verification.feedback
				.split("\n")
				.filter(
					(line) => line.includes("error") || line.includes("Error") || line.includes("FAIL") || line.includes("✗"),
				)
				.slice(0, 10),
		];
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

		// Build enhanced feedback with fix suggestions
		this.lastFeedback = this.buildEnhancedFeedback(taskId, verification, primaryCategory, errorMessage);

		this.saveCheckpoint("verifying", {
			passed: false,
			errors: verification.issues.slice(0, 5),
		});

		const errorSummary = errorCategories.length > 0 ? errorCategories.join(", ") : verification.issues.join(", ");
		output.workerVerification(taskId, false, [errorSummary]);

		// Handle escalation decision
		this.handleEscalationDecision(task, taskId, verification, errorCategories);
	}

	/**
	 * Build enhanced feedback with fix suggestions and co-modification hints
	 */
	private buildEnhancedFeedback(
		taskId: string,
		verification: VerificationResult,
		primaryCategory: string,
		errorMessage: string,
	): string {
		let enhancedFeedback = verification.feedback;

		try {
			const fixSuggestion = formatFixSuggestionsForPrompt(primaryCategory, errorMessage);
			if (fixSuggestion) {
				output.debug("Found fix suggestions from previous errors", { taskId });
				enhancedFeedback += `\n\n${fixSuggestion}`;
			}
		} catch {
			// Non-critical
		}

		try {
			const modifiedFiles = this.getModifiedFiles();
			if (modifiedFiles.length > 0) {
				const coModHints = formatCoModificationHints(modifiedFiles);
				if (coModHints) {
					output.debug("Found co-modification hints", { taskId, fileCount: modifiedFiles.length });
					enhancedFeedback += `\n\n${coModHints}`;
				}
			}
		} catch {
			// Non-critical
		}

		return enhancedFeedback;
	}

	/**
	 * Decide whether to escalate and handle escalation
	 */
	private handleEscalationDecision(
		task: string,
		taskId: string,
		verification: VerificationResult,
		errorCategories: ErrorCategory[],
	): void {
		const escalationDecision = this.shouldEscalate(verification, errorCategories, task);

		// Force failure when file thrashing detected (prevents token burn)
		if (escalationDecision.forceFailure) {
			output.error(`Forcing task failure: ${escalationDecision.reason}`, { taskId });
			// Set attempts to max to break out of retry loop
			this.attempts = this.maxAttempts;
			return;
		}

		if (escalationDecision.shouldEscalate) {
			const previousModel = this.currentModel;
			const escalated = this.escalateModel();

			if (escalated) {
				output.debug(`Getting post-mortem from ${previousModel}...`, { taskId });
				this.getPostMortem(task, verification.feedback, previousModel).then((postMortem) => {
					this.lastPostMortem = postMortem;
				});

				if (this.currentModel === "opus" && previousModel !== "opus") {
					prepareContext(task, { cwd: this.workingDirectory, mode: "full" })
						.then((briefing) => {
							this.currentBriefing = briefing;
							output.debug("Re-prepared context with full mode for opus", { taskId });
						})
						.catch(() => {
							// Non-critical
						});
				}

				const lastAttempt = this.attemptRecords[this.attemptRecords.length - 1];
				lastAttempt.escalatedFrom = previousModel as "haiku" | "sonnet";
				lastAttempt.postMortemGenerated = true;

				this.sameModelRetries = 0;
				output.workerEscalation(taskId, previousModel, this.currentModel, escalationDecision.reason);
			} else {
				output.warning("At max model tier, final attempt...", { taskId, model: this.currentModel });
			}
		} else {
			output.debug(`Retrying at ${this.currentModel} (${escalationDecision.reason})`, { taskId });
		}
	}

	/**
	 * Handle errors during an attempt
	 */
	private handleAttemptError(error: unknown, taskId: string, attemptStart: number): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		output.error(`Error: ${errorMessage.substring(0, 100)}`, { taskId });

		// Check for VAGUE_TASK fail-fast error - don't escalate, just fail immediately
		const isVagueTask = errorMessage.includes("VAGUE_TASK:");
		if (isVagueTask) {
			sessionLogger.warn({ taskId }, "VAGUE_TASK detected - failing fast without escalation");
			// Set attempts to max to break out of retry loop
			this.attempts = this.maxAttempts;
		}

		this.attemptRecords.push({
			model: this.currentModel,
			durationMs: Date.now() - attemptStart,
			success: false,
			errorCategories: isVagueTask ? ["no_changes"] : ["unknown"],
		});

		// Don't escalate for vague tasks - it won't help
		if (!isVagueTask) {
			this.escalateModel();
			this.sameModelRetries = 0;
		}
	}

	/**
	 * Save debug information for a failed task to help with debugging
	 */
	private saveFailedTaskDebug(task: string, taskId: string): void {
		try {
			const failedDir = join(this.stateDir, "failed-tasks");
			if (!existsSync(failedDir)) {
				mkdirSync(failedDir, { recursive: true });
			}

			const debugInfo = {
				taskId,
				task,
				timestamp: new Date().toISOString(),
				model: this.currentModel,
				attempts: this.attempts,
				attemptRecords: this.attemptRecords,
				tokenUsage: this.tokenUsageThisTask,
				lastAgentOutput: this.lastAgentOutput.slice(-5000), // Last 5000 chars
				taskAlreadyCompleteReason: this.taskAlreadyCompleteReason,
				invalidTargetReason: this.invalidTargetReason,
				noOpEditCount: this.noOpEditCount,
				workingDirectory: this.workingDirectory,
			};

			const filename = `${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
			writeFileSync(join(failedDir, filename), JSON.stringify(debugInfo, null, 2));
			sessionLogger.info({ taskId, debugFile: join(failedDir, filename) }, "Saved failed task debug info");
		} catch (error) {
			sessionLogger.warn({ taskId, error: String(error) }, "Failed to save debug info for failed task");
		}
	}

	/**
	 * Build failure result after all attempts exhausted
	 */
	private buildFailureResult(task: string, taskId: string, startTime: number): TaskResult {
		// Save debug info for analysis
		this.saveFailedTaskDebug(task, taskId);
		this.metricsTracker.recordAttempts(this.attemptRecords);
		this.metricsTracker.completeTask(false);
		this.cleanupDirtyState();

		// Mark injected learnings as failed
		if (this.injectedLearningIds.length > 0) {
			try {
				markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
			} catch {
				// Non-critical
			}
		}

		// Record permanent failure (instead of just clearing pending error)
		if (this.pendingErrorSignature && this.lastErrorCategory && this.lastErrorMessage) {
			try {
				recordPermanentFailure({
					taskId: this.currentTaskId,
					category: this.lastErrorCategory,
					message: this.lastErrorMessage,
					taskObjective: task,
					modelUsed: this.currentModel,
					attemptCount: this.attempts,
					currentFiles: this.getModifiedFiles(),
					detailedErrors: this.lastDetailedErrors,
					stateDir: this.stateDir,
				});
				output.debug("Recorded permanent failure for learning", {
					taskId,
					category: this.lastErrorCategory,
					detailedErrorCount: this.lastDetailedErrors.length,
				});
			} catch {
				// Non-critical - fall back to just clearing
				try {
					clearPendingError(this.currentTaskId);
				} catch {
					// Ignore
				}
			}
			this.pendingErrorSignature = null;
			this.lastErrorCategory = null;
			this.lastErrorMessage = null;
			this.lastDetailedErrors = [];
		}

		// Record failed task pattern
		try {
			const modifiedFiles = this.getModifiedFiles();
			recordTaskFiles(taskId, task, modifiedFiles, false);
			output.debug(`Recorded failed task pattern`, { taskId });
		} catch {
			// Non-critical
		}

		// Update decision outcomes
		try {
			import("./decision-tracker.js").then(({ loadDecisionStore }) => {
				const store = loadDecisionStore(this.stateDir);
				const taskDecisions = store.resolved.filter((d) => d.taskId === taskId && d.resolution.outcome === undefined);
				for (const decision of taskDecisions) {
					updateDecisionOutcome(decision.id, "failure", this.stateDir);
				}
			});
		} catch {
			// Non-critical
		}

		// Record plan failure for Ax learning (if we had a plan)
		if (this.executionPlan?.proceedWithExecution) {
			try {
				const plan = this.executionPlan.plan;
				const briefing = this.currentBriefing?.briefingDoc || "";

				recordPlanCreationOutcome(
					{ task, contextBriefing: briefing },
					{
						filesToRead: plan.filesToRead,
						filesToModify: plan.filesToModify,
						filesToCreate: plan.filesToCreate,
						steps: plan.steps,
						risks: plan.risks,
						expectedOutcome: plan.expectedOutcome,
						alreadyComplete: plan.alreadyComplete?.likely || false,
						needsDecomposition: plan.needsDecomposition?.needed || false,
						reasoning: "",
					},
					false, // Task failed
					this.stateDir,
				);

				// Note: We don't necessarily blame the review for task failure
				// The review was accurate if it approved and the plan was reasonable
				// So we record as success unless the plan was clearly wrong
			} catch {
				// Non-critical
			}
		}

		// Provide more actionable error message based on failure type
		let errorMessage: string;
		if (this.consecutiveNoWriteAttempts >= 2) {
			// Task failed primarily because agent couldn't identify what to change
			errorMessage =
				`NO_CHANGES: Agent couldn't identify what to modify after ${this.attempts} attempts. ` +
				"Task may be too vague or already complete. Consider: (1) breaking into specific subtasks, " +
				"(2) adding file paths to the task, (3) verifying the task still needs doing.";
		} else {
			errorMessage = "Max attempts reached without passing verification";
		}

		return {
			task,
			status: "failed",
			model: this.currentModel,
			attempts: this.attempts,
			error: errorMessage,
			durationMs: Date.now() - startTime,
			tokenUsage: {
				attempts: this.tokenUsageThisTask,
				total: this.tokenUsageThisTask.reduce((sum, usage) => sum + usage.totalTokens, 0),
			},
			unresolvedTickets: this.pendingTickets.length > 0 ? this.pendingTickets : undefined,
			// Add decomposition suggestion when task was too vague
			needsDecomposition:
				this.consecutiveNoWriteAttempts >= 2
					? {
							reason: "Agent could not identify what changes to make - task may need to be more specific",
						}
					: undefined,
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
	 * Cap a model tier at the configured maxTier
	 */
	private capAtMaxTier(tier: ModelTier): ModelTier {
		const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];
		const tierIndex = tiers.indexOf(tier);
		const maxTierIndex = tiers.indexOf(this.maxTier);
		return tierIndex > maxTierIndex ? this.maxTier : tier;
	}

	/**
	 * Determine starting model based on complexity assessment
	 *
	 * Special handling for test-writing tasks: Always use sonnet minimum.
	 * Test tasks are inherently harder (need understanding of code + test patterns),
	 * and failures are expensive (verification loops on the tests themselves).
	 *
	 * Respects maxTier cap - will not start at a tier higher than configured maximum.
	 */
	private determineStartingModel(assessment: ComplexityAssessment, task: string): ModelTier {
		// Override with user preference if set
		if (this.startingModel !== "sonnet") {
			return this.capAtMaxTier(this.startingModel);
		}

		// Test-writing tasks: minimum sonnet (skip haiku)
		// Test tasks have higher failure rates with haiku due to complexity
		if (isTestTask(task)) {
			sessionLogger.debug({ objective: task.substring(0, 50) }, "Test task detected - using sonnet minimum");
			if (assessment.level === "trivial" || assessment.level === "simple") {
				return this.capAtMaxTier("sonnet");
			}
		}

		// Use assessment to pick model, capped at maxTier
		switch (assessment.level) {
			case "trivial":
				return this.capAtMaxTier("haiku");
			case "simple":
				return this.capAtMaxTier("haiku");
			case "standard":
				return this.capAtMaxTier("sonnet");
			case "complex":
				return this.capAtMaxTier("sonnet"); // Start with sonnet, escalate if needed
			case "critical":
				return this.capAtMaxTier("opus"); // Critical tasks go straight to opus (capped at maxTier)
			default:
				return this.capAtMaxTier("sonnet");
		}
	}

	/**
	 * Determine review level based on complexity assessment
	 *
	 * Review escalation is capped by task complexity to save opus tokens:
	 * - trivial/simple/standard: haiku → sonnet only (no opus review)
	 * - complex/critical: haiku → sonnet → opus (full escalation + annealing)
	 *
	 * Also respects maxTier cap - review tier will not exceed configured maximum.
	 *
	 * Rationale: 95% of tasks are trivial/simple/standard and don't benefit from
	 * opus review. The token cost isn't justified when sonnet can catch most issues.
	 */
	private determineReviewLevel(assessment: ComplexityAssessment): {
		review: boolean;
		annealing: boolean;
		maxReviewTier: ModelTier;
	} {
		// If user explicitly set annealing, respect it (full escalation, capped at maxTier)
		if (this.annealingAtOpus) {
			const cappedTier = this.capAtMaxTier("opus");
			// Disable annealing if we can't reach opus
			const canAnneal = cappedTier === "opus";
			return { review: true, annealing: canAnneal, maxReviewTier: cappedTier };
		}

		// If user explicitly disabled reviews, respect that
		if (!this.reviewPasses) {
			return { review: false, annealing: false, maxReviewTier: this.capAtMaxTier("sonnet") };
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
				return { review: true, annealing: false, maxReviewTier: this.capAtMaxTier("sonnet") };
			case "critical": {
				// Only critical tasks get opus review + annealing (capped at maxTier)
				const cappedTier = this.capAtMaxTier("opus");
				const canAnneal = cappedTier === "opus";
				return { review: true, annealing: canAnneal, maxReviewTier: cappedTier };
			}
			default:
				// Default to capped review
				return { review: true, annealing: false, maxReviewTier: this.capAtMaxTier("sonnet") };
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
				// Check if agent was using Edit on non-existent file
				const editOnNewFile =
					this.consecutiveNoWriteAttempts >= 1 ||
					this.lastFeedback.includes("Edit") ||
					this.lastFeedback.includes("does not exist");

				if (editOnNewFile) {
					retryContext = `

PREVIOUS ATTEMPT FAILED - WRONG TOOL USED:
${this.lastFeedback}

CRITICAL FIX: The Edit tool CANNOT create new files. For new files, you MUST use the Write tool.
Steps:
1. Run: mkdir -p .undercity/research
2. Use Write tool (not Edit) to create ${outputPath} with your findings`;
				} else {
					retryContext = `

PREVIOUS ATTEMPT FEEDBACK:
${this.lastFeedback}

Please provide more detailed findings and ensure the markdown file is written.`;
				}
			}

			prompt = `You are a research assistant. Your task is to gather information and document findings.

RESEARCH OBJECTIVE:
${objectiveWithoutPrefix}${retryContext}

INSTRUCTIONS:
1. Use web search, documentation, and any available resources to research this topic
2. Focus on gathering accurate, relevant information
3. Cite sources when possible
4. Provide actionable insights

OUTPUT FILE: ${outputPath}

CRITICAL - Follow these steps to write the output file:
1. First, run: mkdir -p .undercity/research (to ensure directory exists)
2. Check if ${outputPath} already exists using Read tool
3. If the file exists, read it first, then use Edit or Write to update it
4. If the file does NOT exist, you can create it with Write

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

			// Add relevant learnings from previous tasks (compact format for token efficiency)
			// Use this.stateDir (main repo) for knowledge, not worktree
			// Compact format shows index + preview (~50 tokens/learning vs ~200+ for full)
			// Agent can reference learnings by number if more detail needed
			const relevantLearnings = findRelevantLearnings(task, 5, this.stateDir);
			if (relevantLearnings.length > 0) {
				const learningsPrompt = formatLearningsCompact(relevantLearnings);
				contextSection += `${learningsPrompt}

---

`;
				// Track which learnings we're injecting (we'll mark them used after task completes)
				this.injectedLearningIds = relevantLearnings.map((l) => l.id);
			} else {
				this.injectedLearningIds = [];
			}

			// Add failure warnings ("signs for Ralph") from past failures
			// Use this.stateDir (main repo) for error patterns, not worktree
			const failureWarnings = getFailureWarningsForTask(task, 2, this.stateDir);
			if (failureWarnings) {
				contextSection += `${failureWarnings}

---

`;
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

			// Check if task might already be complete (pre-flight check)
			const alreadyDoneHint = checkTaskMayBeComplete(task, this.workingDirectory);
			if (alreadyDoneHint) {
				contextSection += `⚠️ PRE-FLIGHT CHECK:
${alreadyDoneHint}

---

`;
			}

			// Add execution plan from planning phase (if available)
			if (this.executionPlan?.proceedWithExecution) {
				const planContext = formatExecutionPlanAsContext(this.executionPlan.plan);
				contextSection += `${planContext}

---

`;
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
1. First verify the task isn't already complete - check git log, read target files
2. If task is already done, output exactly: TASK_ALREADY_COMPLETE: <reason>
3. If the target file/function/class doesn't exist and this isn't a create task, output: INVALID_TARGET: <reason>
4. If the task is too vague to act on (no specific targets, unclear what to change), output: NEEDS_DECOMPOSITION: <what specific subtasks are needed>
5. If the task requires creating new files, create them (Write tool creates parent directories)
5. If editing existing files, read them first before editing
6. Minimal changes only - nothing beyond task scope
7. No questions - decide and proceed`;
		}

		// Token usage will be accumulated in this.tokenUsageThisTask

		// Reset counters for this execution
		this.writeCountThisExecution = 0;
		this.writesPerFile.clear();
		this.noOpEditCount = 0;
		this.taskAlreadyCompleteReason = null;
		this.invalidTargetReason = null;
		this.needsDecompositionReason = null;

		// Build hooks - meta-tasks don't need the "must write files" check
		// Research tasks now write to .undercity/research/*.md so they use the normal hook
		const stopHooks = this.isCurrentTaskMeta
			? [] // Meta-tasks return recommendations, not file changes
			: [
					{
						hooks: [
							async () => {
								// Allow stopping if agent reported task is already complete
								if (this.taskAlreadyCompleteReason) {
									sessionLogger.info(
										{ reason: this.taskAlreadyCompleteReason },
										"Stop hook accepted: task already complete",
									);
									return { continue: true };
								}
								// Allow stopping if we detected no-op edits (content was already correct)
								if (this.noOpEditCount > 0 && this.writeCountThisExecution === 0) {
									sessionLogger.info(
										{ noOpEdits: this.noOpEditCount },
										"Stop hook accepted: no-op edits detected (content already correct)",
									);
									return { continue: true };
								}
								if (this.writeCountThisExecution === 0) {
									this.consecutiveNoWriteAttempts++;
									sessionLogger.info(
										{
											model: this.currentModel,
											writes: 0,
											consecutiveNoWrites: this.consecutiveNoWriteAttempts,
										},
										"Stop hook rejected: agent tried to finish with 0 writes",
									);

									// Provide escalating feedback based on consecutive no-write attempts
									// FAIL FAST: After 3 no-write attempts, terminate immediately
									// Data shows escalating vague tasks wastes tokens - 68% of failures are task quality issues
									if (this.consecutiveNoWriteAttempts >= 3) {
										sessionLogger.warn(
											{
												consecutiveNoWrites: this.consecutiveNoWriteAttempts,
												model: this.currentModel,
											},
											"FAIL FAST: 3+ consecutive no-write attempts - terminating to save tokens",
										);
										// Throw to break out of agent loop immediately
										throw new Error(
											`VAGUE_TASK: Agent attempted to finish ${this.consecutiveNoWriteAttempts} times without making changes. ` +
												"Task likely needs decomposition into more specific subtasks.",
										);
									}

									let reason: string;
									if (this.consecutiveNoWriteAttempts === 2) {
										// Second attempt: mention task might be unclear
										reason =
											"You still haven't made any code changes. If you're unsure what to modify:\n" +
											"- Re-read the task to identify the specific file and change needed\n" +
											"- If the task is unclear, output: NEEDS_DECOMPOSITION: <what clarification or subtasks are needed>\n" +
											"- If already complete: TASK_ALREADY_COMPLETE: <reason>";
									} else {
										// First attempt: standard message
										reason =
											"You haven't made any code changes yet. If the task is already complete, output: TASK_ALREADY_COMPLETE: <reason>. Otherwise, implement the required changes.";
									}

									return { continue: false, reason };
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

		// Check if agent reported task is already complete
		const alreadyCompleteMatch = result.match(/TASK_ALREADY_COMPLETE:\s*(.+?)(?:\n|$)/i);
		if (alreadyCompleteMatch) {
			this.taskAlreadyCompleteReason = alreadyCompleteMatch[1].trim();
			sessionLogger.info({ reason: this.taskAlreadyCompleteReason }, "Agent reported task already complete");
		}

		// Check if agent reported invalid target
		const invalidTargetMatch = result.match(/INVALID_TARGET:\s*(.+?)(?:\n|$)/i);
		if (invalidTargetMatch) {
			this.invalidTargetReason = invalidTargetMatch[1].trim();
			sessionLogger.warn({ reason: this.invalidTargetReason }, "Agent reported invalid target");
		}

		// Check if agent reported task needs decomposition
		const needsDecompMatch = result.match(/NEEDS_DECOMPOSITION:\s*(.+?)(?:\n|$)/i);
		if (needsDecompMatch) {
			this.needsDecompositionReason = needsDecompMatch[1].trim();
			sessionLogger.info({ reason: this.needsDecompositionReason }, "Agent reported task needs decomposition");
		}

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

		// Check assistant messages for tool use REQUESTS and TASK_ALREADY_COMPLETE marker
		if (msg.type === "assistant") {
			const betaMessage = msg.message as
				| {
						content?: Array<{
							type: string;
							text?: string;
							name?: string;
							id?: string;
							input?: { file_path?: string };
						}>;
				  }
				| undefined;
			if (betaMessage?.content) {
				for (const block of betaMessage.content) {
					// Check for TASK_ALREADY_COMPLETE marker in text blocks
					if (block.type === "text" && block.text) {
						const match = block.text.match(/TASK_ALREADY_COMPLETE:\s*(.+?)(?:\n|$)/i);
						if (match && !this.taskAlreadyCompleteReason) {
							this.taskAlreadyCompleteReason = match[1].trim();
							sessionLogger.info(
								{ reason: this.taskAlreadyCompleteReason },
								"Agent reported task already complete (streaming)",
							);
						}
						// Check for INVALID_TARGET marker in text blocks
						const invalidMatch = block.text.match(/INVALID_TARGET:\s*(.+?)(?:\n|$)/i);
						if (invalidMatch && !this.invalidTargetReason) {
							this.invalidTargetReason = invalidMatch[1].trim();
							sessionLogger.warn({ reason: this.invalidTargetReason }, "Agent reported invalid target (streaming)");
						}
						// Check for NEEDS_DECOMPOSITION marker in text blocks
						const decompMatch = block.text.match(/NEEDS_DECOMPOSITION:\s*(.+?)(?:\n|$)/i);
						if (decompMatch && !this.needsDecompositionReason) {
							this.needsDecompositionReason = decompMatch[1].trim();
							sessionLogger.info(
								{ reason: this.needsDecompositionReason },
								"Agent reported needs decomposition (streaming)",
							);
						}
					}
					// Track write tool requests
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
							// Handle both string and array content types from Anthropic API
							const contentStr =
								typeof block.content === "string"
									? block.content
									: Array.isArray(block.content)
										? (block.content as Array<string | { text?: string }>)
												.map((c: string | { text?: string }) => (typeof c === "string" ? c : c.text || ""))
												.join("")
										: "";
							// Only count as error if it's a tool_use_error, not just contains "error" in success message
							const contentHasError =
								contentStr.includes("<tool_use_error>") ||
								(contentStr.toLowerCase().includes("error") && !contentStr.toLowerCase().includes("successfully"));
							const succeeded = !isError && !contentHasError;

							if (succeeded) {
								this.writeCountThisExecution++;
								// Reset no-write counter since agent made progress
								this.consecutiveNoWriteAttempts = 0;
								// Track per-file writes to detect thrashing
								const filePath = pendingTool.filePath || "unknown";
								const fileWriteCount = (this.writesPerFile.get(filePath) || 0) + 1;
								this.writesPerFile.set(filePath, fileWriteCount);

								sessionLogger.debug(
									{
										tool: pendingTool.name,
										filePath: pendingTool.filePath,
										writeCount: this.writeCountThisExecution,
										fileWriteCount,
									},
									`Write succeeded (total: ${this.writeCountThisExecution}, file: ${fileWriteCount})`,
								);

								// Check for file thrashing (too many writes to same file)
								if (fileWriteCount >= TaskWorker.MAX_WRITES_PER_FILE) {
									sessionLogger.warn(
										{
											filePath,
											writeCount: fileWriteCount,
											maxAllowed: TaskWorker.MAX_WRITES_PER_FILE,
										},
										"File thrashing detected - too many writes to same file without progress",
									);
								}
							} else {
								// Check if this is a no-op edit (content already correct)
								const isNoOpEdit =
									contentStr.includes("exactly the same") ||
									contentStr.includes("No changes to make") ||
									contentStr.includes("already exists");
								if (isNoOpEdit) {
									this.noOpEditCount++;
									sessionLogger.debug(
										{
											tool: pendingTool.name,
											filePath: pendingTool.filePath,
											noOpCount: this.noOpEditCount,
										},
										"No-op edit detected (content already correct)",
									);
								} else {
									sessionLogger.debug(
										{
											tool: pendingTool.name,
											filePath: pendingTool.filePath,
											isError,
											contentPreview: contentStr.slice(0, 100),
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
	 * - Test-writing tasks get extra retries for test failures (tests are iterative)
	 */
	private shouldEscalate(
		verification: VerificationResult,
		errorCategories: ErrorCategory[],
		task: string,
	): { shouldEscalate: boolean; reason: string; forceFailure?: boolean } {
		// Check for file thrashing (same file edited too many times without progress)
		for (const [filePath, count] of this.writesPerFile) {
			if (count >= TaskWorker.MAX_WRITES_PER_FILE) {
				return {
					shouldEscalate: false,
					reason: `file thrashing: ${filePath} edited ${count} times without verification passing`,
					forceFailure: true,
				};
			}
		}

		// No changes made - check if this is because task is already complete
		if (verification.filesChanged === 0) {
			// If agent tried to make changes but content was already correct, task may be done
			if (this.noOpEditCount > 0) {
				return { shouldEscalate: false, reason: "task may already be complete (no-op edits detected)" };
			}

			// NO_CHANGES is a task quality problem, not a model capability problem.
			// Data shows: tasks escalated to opus on no_changes have 34.6% success vs 95.2% for
			// tasks that started at opus. Escalating wastes expensive opus tokens.
			//
			// Strategy: allow 1 retry at same tier (agent may need clearer instructions in retry),
			// then fail fast. Don't escalate to next tier for no_changes.
			const maxNoChangeRetries = 2;

			if (this.consecutiveNoWriteAttempts < maxNoChangeRetries) {
				return {
					shouldEscalate: false,
					reason: `no changes made, retry ${this.consecutiveNoWriteAttempts + 1}/${maxNoChangeRetries} at ${this.currentModel}`,
				};
			}

			// After retries exhausted, fail fast - don't escalate
			sessionLogger.warn(
				{
					consecutiveNoWrites: this.consecutiveNoWriteAttempts,
					model: this.currentModel,
				},
				"No changes after retries - failing fast (task likely needs clarification, not escalation)",
			);
			return {
				shouldEscalate: false,
				reason: `${this.consecutiveNoWriteAttempts} consecutive no-change attempts - task may need decomposition or clarification`,
				forceFailure: true,
			};
		}

		// At final tier (opus OR maxTier cap), use maxOpusRetries for more attempts (no escalation available)
		const isAtFinalTier = this.currentModel === "opus" || this.currentModel === this.maxTier;
		if (isAtFinalTier) {
			if (this.sameModelRetries < this.maxOpusRetries) {
				const remaining = this.maxOpusRetries - this.sameModelRetries;
				const tierLabel = this.maxTier === "opus" ? "opus tier" : `${this.currentModel} tier (max-tier cap)`;
				return { shouldEscalate: false, reason: `${tierLabel}, ${remaining} retries left` };
			}
			return { shouldEscalate: true, reason: `max retries at final tier (${this.maxOpusRetries})` };
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
			// Test-writing tasks get more retries when tests fail
			// Test failures are expected during test development - give more chances
			const isWritingTests = isTestTask(task);
			const hasTestErrors = errorCategories.includes("test");

			let seriousRetryLimit: number;
			if (isWritingTests && hasTestErrors) {
				// Test-writing tasks with test failures: full retries (tests are iterative)
				seriousRetryLimit = this.maxRetriesPerTier + 1;
				sessionLogger.debug(
					{ retries: this.sameModelRetries, limit: seriousRetryLimit },
					"Test task - allowing extra retries for test failures",
				);
			} else {
				// Other serious errors: allow fewer retries to escalate faster
				seriousRetryLimit = Math.max(2, this.maxRetriesPerTier - 1);
			}

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
	 * Respects maxTier cap - will not escalate beyond the configured maximum tier
	 */
	private escalateModel(): boolean {
		const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];
		const currentIndex = tiers.indexOf(this.currentModel);
		const maxTierIndex = tiers.indexOf(this.maxTier);

		// Don't escalate if we're already at the max tier cap
		if (currentIndex >= maxTierIndex) {
			return false;
		}

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
