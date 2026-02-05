/**
 * Worker State Management
 *
 * Patterns borrowed from:
 *   - TanStack Query: Status discriminants, derived state selectors
 *   - Zustand: State slices for organized access
 *   - XState: Typed phases, guarded transitions
 *
 * Design:
 *   - WorkerConfig: Immutable settings, set once at construction
 *   - TaskExecutionState: Mutable state, reset per task
 *   - Selectors: Computed/derived values from state (no mutation)
 *   - Actions: State transitions with guards
 */

import type { ComplexityAssessment } from "../complexity.js";
import type { ContextBriefing } from "../context.js";
import type { UnresolvedTicket } from "../review.js";
import type { HandoffContext } from "../task.js";
import type { TieredPlanResult } from "../task-planner.js";
import type { AttemptRecord, MetaTaskType, ModelTier, TaskCheckpoint, TokenUsage } from "../types.js";

// =============================================================================
// Configuration (Immutable)
// =============================================================================

/**
 * Immutable worker configuration - set at construction, never changes
 */
export interface WorkerConfig {
	// Execution limits
	readonly maxAttempts: number;
	readonly maxRetriesPerTier: number;
	readonly maxOpusRetries: number;

	// Starting state
	readonly startingModel: ModelTier;
	readonly maxTier: ModelTier;

	// Verification settings
	readonly runTypecheck: boolean;
	readonly runTests: boolean;
	readonly skipOptionalVerification: boolean;

	// Review settings
	readonly reviewPasses: boolean;
	readonly maxReviewPassesPerTier: number;
	readonly maxOpusReviewPasses: number;
	readonly multiLensAtOpus: boolean;

	// Behavior flags
	readonly autoCommit: boolean;
	readonly stream: boolean;
	readonly verbose: boolean;
	readonly enablePlanning: boolean;
	readonly auditBash: boolean;
	readonly useSystemPromptPreset: boolean;

	// Paths
	readonly workingDirectory: string;
	readonly stateDir: string;
	readonly branch?: string;
}

// =============================================================================
// Execution Phase (Discriminated Union - XState style)
// =============================================================================

/**
 * Current execution phase with phase-specific data.
 * Using discriminated union ensures type-safe phase transitions.
 */
export type ExecutionPhase =
	| { phase: "initializing" }
	| { phase: "planning"; startedAt: number }
	| { phase: "executing"; model: ModelTier; attempt: number; startedAt: number }
	| { phase: "verifying"; startedAt: number }
	| { phase: "reviewing"; tier: ModelTier; pass: number }
	| { phase: "committing" }
	| { phase: "complete"; result: "success" | "already_complete" | "needs_decomposition" }
	| { phase: "failed"; reason: string };

// =============================================================================
// Task Identity
// =============================================================================

/**
 * Task identity and classification - set at task start, immutable during execution
 */
export interface TaskIdentity {
	readonly taskId: string;
	readonly sessionId: string;
	readonly task: string;
	readonly baseCommit: string | undefined;

	// Task type classification
	readonly isMetaTask: boolean;
	readonly isResearchTask: boolean;
	readonly metaType: MetaTaskType | null;
}

// =============================================================================
// State Slices (Zustand-style organization)
// =============================================================================

/** Execution position tracking */
export interface ExecutionSlice {
	phase: ExecutionPhase;
	attempts: number;
	currentModel: ModelTier;
	sameModelRetries: number;
}

/** Token and attempt tracking */
export interface MetricsSlice {
	tokenUsage: TokenUsage[];
	attemptRecords: AttemptRecord[];
}

/** Agent interaction state */
export interface AgentSlice {
	lastAgentOutput: string;
	lastAgentTurns: number;
	currentAgentSessionId: string | undefined;
	lastFeedback: string | undefined;
}

/** Write operation tracking */
export interface WriteTrackingSlice {
	writeCountThisExecution: number;
	writesPerFile: Map<string, number>;
	noOpEditCount: number;
	consecutiveNoWriteAttempts: number;
}

/** Error tracking (Ralph-style accumulation) */
export interface ErrorSlice {
	errorHistory: Array<{ category: string; message: string; attempt: number }>;
	lastErrorCategory: string | null;
	lastErrorMessage: string | null;
	lastDetailedErrors: string[];
	pendingErrorSignature: string | null;
	filesBeforeAttempt: string[];
	autoRemediationAttempted: boolean;
}

/** Agent-reported status flags */
export interface AgentFlagsSlice {
	taskAlreadyCompleteReason: string | null;
	invalidTargetReason: string | null;
	needsDecompositionReason: string | null;
}

/** Review state */
export interface ReviewSlice {
	pendingTickets: UnresolvedTicket[];
}

/** Context and planning */
export interface ContextSlice {
	currentBriefing: ContextBriefing | undefined;
	executionPlan: TieredPlanResult | null;
	injectedLearningIds: string[];
	predictedFiles: string[];
	currentHandoffContext: HandoffContext | undefined;
}

/** Assessment tracking (for Ax recording) */
export interface AssessmentSlice {
	complexityAssessment: ComplexityAssessment | null;
	reviewTriageResult: ReviewTriageResult | null;
}

export interface ReviewTriageResult {
	riskLevel: string;
	focusAreas: string[];
	suggestedTier: string;
	reasoning: string;
	confidence: number;
}

// =============================================================================
// Combined State
// =============================================================================

/**
 * Full mutable execution state - composition of slices
 */
export interface TaskExecutionState
	extends ExecutionSlice,
		MetricsSlice,
		AgentSlice,
		WriteTrackingSlice,
		ErrorSlice,
		AgentFlagsSlice,
		ReviewSlice,
		ContextSlice,
		AssessmentSlice {}

// =============================================================================
// State Creation
// =============================================================================

/**
 * Create fresh execution state for a new task
 */
export function createExecutionState(config: WorkerConfig): TaskExecutionState {
	return {
		// Execution position
		phase: { phase: "initializing" },
		attempts: 0,
		currentModel: config.startingModel,
		sameModelRetries: 0,

		// Metrics
		tokenUsage: [],
		attemptRecords: [],

		// Agent interaction
		lastAgentOutput: "",
		lastAgentTurns: 0,
		currentAgentSessionId: undefined,
		lastFeedback: undefined,

		// Write tracking
		writeCountThisExecution: 0,
		writesPerFile: new Map(),
		noOpEditCount: 0,
		consecutiveNoWriteAttempts: 0,

		// Error tracking
		errorHistory: [],
		lastErrorCategory: null,
		lastErrorMessage: null,
		lastDetailedErrors: [],
		pendingErrorSignature: null,
		filesBeforeAttempt: [],
		autoRemediationAttempted: false,

		// Agent-reported flags
		taskAlreadyCompleteReason: null,
		invalidTargetReason: null,
		needsDecompositionReason: null,

		// Review state
		pendingTickets: [],

		// Context and planning
		currentBriefing: undefined,
		executionPlan: null,
		injectedLearningIds: [],
		predictedFiles: [],
		currentHandoffContext: undefined,

		// Assessment tracking
		complexityAssessment: null,
		reviewTriageResult: null,
	};
}

/**
 * Create task identity (dependency injection for task classification)
 */
export function createTaskIdentity(
	task: string,
	baseCommit: string | undefined,
	classifier: {
		isMetaTask: (task: string) => boolean;
		isResearchTask: (task: string) => boolean;
		extractMetaTaskType: (task: string) => MetaTaskType | null;
	},
): TaskIdentity {
	const isMeta = classifier.isMetaTask(task);

	return {
		taskId: `solo_${Date.now()}`,
		sessionId: `session_${Date.now()}`,
		task,
		baseCommit,
		isMetaTask: isMeta,
		isResearchTask: !isMeta && classifier.isResearchTask(task),
		metaType: isMeta ? classifier.extractMetaTaskType(task) : null,
	};
}

// =============================================================================
// Selectors (TanStack-style derived state)
// =============================================================================

/** Check if execution is in a terminal phase */
export function isTerminal(state: TaskExecutionState): boolean {
	return state.phase.phase === "complete" || state.phase.phase === "failed";
}

/** Check if we can retry (not terminal, under attempt limit) */
export function canRetry(state: TaskExecutionState, config: WorkerConfig): boolean {
	return !isTerminal(state) && state.attempts < config.maxAttempts;
}

/** Check if we should escalate model tier */
export function shouldEscalate(state: TaskExecutionState, config: WorkerConfig): boolean {
	const maxRetries = state.currentModel === "opus" ? config.maxOpusRetries : config.maxRetriesPerTier;
	return state.sameModelRetries >= maxRetries && state.currentModel !== config.maxTier;
}

/** Get next model tier (or current if at max) */
export function getNextTier(state: TaskExecutionState, config: WorkerConfig): ModelTier {
	if (state.currentModel === config.maxTier) return state.currentModel;
	const tiers: ModelTier[] = ["sonnet", "opus"];
	const currentIdx = tiers.indexOf(state.currentModel);
	const maxIdx = tiers.indexOf(config.maxTier);
	const nextIdx = Math.min(currentIdx + 1, maxIdx);
	return tiers[nextIdx];
}

/** Check if we've seen this exact error before (loop detection) */
export function hasSeenError(state: TaskExecutionState, category: string, message: string): boolean {
	return state.errorHistory.some((e) => e.category === category && e.message === message);
}

/** Get count of repeated errors of the same category */
export function getErrorRepeatCount(state: TaskExecutionState, category: string): number {
	return state.errorHistory.filter((e) => e.category === category).length;
}

/** Check if file is being thrashed (too many writes) */
export function isFileThrashing(state: TaskExecutionState, filePath: string): boolean {
	return (state.writesPerFile.get(filePath) ?? 0) >= MAX_WRITES_PER_FILE;
}

/** Get total tokens used */
export function getTotalTokens(state: TaskExecutionState): number {
	return state.tokenUsage.reduce((sum, usage) => sum + usage.totalTokens, 0);
}

/** Build token usage summary (selector) */
export function selectTokenUsageSummary(state: TaskExecutionState): {
	attempts: TokenUsage[];
	total: number;
} {
	return {
		attempts: state.tokenUsage,
		total: getTotalTokens(state),
	};
}

/** Check if task appears already complete (selector) */
export function selectIsTaskAlreadyComplete(state: TaskExecutionState): boolean {
	return state.taskAlreadyCompleteReason !== null || state.noOpEditCount >= 2;
}

/** Check if task needs decomposition */
export function needsDecomposition(state: TaskExecutionState): boolean {
	return state.needsDecompositionReason !== null;
}

/** Check if task has invalid target */
export function hasInvalidTarget(state: TaskExecutionState): boolean {
	return state.invalidTargetReason !== null;
}

// =============================================================================
// Actions (State Transitions with Guards)
// =============================================================================

/** Transition to planning phase */
export function startPlanning(state: TaskExecutionState): void {
	if (state.phase.phase !== "initializing") {
		throw new Error(`Cannot start planning from phase: ${state.phase.phase}`);
	}
	state.phase = { phase: "planning", startedAt: Date.now() };
}

/** Transition to executing phase */
export function startExecuting(state: TaskExecutionState): void {
	const validFrom = ["initializing", "planning", "verifying", "reviewing"];
	if (!validFrom.includes(state.phase.phase)) {
		throw new Error(`Cannot start executing from phase: ${state.phase.phase}`);
	}
	state.attempts++;
	state.sameModelRetries++;
	state.phase = {
		phase: "executing",
		model: state.currentModel,
		attempt: state.attempts,
		startedAt: Date.now(),
	};
}

/** Transition to verifying phase */
export function startVerifying(state: TaskExecutionState): void {
	if (state.phase.phase !== "executing") {
		throw new Error(`Cannot start verifying from phase: ${state.phase.phase}`);
	}
	state.phase = { phase: "verifying", startedAt: Date.now() };
}

/** Transition to reviewing phase */
export function startReviewing(state: TaskExecutionState, tier: ModelTier, pass: number): void {
	if (state.phase.phase !== "verifying" && state.phase.phase !== "reviewing") {
		throw new Error(`Cannot start reviewing from phase: ${state.phase.phase}`);
	}
	state.phase = { phase: "reviewing", tier, pass };
}

/** Transition to committing phase */
export function startCommitting(state: TaskExecutionState): void {
	const validFrom = ["verifying", "reviewing"];
	if (!validFrom.includes(state.phase.phase)) {
		throw new Error(`Cannot start committing from phase: ${state.phase.phase}`);
	}
	state.phase = { phase: "committing" };
}

/** Mark task as complete */
export function markComplete(
	state: TaskExecutionState,
	result: "success" | "already_complete" | "needs_decomposition",
): void {
	state.phase = { phase: "complete", result };
}

/** Mark task as failed */
export function markFailed(state: TaskExecutionState, reason: string): void {
	state.phase = { phase: "failed", reason };
}

/** Escalate to next model tier */
export function escalateModel(state: TaskExecutionState, config: WorkerConfig): boolean {
	if (!shouldEscalate(state, config)) return false;

	state.currentModel = getNextTier(state, config);
	state.sameModelRetries = 0;
	return true;
}

/** Record an error (Ralph-style accumulation) */
export function recordError(state: TaskExecutionState, category: string, message: string): void {
	state.errorHistory.push({
		category,
		message,
		attempt: state.attempts,
	});
	state.lastErrorCategory = category;
	state.lastErrorMessage = message;
}

/** Record a file write */
export function recordFileWrite(state: TaskExecutionState, filePath: string): void {
	state.writeCountThisExecution++;
	state.writesPerFile.set(filePath, (state.writesPerFile.get(filePath) ?? 0) + 1);
}

/** Reset per-attempt state for retry */
export function prepareForRetry(state: TaskExecutionState): void {
	state.writeCountThisExecution = 0;
	state.writesPerFile.clear();
	state.noOpEditCount = 0;
	state.taskAlreadyCompleteReason = null;
	state.invalidTargetReason = null;
	state.needsDecompositionReason = null;
	state.filesBeforeAttempt = [];
}

/** Restore execution state from checkpoint (crash recovery) */
export function restoreFromCheckpoint(state: TaskExecutionState, checkpoint: TaskCheckpoint): void {
	state.attempts = checkpoint.attempts;
	if (checkpoint.model) {
		state.currentModel = checkpoint.model;
	}
}

/** Record attempt result */
export function recordAttempt(state: TaskExecutionState, success: boolean, durationMs: number): void {
	state.attemptRecords.push({
		model: state.currentModel,
		durationMs,
		success,
	});
}

/** Record token usage for current attempt */
export function recordTokenUsage(state: TaskExecutionState, usage: TokenUsage): void {
	state.tokenUsage.push(usage);
}

// =============================================================================
// Slice Extractors (for passing focused state to handlers)
// =============================================================================

/** Extract execution slice for handlers that only need execution position */
export function getExecutionSlice(state: TaskExecutionState): ExecutionSlice {
	return {
		phase: state.phase,
		attempts: state.attempts,
		currentModel: state.currentModel,
		sameModelRetries: state.sameModelRetries,
	};
}

/** Extract error slice for error handling logic */
export function getErrorSlice(state: TaskExecutionState): ErrorSlice {
	return {
		errorHistory: state.errorHistory,
		lastErrorCategory: state.lastErrorCategory,
		lastErrorMessage: state.lastErrorMessage,
		lastDetailedErrors: state.lastDetailedErrors,
		pendingErrorSignature: state.pendingErrorSignature,
		filesBeforeAttempt: state.filesBeforeAttempt,
		autoRemediationAttempted: state.autoRemediationAttempted,
	};
}

/** Extract write tracking slice */
export function getWriteTrackingSlice(state: TaskExecutionState): WriteTrackingSlice {
	return {
		writeCountThisExecution: state.writeCountThisExecution,
		writesPerFile: state.writesPerFile,
		noOpEditCount: state.noOpEditCount,
		consecutiveNoWriteAttempts: state.consecutiveNoWriteAttempts,
	};
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum writes to a single file before failing (prevents token burn) */
export const MAX_WRITES_PER_FILE = 6;
