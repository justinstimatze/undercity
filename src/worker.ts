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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { recordComplexityOutcome, recordReviewTriageOutcome } from "./ax-programs.js";
import {
	adjustModelFromMetrics,
	assessComplexityFast,
	assessComplexityQuantitative,
	type ComplexityAssessment,
} from "./complexity.js";
import { type ContextBriefing, type ContextMode, prepareContext } from "./context.js";
import { tryAutoRemediate } from "./error-fix-patterns.js";
import { createAndCheckout } from "./git.js";
import { sessionLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import * as output from "./output.js";
import { readTaskAssignment, updateTaskCheckpoint } from "./persistence.js";
import type { UnresolvedTicket } from "./review.js";
import type { HandoffContext } from "./task.js";
import { isTestTask, planTaskWithReview, type TieredPlanResult } from "./task-planner.js";
import { extractMetaTaskType, isMetaTask, isResearchTask } from "./task-schema.js";
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
import {
	type AgentLoopConfig,
	type AgentLoopContext,
	type AgentLoopDependencies,
	type AgentLoopState,
	runAgentLoop,
} from "./worker/agent-loop.js";
import {
	checkDefaultRetryLimit,
	checkFileThrashing,
	checkFinalTier,
	checkNoChanges,
	checkRepeatedErrorLoop,
	checkSeriousErrors,
	checkTrivialErrors,
	type EscalationResult,
} from "./worker/escalation-logic.js";
import {
	buildFailureErrorMessage,
	markLearningsAsFailed,
	recordComplexityFailure,
	recordFailedTaskPattern,
	recordPermanentFailureWithHumanInput,
	recordPlanFailure,
	updateDecisionOutcomesToFailure,
} from "./worker/failure-recording.js";
import {
	handleMetaTaskResult as handleMetaTaskResultNew,
	handleResearchTaskResult as handleResearchTaskResultNew,
	type MetaTaskDependencies,
	runPMResearchTask as runPMResearchTaskNew,
} from "./worker/meta-task-handler.js";
import type { TaskExecutionState, TaskIdentity } from "./worker/state.js";
import {
	recordComplexitySuccess,
	recordKnowledgeLearnings,
	recordPlanSuccess,
	recordSuccessfulTaskPattern,
	updateDecisionOutcomesToSuccess,
} from "./worker/success-recording.js";
import {
	type FastPathAttemptResult,
	type FastPathConfig,
	handleFastPathFailure,
	handleFastPathSuccess,
} from "./worker/task-helpers.js";
import {
	buildInvalidTargetResult,
	buildNeedsDecompositionResult,
	buildValidationFailureResult,
	type FailureResultContext,
	isStandardImplementationTask,
	isTaskAlreadyComplete,
} from "./worker/task-results.js";
import {
	handleAlreadyComplete as handleAlreadyCompleteNew,
	handleVerificationSuccess as handleVerificationSuccessNew,
	recordVerificationFailure as recordVerificationFailureNew,
	type VerificationDependencies,
} from "./worker/verification-handler.js";

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
function _checkTaskMayBeComplete(task: string, cwd: string): string | undefined {
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
	/** Use multi-lens review at opus tier (multi-angle advisory review) */
	multiLensAtOpus?: boolean;
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
	/**
	 * Enable bash command auditing via PreToolUse hooks.
	 * Logs all bash commands and blocks dangerous patterns.
	 * Default: false
	 */
	auditBash?: boolean;
	/**
	 * Use SDK systemPrompt preset (claude_code) instead of custom prompts.
	 * Experimental - uses SDK's built-in Claude Code system prompt with task context appended.
	 * Default: false
	 */
	useSystemPromptPreset?: boolean;
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
	private multiLensAtOpus: boolean;
	private maxRetriesPerTier: number;
	private maxOpusRetries: number;
	private skipOptionalVerification: boolean;
	private maxTier: ModelTier;
	private auditBash: boolean;
	private useSystemPromptPreset: boolean;

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

	/**
	 * Ralph-style error history - accumulates across all attempts in this task.
	 * Used to detect repeated same errors and build RULES for retry prompts.
	 */
	private errorHistory: Array<{ category: string; message: string; attempt: number }> = [];

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

	/** Stored complexity assessment for Ax recording at task completion */
	private complexityAssessment: ComplexityAssessment | null = null;

	/** Stored review triage result for Ax recording at task completion */
	private reviewTriageResult: {
		riskLevel: string;
		focusAreas: string[];
		suggestedTier: string;
		reasoning: string;
		confidence: number;
	} | null = null;

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
		this.multiLensAtOpus = options.multiLensAtOpus ?? false;
		// 2 retries per tier before escalating (was 3, but that's too slow)
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 3;
		this.maxOpusRetries = options.maxOpusRetries ?? 7;
		// Enable planning by default - haiku plans, sonnet reviews
		this.enablePlanning = options.enablePlanning ?? true;
		// Skip optional verification for trivial tasks to reduce overhead
		this.skipOptionalVerification = options.skipOptionalVerification ?? false;
		// Maximum tier to escalate to (default: opus = no cap)
		this.maxTier = options.maxTier ?? "opus";
		// Bash command auditing (opt-in security feature)
		this.auditBash = options.auditBash ?? false;
		// SDK systemPrompt preset (experimental)
		this.useSystemPromptPreset = options.useSystemPromptPreset ?? false;
		this.currentModel = this.startingModel;
		this.metricsTracker = new MetricsTracker();
	}

	// =========================================================================
	// State Adapters (bridge from this.* to new state interfaces)
	// =========================================================================

	/**
	 * Build TaskIdentity from current instance state.
	 * Used to pass identity to extracted handlers.
	 */
	private buildTaskIdentity(taskId: string, baseCommit: string | undefined): TaskIdentity {
		return {
			taskId,
			sessionId: `session_${Date.now()}`,
			task: this.currentTaskId ? this.currentTaskId : taskId,
			baseCommit,
			isMetaTask: this.isCurrentTaskMeta,
			isResearchTask: this.isCurrentTaskResearch,
			metaType: this.isCurrentTaskMeta ? extractMetaTaskType(this.currentTaskId) : null,
		};
	}

	/**
	 * Build MetaTaskDependencies adapter from instance methods.
	 * Enables extracted handlers to use instance functionality.
	 */
	private buildMetaTaskDeps(): MetaTaskDependencies {
		return {
			commitWork: (task: string) => this.commitWork(task),
			recordMetricsAttempts: (records) => this.metricsTracker.recordAttempts(records),
			completeMetricsTask: (success) => this.metricsTracker.completeTask(success),
		};
	}

	/**
	 * Build WorkerConfig from instance properties.
	 */
	private buildWorkerConfig() {
		return {
			maxAttempts: this.maxAttempts,
			maxRetriesPerTier: this.maxRetriesPerTier,
			maxOpusRetries: this.maxOpusRetries,
			startingModel: this.startingModel,
			maxTier: this.maxTier,
			runTypecheck: this.runTypecheck,
			runTests: this.runTests,
			skipOptionalVerification: this.skipOptionalVerification,
			reviewPasses: this.reviewPasses,
			maxReviewPassesPerTier: this.maxReviewPassesPerTier,
			maxOpusReviewPasses: this.maxOpusReviewPasses,
			multiLensAtOpus: this.multiLensAtOpus,
			autoCommit: this.autoCommit,
			stream: this.stream,
			verbose: this.verbose,
			enablePlanning: this.enablePlanning,
			auditBash: this.auditBash,
			useSystemPromptPreset: this.useSystemPromptPreset,
			workingDirectory: this.workingDirectory,
			stateDir: this.stateDir,
			branch: this.branch,
		} as const;
	}

	/**
	 * Build a minimal state view for meta-task handlers.
	 * Handlers can modify this directly - it references instance arrays.
	 */
	private buildMetaTaskState() {
		return {
			attempts: this.attempts,
			currentModel: this.currentModel,
			sameModelRetries: this.sameModelRetries,
			attemptRecords: this.attemptRecords, // Reference, not copy
			tokenUsage: this.tokenUsageThisTask, // Reference, not copy
			writeCountThisExecution: this.writeCountThisExecution,
			phase: {
				phase: "executing" as const,
				model: this.currentModel,
				attempt: this.attempts,
				startedAt: Date.now(),
			},
			// Minimal additional fields for type compatibility
			lastAgentOutput: "",
			lastAgentTurns: 0,
			currentAgentSessionId: undefined,
			lastFeedback: undefined,
			writesPerFile: new Map<string, number>(),
			noOpEditCount: 0,
			consecutiveNoWriteAttempts: 0,
			errorHistory: [] as Array<{ category: string; message: string; attempt: number }>,
			lastErrorCategory: null,
			lastErrorMessage: null,
			lastDetailedErrors: [] as string[],
			pendingErrorSignature: null,
			filesBeforeAttempt: [] as string[],
			autoRemediationAttempted: false,
			taskAlreadyCompleteReason: null,
			invalidTargetReason: null,
			needsDecompositionReason: null,
			pendingTickets: [] as UnresolvedTicket[],
			currentBriefing: undefined,
			executionPlan: null,
			injectedLearningIds: [] as string[],
			currentHandoffContext: undefined,
			complexityAssessment: null,
			reviewTriageResult: null,
		};
	}

	/**
	 * Build VerificationDependencies adapter from instance methods.
	 * Enables verification handlers to use instance functionality.
	 */
	private buildVerificationDeps(): VerificationDependencies {
		return {
			saveCheckpoint: (phase, data) => this.saveCheckpoint(phase as TaskCheckpoint["phase"], data),
			commitWork: (task: string) => this.commitWork(task),
			getModifiedFiles: () => this.getModifiedFiles(),
			getFilesFromLastCommit: () => this.getFilesFromLastCommit(),
			recordMetricsAttempts: (records) => this.metricsTracker.recordAttempts(records),
			completeMetricsTask: (success) => this.metricsTracker.completeTask(success),
			recordSuccessLearnings: (taskId, task) => this.recordSuccessLearnings(taskId, task),
		};
	}

	/**
	 * Build a state view for verification handlers.
	 * Handlers can modify this directly - it references instance arrays.
	 */
	private buildVerificationState(): TaskExecutionState {
		return {
			attempts: this.attempts,
			currentModel: this.currentModel,
			sameModelRetries: this.sameModelRetries,
			attemptRecords: this.attemptRecords, // Reference, not copy
			tokenUsage: this.tokenUsageThisTask, // Reference, not copy
			writeCountThisExecution: this.writeCountThisExecution,
			phase: {
				phase: "executing" as const,
				model: this.currentModel,
				attempt: this.attempts,
				startedAt: Date.now(),
			},
			lastAgentOutput: this.lastAgentOutput,
			lastAgentTurns: this.lastAgentTurns,
			currentAgentSessionId: undefined,
			lastFeedback: this.lastFeedback,
			writesPerFile: new Map<string, number>(),
			noOpEditCount: this.noOpEditCount,
			consecutiveNoWriteAttempts: 0,
			errorHistory: this.errorHistory, // Reference
			lastErrorCategory: this.lastErrorCategory,
			lastErrorMessage: this.lastErrorMessage,
			lastDetailedErrors: this.lastDetailedErrors, // Reference
			pendingErrorSignature: this.pendingErrorSignature,
			filesBeforeAttempt: this.filesBeforeAttempt, // Reference
			autoRemediationAttempted: this.autoRemediationAttempted,
			taskAlreadyCompleteReason: this.taskAlreadyCompleteReason,
			invalidTargetReason: this.invalidTargetReason,
			needsDecompositionReason: this.needsDecompositionReason,
			pendingTickets: this.pendingTickets, // Reference
			currentBriefing: this.currentBriefing,
			executionPlan: this.executionPlan,
			injectedLearningIds: this.injectedLearningIds, // Reference
			currentHandoffContext: this.currentHandoffContext,
			complexityAssessment: this.complexityAssessment,
			reviewTriageResult: this.reviewTriageResult,
		};
	}

	/**
	 * Build AgentLoopConfig from instance properties.
	 */
	private buildAgentLoopConfig(): AgentLoopConfig {
		return {
			workingDirectory: this.workingDirectory,
			stateDir: this.stateDir,
			stream: this.stream,
			auditBash: this.auditBash,
			useSystemPromptPreset: this.useSystemPromptPreset,
			maxWritesPerFile: TaskWorker.MAX_WRITES_PER_FILE,
		};
	}

	/**
	 * Build AgentLoopState from instance state.
	 * State is mutable - changes persist back to the instance via sync method.
	 */
	private buildAgentLoopState(): AgentLoopState {
		return {
			currentTaskId: this.currentTaskId,
			currentModel: this.currentModel,
			attempts: this.attempts,
			isCurrentTaskMeta: this.isCurrentTaskMeta,
			isCurrentTaskResearch: this.isCurrentTaskResearch,
			currentAgentSessionId: this.currentAgentSessionId,
			lastFeedback: this.lastFeedback,
			lastPostMortem: this.lastPostMortem,
			writeCountThisExecution: this.writeCountThisExecution,
			writesPerFile: this.writesPerFile,
			noOpEditCount: this.noOpEditCount,
			consecutiveNoWriteAttempts: this.consecutiveNoWriteAttempts,
			taskAlreadyCompleteReason: this.taskAlreadyCompleteReason,
			invalidTargetReason: this.invalidTargetReason,
			needsDecompositionReason: this.needsDecompositionReason,
			lastAgentOutput: this.lastAgentOutput,
			lastAgentTurns: this.lastAgentTurns,
			tokenUsageThisTask: this.tokenUsageThisTask,
			injectedLearningIds: this.injectedLearningIds,
		};
	}

	/**
	 * Build AgentLoopDependencies from instance methods.
	 */
	private buildAgentLoopDeps(): AgentLoopDependencies {
		return {
			extractTokenUsage: (message: unknown) => this.metricsTracker.extractTokenUsage(message) ?? undefined,
			recordTokenUsage: (message: unknown, model: ModelTier) => this.metricsTracker.recordTokenUsage(message, model),
			buildAssignmentContext: () => this.buildAssignmentContext(),
			buildHandoffContextSection: () => this.buildHandoffContextSection(),
		};
	}

	/**
	 * Build AgentLoopContext from task and current execution state.
	 */
	private buildAgentLoopContext(task: string): AgentLoopContext {
		return {
			task,
			briefing: this.currentBriefing,
			executionPlan: this.executionPlan,
			handoffContext: this.currentHandoffContext,
			errorHistory: this.errorHistory,
		};
	}

	/**
	 * Sync state changes from agent loop result back to instance.
	 */
	private syncAgentLoopState(state: AgentLoopState): void {
		this.currentAgentSessionId = state.currentAgentSessionId;
		this.writeCountThisExecution = state.writeCountThisExecution;
		this.noOpEditCount = state.noOpEditCount;
		this.consecutiveNoWriteAttempts = state.consecutiveNoWriteAttempts;
		this.taskAlreadyCompleteReason = state.taskAlreadyCompleteReason;
		this.invalidTargetReason = state.invalidTargetReason;
		this.needsDecompositionReason = state.needsDecompositionReason;
		this.lastAgentOutput = state.lastAgentOutput;
		this.lastAgentTurns = state.lastAgentTurns;
		this.injectedLearningIds = state.injectedLearningIds;
		// Note: writesPerFile and tokenUsageThisTask are references, already synced
		// lastPostMortem is cleared by agent loop, sync it back
		this.lastPostMortem = state.lastPostMortem;
	}

	// =========================================================================
	// Logging
	// =========================================================================

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

		// Check for health check nudges from orchestrator
		this.checkForNudge();
	}

	/**
	 * Check for and respond to health check nudge files from the orchestrator.
	 * Nudge files are written by the orchestrator when a worker appears stuck.
	 */
	private checkForNudge(): void {
		const nudgePath = join(this.workingDirectory, ".undercity-nudge");
		try {
			if (!existsSync(nudgePath)) {
				return;
			}

			// Read nudge content
			const nudgeContent = readFileSync(nudgePath, "utf-8");
			const nudge = JSON.parse(nudgeContent) as {
				timestamp: string;
				reason: string;
				attempt: number;
				message: string;
			};

			output.debug(`Received health check nudge: ${nudge.reason} (attempt ${nudge.attempt})`);
			sessionLogger.info({ reason: nudge.reason, attempt: nudge.attempt }, "Worker received health check nudge");

			// Clear the nudge file to acknowledge receipt
			unlinkSync(nudgePath);
			output.debug("Acknowledged nudge by removing file");
		} catch {
			// Non-critical - ignore errors reading/clearing nudge
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

		const isStandardTask = isStandardImplementationTask(this.isCurrentTaskMeta, this.isCurrentTaskResearch);

		// Pre-validate task targets to catch impossible tasks early
		if (isStandardTask) {
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
				return buildValidationFailureResult(task, this.currentModel, validation.reason ?? "unknown", startTime);
			}
		}

		// Fast-path: Try ast-grep for trivial mechanical tasks
		if (isStandardTask) {
			const fastResult = await this.tryFastPath(task, taskId, sessionId, baseCommit, startTime);
			if (fastResult) return fastResult;
		}

		// Pre-execution planning phase: haiku plans, sonnet reviews
		if (this.enablePlanning && isStandardTask) {
			output.workerPhase(taskId, "planning");
			const planResult = await this.runPlanningPhase(task, taskId);
			if (planResult) return planResult;
		}

		// Route research tasks through automated PM
		// PM does web research, writes design doc, and generates follow-up tasks
		if (this.isCurrentTaskResearch) {
			const identity = this.buildTaskIdentity(taskId, baseCommit);
			return runPMResearchTaskNew(identity, this.buildWorkerConfig(), startTime);
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

				// Build agent loop inputs
				const agentLoopState = this.buildAgentLoopState();
				const agentLoopResult = await runAgentLoop(
					this.buildAgentLoopContext(task),
					agentLoopState,
					this.buildAgentLoopConfig(),
					this.buildAgentLoopDeps(),
				);

				// Sync state changes back to instance
				this.syncAgentLoopState(agentLoopState);

				const agentOutput = agentLoopResult.output;
				phaseTimings.agentExecution = Date.now() - agentStart;

				// Handle meta-tasks
				if (this.isCurrentTaskMeta && metaType) {
					const identity = this.buildTaskIdentity(taskId, baseCommit);
					const state = this.buildMetaTaskState();
					const handleResult = handleMetaTaskResultNew(
						identity,
						state,
						agentOutput,
						metaType,
						attemptStart,
						this.buildMetaTaskDeps(),
					);
					if (handleResult.done) return handleResult.result;
					this.lastFeedback = handleResult.feedback;
					continue;
				}

				// Handle research tasks
				if (this.isCurrentTaskResearch) {
					const identity = this.buildTaskIdentity(taskId, baseCommit);
					const state = this.buildMetaTaskState();
					const handleResult = await handleResearchTaskResultNew(
						identity,
						state,
						this.buildWorkerConfig(),
						agentOutput,
						attemptStart,
						this.buildMetaTaskDeps(),
					);
					if (handleResult.done) return handleResult.result;
					this.lastFeedback = handleResult.feedback;
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
		// Ralph-style: clear error history for new task
		this.errorHistory = [];

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
		const { tryFastPath: attemptFastPath } = await import("./fast-path.js");
		const fastResult = attemptFastPath(task, this.workingDirectory);

		if (!fastResult.handled) return null;

		const config: FastPathConfig = {
			taskId,
			sessionId,
			task,
			baseCommit,
			workingDirectory: this.workingDirectory,
			autoCommit: this.autoCommit,
			runTypecheck: this.runTypecheck,
			runTests: this.runTests,
			skipOptionalVerification: this.skipOptionalVerification,
		};

		const typedResult = fastResult as FastPathAttemptResult;
		if (typedResult.success) {
			const result = await handleFastPathSuccess(typedResult, config, startTime);
			if (result.success) {
				return {
					status: "complete",
					task,
					model: "haiku" as ModelTier,
					attempts: 0,
					durationMs: result.durationMs!,
					tokenUsage: { attempts: [], total: 0 },
				};
			}
		} else {
			handleFastPathFailure(typedResult, config);
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
		reviewLevel: { review: boolean; multiLens: boolean; maxReviewTier: ModelTier };
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

		// Store complexity assessment for Ax recording at task completion
		this.complexityAssessment = assessment;

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

		// Store review triage for Ax recording at task completion
		this.reviewTriageResult = {
			riskLevel: assessment.level,
			focusAreas: assessment.signals,
			suggestedTier: reviewLevel.maxReviewTier,
			reasoning: `Complexity ${assessment.level}, review ${reviewLevel.review ? "enabled" : "disabled"}, multi-lens ${reviewLevel.multiLens}`,
			confidence: assessment.confidence,
		};

		this.metricsTracker.startTask(taskId, task, `session_${Date.now()}`, this.currentModel);
		this.metricsTracker.recordAgentSpawn(this.currentModel === "opus" ? "reviewer" : "builder");

		this.log("Starting task", { task, model: this.currentModel, assessment: assessment.level, reviewLevel });
		output.info(`Model: ${this.currentModel}`, { taskId, model: this.currentModel });
		if (reviewLevel.review) {
			const reviewMode = reviewLevel.multiLens ? "escalating + multi-lens" : "escalating";
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
	 * Handle standard implementation task verification and result
	 */
	private async handleImplementationTaskResult(
		task: string,
		taskId: string,
		baseCommit: string | undefined,
		reviewLevel: { review: boolean; multiLens: boolean; maxReviewTier: ModelTier },
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

		// Build context for result helpers
		const resultCtx: FailureResultContext = {
			task,
			taskId,
			model: this.currentModel,
			attempts: this.attempts,
			verification,
			startTime,
			tokenUsageThisTask: this.tokenUsageThisTask,
		};

		// Check for invalid target - fail immediately, no retries
		if (this.invalidTargetReason !== null) {
			return buildInvalidTargetResult(resultCtx, this.invalidTargetReason);
		}

		// Check for needs decomposition - return to orchestrator for decomposition
		if (this.needsDecompositionReason !== null) {
			return buildNeedsDecompositionResult(resultCtx, this.needsDecompositionReason);
		}

		// Check for task already complete (verification must pass to trust agent's claim)
		if (isTaskAlreadyComplete(verification, this.taskAlreadyCompleteReason, this.noOpEditCount)) {
			const identity = this.buildTaskIdentity(taskId, baseCommit);
			const state = this.buildVerificationState();
			return handleAlreadyCompleteNew(identity, state, verification, startTime);
		}

		if (verification.passed) {
			const identity = this.buildTaskIdentity(taskId, baseCommit);
			const state = this.buildVerificationState();
			const config = this.buildWorkerConfig();
			const deps = this.buildVerificationDeps();
			const handleResult = await handleVerificationSuccessNew(
				identity,
				state,
				config,
				verification,
				reviewLevel,
				errorCategories,
				baseCommit,
				attemptStart,
				startTime,
				phaseTimings,
				deps,
			);
			if (handleResult.done) {
				return handleResult.result;
			}
			// Review failed - retry needed
			this.lastFeedback = handleResult.feedback;
			return null;
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
					const identity = this.buildTaskIdentity(taskId, baseCommit);
					const state = this.buildVerificationState();
					const config = this.buildWorkerConfig();
					const deps = this.buildVerificationDeps();
					const handleResult = await handleVerificationSuccessNew(
						identity,
						state,
						config,
						reVerification,
						reviewLevel,
						errorCategories,
						baseCommit,
						attemptStart,
						startTime,
						phaseTimings,
						deps,
					);
					if (handleResult.done) {
						return handleResult.result;
					}
					// Review failed - retry needed
					this.lastFeedback = handleResult.feedback;
					return null;
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
		{
			const identity = this.buildTaskIdentity(taskId, baseCommit);
			const state = this.buildVerificationState();
			const config = this.buildWorkerConfig();
			const deps = this.buildVerificationDeps();
			const { feedback, errorSignature } = recordVerificationFailureNew(
				identity,
				state,
				config,
				verification,
				errorCategories,
				attemptStart,
				deps,
			);
			this.lastFeedback = feedback;
			this.pendingErrorSignature = errorSignature;
			// Sync state changes back from handler
			this.lastErrorCategory = state.lastErrorCategory;
			this.lastErrorMessage = state.lastErrorMessage;
			// errorHistory and lastDetailedErrors are references, already updated
			// Handle escalation decision
			this.handleEscalationDecision(task, taskId, verification, errorCategories);
		}
		return null;
	}

	/**
	 * Record learnings and patterns after successful task completion
	 */
	private async recordSuccessLearnings(taskId: string, task: string): Promise<void> {
		// Knowledge extraction and learnings
		await recordKnowledgeLearnings(taskId, this.lastAgentOutput, this.injectedLearningIds, this.stateDir);

		// Task-file patterns
		recordSuccessfulTaskPattern(taskId, task, this.getFilesFromLastCommit());

		// Decision outcomes
		await updateDecisionOutcomesToSuccess(taskId, this.stateDir);

		// Plan outcome recording (for Ax few-shot learning)
		recordPlanSuccess({
			task,
			taskId,
			executionPlan: this.executionPlan,
			briefing: this.currentBriefing,
			stateDir: this.stateDir,
		});

		// Complexity assessment outcome
		recordComplexitySuccess(task, this.complexityAssessment, this.stateDir, recordComplexityOutcome);

		// Review triage outcome
		if (this.reviewTriageResult) {
			try {
				recordReviewTriageOutcome({ task, diff: "" }, this.reviewTriageResult, true, this.stateDir);
			} catch {
				// Non-critical
			}
		}
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
		// Save debug info and metrics
		this.saveFailedTaskDebug(task, taskId);
		this.metricsTracker.recordAttempts(this.attemptRecords);
		this.metricsTracker.completeTask(false);
		this.cleanupDirtyState();

		// Record various failure learnings using helpers
		markLearningsAsFailed(this.injectedLearningIds, this.stateDir);

		recordPermanentFailureWithHumanInput({
			taskId: this.currentTaskId,
			task,
			pendingErrorSignature: this.pendingErrorSignature,
			lastErrorCategory: this.lastErrorCategory,
			lastErrorMessage: this.lastErrorMessage,
			lastDetailedErrors: this.lastDetailedErrors,
			currentModel: this.currentModel,
			attempts: this.attempts,
			modifiedFiles: this.getModifiedFiles(),
			stateDir: this.stateDir,
		});
		this.pendingErrorSignature = null;
		this.lastErrorCategory = null;
		this.lastErrorMessage = null;
		this.lastDetailedErrors = [];

		recordFailedTaskPattern(taskId, task, this.getModifiedFiles());
		updateDecisionOutcomesToFailure(taskId, this.stateDir);

		recordPlanFailure({
			task,
			executionPlan: this.executionPlan,
			briefing: this.currentBriefing,
			stateDir: this.stateDir,
		});

		recordComplexityFailure(
			{ task, complexityAssessment: this.complexityAssessment, stateDir: this.stateDir },
			recordComplexityOutcome,
		);

		// Record review triage outcome for Ax learning (task failed)
		if (this.reviewTriageResult) {
			try {
				recordReviewTriageOutcome({ task, diff: "" }, this.reviewTriageResult, false, this.stateDir);
			} catch {
				// Non-critical
			}
		}

		const errorMessage = buildFailureErrorMessage(this.consecutiveNoWriteAttempts, this.attempts);

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
			needsDecomposition:
				this.consecutiveNoWriteAttempts >= 2
					? { reason: "Agent could not identify what changes to make - task may need to be more specific" }
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
		// Note: We skip haiku entirely - sonnet requires less steering and has
		// higher first-attempt success rates, making it cheaper overall despite
		// higher per-token cost. Opus reserved for critical tasks only.
		switch (assessment.level) {
			case "trivial":
			case "simple":
			case "standard":
			case "complex":
				return this.capAtMaxTier("sonnet");
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
	 * - complex/critical: haiku → sonnet → opus (full escalation + multi-lens)
	 *
	 * Also respects maxTier cap - review tier will not exceed configured maximum.
	 *
	 * Rationale: 95% of tasks are trivial/simple/standard and don't benefit from
	 * opus review. The token cost isn't justified when sonnet can catch most issues.
	 */
	private determineReviewLevel(assessment: ComplexityAssessment): {
		review: boolean;
		multiLens: boolean;
		maxReviewTier: ModelTier;
	} {
		// If user explicitly set multi-lens, respect it (full escalation, capped at maxTier)
		if (this.multiLensAtOpus) {
			const cappedTier = this.capAtMaxTier("opus");
			// Disable multi-lens if we can't reach opus
			const canMultiLens = cappedTier === "opus";
			return { review: true, multiLens: canMultiLens, maxReviewTier: cappedTier };
		}

		// If user explicitly disabled reviews, respect that
		if (!this.reviewPasses) {
			return { review: false, multiLens: false, maxReviewTier: this.capAtMaxTier("sonnet") };
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
				return { review: true, multiLens: false, maxReviewTier: this.capAtMaxTier("sonnet") };
			case "critical": {
				// Only critical tasks get opus review + multi-lens (capped at maxTier)
				const cappedTier = this.capAtMaxTier("opus");
				const canMultiLens = cappedTier === "opus";
				return { review: true, multiLens: canMultiLens, maxReviewTier: cappedTier };
			}
			default:
				// Default to capped review
				return { review: true, multiLens: false, maxReviewTier: this.capAtMaxTier("sonnet") };
		}
	}

	/** Previous verification feedback for retry context */
	private lastFeedback?: string;

	/** Post-mortem analysis from previous tier (only set on escalation) */
	private lastPostMortem?: string;

	/**
	 * Decide whether to escalate to a better model
	 *
	 * Strategy:
	 * - Ralph-style: if same error 3+ times, fail fast (agent is stuck in loop)
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
	): EscalationResult {
		const errorMessage = verification.issues[0] || "";

		// Check escalation conditions in order of priority
		let result: EscalationResult | null;

		result = checkRepeatedErrorLoop(errorMessage, this.errorHistory);
		if (result) return result;

		result = checkFileThrashing(this.writesPerFile, TaskWorker.MAX_WRITES_PER_FILE);
		if (result) return result;

		result = checkNoChanges(
			verification.filesChanged,
			this.noOpEditCount,
			this.consecutiveNoWriteAttempts,
			this.currentModel,
		);
		if (result) return result;

		result = checkFinalTier(this.currentModel, this.maxTier, this.sameModelRetries, this.maxOpusRetries);
		if (result) return result;

		result = checkTrivialErrors(errorCategories, this.sameModelRetries, this.maxRetriesPerTier);
		if (result) return result;

		result = checkSeriousErrors(errorCategories, task, this.sameModelRetries, this.maxRetriesPerTier);
		if (result) return result;

		return checkDefaultRetryLimit(this.sameModelRetries, this.maxRetriesPerTier);
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
