/**
 * Undercity Types
 *
 * Core type definitions for the multi-agent orchestrator.
 * These types provide structured interfaces and type aliases
 * that define the behavior, state, and operations of the
 * autonomous task execution system.
 */
import type { ComplexityLevel } from "./complexity.js";

/**
 * Session status - the overall state of a work session
 */
export type SessionStatus =
	| "planning" // Planning phase
	| "awaiting_approval" // Human needs to approve the plan
	| "executing" // Execution phase
	| "reviewing" // Review phase
	| "merging" // Serial merge processing
	| "extracting" // Final extraction in progress
	| "complete" // Successfully completed
	| "failed"; // Something went wrong

/**
 * Agent types representing specialized roles in the orchestration system.
 * Each agent type has a specific function and is assigned a particular AI model:
 *
 * - Scout: Fast reconnaissance agent using Haiku model
 *   Purpose: Quick codebase exploration, initial intelligence gathering
 *
 * - Planner: Strategic planning agent using Sonnet model
 *   Purpose: Create detailed specifications, break down complex goals
 *
 * - Builder: Implementation agent using Sonnet model
 *   Purpose: Build and modify code, execute detailed tasks
 *
 * - Reviewer: Quality assurance agent using Opus model
 *   Purpose: Review work, validate implementations, ensure code quality
 */
export type AgentType = "scout" | "planner" | "builder" | "reviewer";

/**
 * Model tier - the capability level for Claude models
 */
export type ModelTier = "sonnet" | "opus";

/**
 * Canonical model name mapping
 * Single source of truth for model names - update here when new models release
 *
 * Current models (as of Jan 2026):
 * - Sonnet 4.5: Balanced, excellent for coding
 * - Opus 4.5: Most capable, expensive
 */
export const MODEL_NAMES: Record<ModelTier, string> = {
	sonnet: "claude-sonnet-4-5-20250929",
	opus: "claude-opus-4-5-20251101",
} as const;

/**
 * Step status within a session
 */
export type StepStatus =
	| "pending" // Not yet started
	| "assigned" // Assigned to an agent
	| "in_progress" // Agent is working
	| "complete" // Successfully done
	| "failed" // Something went wrong
	| "blocked" // Waiting on something
	| "checkpointed" // Progress saved, can resume
	| "recovering" // Error recovery in progress
	| "escalated"; // Human intervention needed

/**
 * A Step is a unit of work assigned to an agent during a session
 */
export interface Step {
	id: string;
	sessionId: string;
	type: AgentType;
	description: string;
	status: StepStatus;
	agentId?: string;
	branch?: string;
	result?: string;
	error?: string;
	createdAt: Date;
	completedAt?: Date;
}

/**
 * Agent status
 */
export type AgentStatus = "idle" | "working" | "done" | "error" | "stuck";

/**
 * An active agent working on the session
 */
export interface Agent {
	id: string;
	type: AgentType;
	sdkSessionId?: string; // Claude SDK session ID for resumption
	step?: Step;
	status: AgentStatus;
	spawnedAt: Date;
	lastActivityAt: Date;
}

/**
 * Persistence hierarchy:
 * - SessionRecovery: Critical state surviving crashes (session ID, goal, status)
 * - Inventory: Active state during session (agent sessions, steps)
 * - Loadout: Pre-session config (agent types, rules)
 */
export interface SessionRecovery {
	sessionId?: string;
	goal?: string;
	status?: SessionStatus;
	checkpoint?: string;
	lastUpdated: Date;
}

/** @deprecated Use SessionRecovery instead */
export type SafePocket = SessionRecovery;

export interface Inventory {
	steps: Step[];
	agents: Agent[];
	lastUpdated: Date;
}

export interface Loadout {
	maxAgents: number;
	enabledAgentTypes: AgentType[];
	autoApprove: boolean; // Skip human approval for plan
	lastUpdated: Date;
}

/**
 * Git merge status for MergeQueue
 */
export type MergeStatus =
	| "pending" // Waiting in queue
	| "rebasing" // Currently rebasing
	| "testing" // Running tests
	| "merging" // Actually merging
	| "pushing" // Pushing to origin
	| "complete" // Successfully merged and pushed
	| "conflict" // Needs manual resolution
	| "test_failed"; // Tests failed

export interface MergeQueueItem {
	branch: string;
	stepId: string;
	agentId: string;
	status: MergeStatus;
	queuedAt: Date;
	completedAt?: Date;
	error?: string;
	/** Strategy that was used for successful merge */
	strategyUsed?: "theirs" | "ours" | "default";
	/** Files with unresolved conflicts (when status is 'conflict') */
	conflictFiles?: string[];
	/** Number of retry attempts made */
	retryCount?: number;
	/** Maximum number of retries allowed */
	maxRetries?: number;
	/** When the last failure occurred */
	lastFailedAt?: Date;
	/** Earliest time to retry (for exponential backoff) */
	nextRetryAfter?: Date;
	/** Original error message from first failure (preserved across retries) */
	originalError?: string;
	/** Whether this item is currently being retried */
	isRetry?: boolean;
	/** Files modified by this branch (for pre-merge conflict detection) */
	modifiedFiles?: string[];
	/** Duration of merge operation in milliseconds (from queue entry to completion) */
	duration?: number;
	/** Timestamp when merge processing started */
	startedAt?: Date;
}

/**
 * Pre-merge conflict detection result
 * Flags when two queued branches modify the same files
 */
export interface MergeQueueConflict {
	/** Branch that would conflict */
	branch: string;
	/** Other branch it conflicts with */
	conflictsWith: string;
	/** Files touched by both branches */
	overlappingFiles: string[];
	/** Severity based on number of overlapping files */
	severity: "warning" | "error";
}

/**
 * Configuration options for MergeQueue retry behavior
 */
export interface MergeQueueRetryConfig {
	/** Enable retry functionality (default: true) */
	enabled: boolean;
	/** Maximum number of retry attempts (default: 3) */
	maxRetries: number;
	/** Base delay in milliseconds for exponential backoff (default: 1000) */
	baseDelayMs: number;
	/** Maximum delay in milliseconds (default: 30000) */
	maxDelayMs: number;
}

/**
 * Agent definition for the Claude SDK
 */
export interface AgentDefinition {
	description: string;
	prompt: string;
	tools: string[];
	model: "haiku" | "sonnet" | "opus";
}

/**
 * Undercity configuration
 */
export interface UndercityConfig {
	/** Directory for runtime state (.undercity/) */
	stateDir: string;
	/** Maximum squad size */
	maxAgents: number;
	/** Agent definitions */
	agents: Record<AgentType, AgentDefinition>;
	/** Enable auto-approval of plans */
	autoApprove: boolean;
	/** Verbose logging */
	verbose: boolean;
}

/**
 * File operation types for tracking
 */
export type FileOperation = "read" | "write" | "edit" | "delete";

/**
 * A record of a file being touched by an agent
 */
export interface FileTouch {
	/** The file path (relative to cwd) */
	path: string;
	/** Type of operation performed */
	operation: FileOperation;
	/** When the file was touched */
	timestamp: Date;
}

// ============== Scout Cache Types ==============

/**
 * Fingerprint of the codebase state for cache validation
 */
export interface CodebaseFingerprint {
	/** Git commit hash (HEAD) */
	commitHash: string;
	/** Git working tree status (empty if clean) */
	workingTreeStatus: string;
	/** Current branch name */
	branch: string;
	/** Timestamp when fingerprint was calculated */
	timestamp: Date;
}

/**
 * File tracking state for an agent/step
 */
export interface FileTrackingEntry {
	/** The agent ID that touched these files */
	agentId: string;
	/** The step ID associated with this agent */
	stepId: string;
	/** The session ID this belongs to */
	sessionId: string;
	/** Files touched by this agent */
	files: FileTouch[];
	/** When tracking started */
	startedAt: Date;
	/** When tracking ended (agent completed) */
	endedAt?: Date;
}

/**
 * Conflict detection result
 */
export interface FileConflict {
	/** The conflicting file path */
	path: string;
	/** Agents that have touched this file */
	touchedBy: Array<{
		agentId: string;
		stepId: string;
		operation: FileOperation;
		timestamp: Date;
	}>;
}

/**
 * Semantic conflict detection result for AST-based merge analysis
 * Identifies when multiple agents modify the same code symbols (functions, classes, etc.)
 */
export interface SemanticConflict {
	/** Symbol name (function, class, type, etc.) */
	symbolName: string;
	/** Kind of symbol (function, class, interface, etc.) */
	symbolKind: "function" | "class" | "interface" | "type" | "const" | "enum";
	/** Files where this symbol is defined */
	files: string[];
	/** Agents/tasks that modified code related to this symbol */
	touchedBy: Array<{
		agentId: string;
		stepId: string;
		sessionId: string;
	}>;
	/** Severity of conflict based on number of agents and symbol importance */
	severity: "warning" | "error" | "critical";
}

/**
 * Result of semantic conflict analysis
 */
export interface SemanticConflictAnalysis {
	/** Detected semantic conflicts */
	conflicts: SemanticConflict[];
	/** Number of files analyzed */
	analyzedFiles: number;
	/** Number of symbols analyzed */
	symbolsAnalyzed: number;
}

/**
 * Overall file tracking state (persisted)
 */
export interface FileTrackingState {
	/** Active tracking entries by agent ID */
	entries: Record<string, FileTrackingEntry>;
	/** Last updated timestamp */
	lastUpdated: Date;
}

/**
 * A cached flute result entry
 */
export interface ScoutCacheEntry {
	/** SHA-256 hash of CodebaseFingerprint for quick lookup */
	fingerprintHash: string;
	/** The cached flute intel result */
	fluteResult: string;
	/** Hash of the flute goal for per-goal caching */
	goalHash: string;
	/** When this cache entry was created */
	createdAt: Date;
	/** When this cache entry was last used */
	lastUsedAt: Date;
	/** Original goal text (for debugging/inspection) */
	goalText: string;
}

/**
 * Scout cache storage structure
 */
export interface ScoutCache {
	/** Cache entries keyed by combined fingerprintHash + goalHash */
	entries: Record<string, ScoutCacheEntry>;
	/** Cache format version for future migrations */
	version: string;
	/** When cache was last modified */
	lastUpdated: Date;
}

// ============== Loadout Configuration Types ==============

/**
 * Model choices for each agent type in a loadout
 */
export interface LoadoutModelChoices {
	scout: "haiku" | "sonnet" | "opus";
	planner: "haiku" | "sonnet" | "opus";
	builder: "haiku" | "sonnet" | "opus";
	reviewer: "haiku" | "sonnet" | "opus";
}

/**
 * Context size configuration
 */
export type ContextSize = "small" | "medium" | "large";

/**
 * Parallelism level configuration
 */
export type ParallelismLevel = "sequential" | "limited" | "maximum";

/**
 * A loadout configuration - defines how agents are configured for a run
 */
export interface LoadoutConfiguration {
	/** Unique identifier for the loadout */
	id: string;
	/** Human-readable name */
	name: string;
	/** Description of when to use this loadout */
	description: string;
	/** Maximum number of agents in the squad */
	maxAgents: number;
	/** Which agent types are enabled */
	enabledAgentTypes: AgentType[];
	/** Model choice for each agent type */
	modelChoices: LoadoutModelChoices;
	/** How much context to provide to agents */
	contextSize: ContextSize;
	/** How much parallelism to use */
	parallelismLevel: ParallelismLevel;
	/** Skip human approval for plans */
	autoApprove: boolean;
	/** When this configuration was last updated */
	lastUpdated: Date;
}

/**
 * Performance record for a loadout on a specific task
 */
export interface LoadoutPerformanceRecord {
	/** The loadout ID used */
	loadoutId: string;
	/** The task ID */
	taskId: string;
	/** Task type/category if known */
	taskType?: string;
	/** Whether the task succeeded */
	success: boolean;
	/** Total tokens used */
	tokensUsed: number;
	/** Execution time in milliseconds */
	executionTimeMs: number;
	/** Number of rework attempts */
	reworkCount: number;
	/** When this was recorded */
	recordedAt: Date;
}

/**
 * Aggregated score for a loadout
 */
export interface LoadoutScore {
	/** The loadout ID */
	loadoutId: string;
	/** Number of tasks completed with this loadout */
	taskCount: number;
	/** Success rate (0-1) */
	successRate: number;
	/** Average tokens per task */
	avgTokensPerTask: number;
	/** Average execution time in ms */
	avgExecutionTimeMs: number;
	/** Average rework count */
	avgReworkCount: number;
	/** Composite efficiency score (higher is better) */
	efficiencyScore: number;
	/** When this score was last calculated */
	lastCalculated: Date;
}

/**
 * Storage for loadout configurations and performance data
 */
export interface LoadoutStorage {
	/** All loadout configurations */
	configurations: LoadoutConfiguration[];
	/** Performance records */
	performanceRecords: LoadoutPerformanceRecord[];
	/** Calculated scores per loadout */
	scores: Record<string, LoadoutScore>;
	/** When storage was last updated */
	lastUpdated: Date;
}

// ============== Task Matchmaking Types ==============

/**
 * Cross-task conflict detection
 * NEW: Types for parallel task execution
 */
export interface CrossTaskConflict {
	taskIds: string[];
	conflictingFiles: string[];
	severity: "warning" | "error" | "critical";
}

/**
 * Task batch execution result
 * NEW: Result tracking for parallel task execution
 */
export interface TaskBatchResult {
	completedTasks: string[];
	failedTasks: string[];
	totalDuration: number;
	conflicts: CrossTaskConflict[];
}

/**
 * Task set metadata
 * NEW: Metadata for task batching
 */
export interface TaskSetMetadata {
	taskIds: string[];
	sessionIds: string[];
	startedAt: Date;
	estimatedDuration: number;
	riskLevel: "low" | "medium" | "high";
}

// ============== Metrics and Rate Limit Types ==============

/**
 * Task types for categorization
 */
export type TaskType = "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore" | "unknown";

/**
 * Model choice options
 */
export type ModelChoice = "sonnet" | "opus";

/**
 * Historical model choice (includes deprecated haiku for backward compatibility with persisted data)
 */
export type HistoricalModelChoice = ModelChoice | "haiku";

/**
 * Normalize historical model choice to current ModelChoice
 * Maps deprecated haiku to sonnet
 */
export function normalizeModel(model: HistoricalModelChoice | undefined): ModelChoice {
	if (model === "haiku" || !model) return "sonnet";
	return model;
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	model?: ModelChoice;
	timestamp?: Date;
	sonnetEquivalentTokens: number;
}

/**
 * Task-level usage tracking
 */
export interface TaskUsage {
	taskId: string;
	sessionId?: string;
	agentId?: string;
	model: ModelChoice;
	tokens: TokenUsage;
	timestamp: Date;
	durationMs?: number;
}

/**
 * Rate limit hit event
 */
export interface RateLimitHit {
	timestamp: Date;
	model: ModelChoice;
	currentUsage: {
		last5Hours: number;
		currentWeek: number;
		last5HoursSonnet: number;
		currentWeekSonnet: number;
	};
	responseHeaders?: Record<string, string>;
	errorMessage?: string;
}

/**
 * Time window for rate limiting
 */
export type TimeWindow = "5hour" | "week";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
	maxTokensPer5Hours: number;
	maxTokensPerWeek: number;
	warningThreshold: number;
	tokenMultipliers: Record<ModelChoice, number>;
}

/**
 * Rate limit pause state
 */
export interface RateLimitPause {
	/** Whether the system is currently paused due to rate limits */
	isPaused: boolean;
	/** When the pause started */
	pausedAt?: Date;
	/** When the pause is expected to end */
	resumeAt?: Date;
	/** Model that caused the rate limit */
	limitedModel?: ModelChoice;
	/** Number of agents that were paused */
	pausedAgentCount?: number;
	/** Reason for the pause */
	reason?: string;
	/** Per-model pause states for granular control */
	modelPauses?: Record<
		ModelChoice,
		{
			isPaused: boolean;
			pausedAt?: Date;
			resumeAt?: Date;
			reason?: string;
		}
	>;
}

/**
 * Rate limit state
 */
export interface RateLimitState {
	tasks: TaskUsage[];
	rateLimitHits: RateLimitHit[];
	config: RateLimitConfig;
	lastUpdated: Date;
	/** Current pause state */
	pause: RateLimitPause;
}

/**
 * Error categories for tracking what causes failures
 *
 * Granular no_changes variants:
 * - no_changes: Generic (backwards compat)
 * - no_changes_complete: Task was already done (noOpEditCount > 0, verification passed)
 * - no_changes_mismatch: Architectural mismatch (VAGUE_TASK detected)
 * - no_changes_confused: Agent made no progress (consecutive failures, no writes)
 */
export type ErrorCategory =
	| "lint"
	| "typecheck"
	| "build"
	| "test"
	| "spell"
	| "no_changes" // Generic (backwards compat)
	| "no_changes_complete" // Task was already done
	| "no_changes_mismatch" // Architectural mismatch (VAGUE_TASK)
	| "no_changes_confused" // Agent made no progress
	| "unknown";

/**
 * Single attempt within a task
 */
export interface AttemptRecord {
	model: "haiku" | "sonnet" | "opus";
	durationMs: number;
	success: boolean;
	errorCategories?: ErrorCategory[];
	escalatedFrom?: "haiku" | "sonnet";
	postMortemGenerated?: boolean;
}

/**
 * Task metrics for efficiency tracking
 */
export interface TaskMetrics {
	taskId: string;
	sessionId: string;
	objective: string;
	success: boolean;
	durationMs: number;
	totalTokens: number;
	agentsSpawned: number;
	agentTypes: AgentType[];
	startedAt: Date;
	completedAt: Date;
	error?: string;
	/** Individual attempt records for analyzing retry/escalation patterns */
	attempts?: AttemptRecord[];
	/** Final model that succeeded (or failed on last attempt) */
	finalModel?: "haiku" | "sonnet" | "opus";
	/** Complexity level assessed at task start */
	complexityLevel?: ComplexityLevel;
	/** Whether the task was escalated to a higher-tier model */
	wasEscalated?: boolean;
	/** Starting model before any escalation */
	startingModel?: "haiku" | "sonnet" | "opus";
	// ============== Effectiveness Tracking ==============
	/** Learning IDs that were injected into the task prompt */
	injectedLearningIds?: string[];
	/** Files predicted to be modified based on task-file patterns */
	predictedFiles?: string[];
	/** Files actually modified during task execution */
	actualFilesModified?: string[];
	/** Review statistics */
	reviewStats?: {
		/** Number of issues found by review */
		issuesFound: number;
		/** Tokens used for review passes */
		reviewTokens: number;
		/** Number of review passes */
		reviewPasses: number;
	};
	// ============== Additional Effectiveness Tracking ==============
	/** RAG searches performed during task context building */
	ragSearches?: Array<{
		/** Query used for search */
		query: string;
		/** Number of results returned */
		resultsCount: number;
		/** Whether search results were incorporated into prompt */
		wasUsed: boolean;
	}>;
	/** Model recommended by self-tuning routing profile */
	recommendedModel?: "sonnet" | "opus";
	/** Task classifier prediction for risk assessment */
	classifierPrediction?: {
		/** Predicted risk level */
		riskLevel: "low" | "medium" | "high";
		/** Confidence score (0-1) */
		confidence: number;
	};
	// ============== Throughput Tracking ==============
	/** Lines changed (insertions + deletions) */
	linesChanged?: number;
	/** Number of files modified */
	filesChanged?: number;
	// ============== Prompt Efficiency Tracking ==============
	/** Initial prompt size in characters (before any retries) */
	initialPromptSize?: number;
	// ============== Phase Timing Tracking ==============
	/** Time spent in each phase of task execution (in milliseconds) */
	phaseTiming?: {
		/** Planning phase: context gathering, plan creation, plan review */
		planningMs?: number;
		/** Execution phase: agent running, making changes */
		executionMs?: number;
		/** Verification phase: typecheck, lint, test */
		verificationMs?: number;
		/** Review phase: code review passes */
		reviewMs?: number;
		/** Merge phase: rebasing, merging to main */
		mergeMs?: number;
	};
}

/**
 * Efficiency metrics summary
 */
export interface EfficiencyMetrics {
	taskId: string;
	tokensPerCompletion: number;
	timeToComplete: number;
	agentEfficiency: Record<AgentType, number>;
	reworkRatio: number;
	successRate: number;
}

/**
 * Efficiency analytics aggregation
 */
export interface EfficiencyAnalytics {
	/** Total tasks processed */
	totalTasks: number;
	/** Overall success rate across all tasks */
	successRate: number;
	/** Average tokens used per successful completion */
	avgTokensPerCompletion: number;
	/** Average duration of tasks in milliseconds */
	avgDurationMs: number;
	/** Average number of agents spawned per task */
	avgAgentsSpawned: number;
	/** Most efficient agent type */
	mostEfficientAgentType: AgentType | null;
	/** Token usage breakdown by agent type */
	tokensByAgentType: Record<AgentType, { total: number; avgPerTask: number }>;
	/** Success rates per complexity level with escalation guidance */
	successRateByComplexity: Record<
		ComplexityLevel,
		{
			/** Success rate for this complexity level */
			rate: number;
			/** Total tasks at this complexity level */
			totalTasks: number;
			/** Average tokens used per task */
			avgTokensPerTask: number;
			/** Recommended escalation trigger threshold */
			escalationTrigger: number;
			/** Number of tasks that required escalation */
			escalatedCount: number;
			/** Success rate after escalation */
			escalationSuccessRate: number;
			/** Average additional tokens spent due to escalation */
			escalationTokenOverhead: number;
		}
	>;
	/** Analysis time period */
	analysisPeriod: {
		from: Date;
		to: Date;
	};
}

/**
 * Loadout recommendation result
 */
export interface LoadoutRecommendation {
	loadoutId: string;
	score: number;
	reason: string;
	expectedTokens: number;
	expectedDuration: number;
	confidence: number;
}

// ============== Git Worktree Types ==============

/**
 * Information about an active worktree for a session
 */
export interface WorktreeInfo {
	/** The session ID this worktree belongs to */
	sessionId: string;
	/** Absolute path to the worktree directory */
	path: string;
	/** Branch name for this worktree */
	branch: string;
	/** When the worktree was created */
	createdAt: Date;
	/** Whether the worktree is currently active */
	isActive: boolean;
}

/**
 * State tracking for git worktrees
 */
export interface WorktreeState {
	/** Active worktrees by session ID */
	worktrees: Record<string, WorktreeInfo>;
	/** Last updated timestamp */
	lastUpdated: Date;
}

/**
 * Information about a preserved failed worktree for investigation
 */
export interface FailedWorktreeInfo {
	/** Task ID */
	taskId: string;
	/** Task description */
	task: string;
	/** Absolute path to the worktree directory */
	worktreePath: string;
	/** Branch name */
	branch: string;
	/** When the task failed */
	failedAt: string;
	/** Error message or reason for failure */
	error: string;
	/** Model used */
	model: string;
	/** Number of attempts made */
	attempts: number;
}

/**
 * State tracking for preserved failed worktrees
 */
export interface FailedWorktreeState {
	/** Preserved failed worktrees (most recent first) */
	worktrees: FailedWorktreeInfo[];
	/** Maximum number of worktrees to preserve */
	maxPreserved: number;
	/** Last updated timestamp */
	lastUpdated: string;
}

// ============== Parallel Recovery Types ==============

/**
 * Task state for parallel recovery
 */
export interface ParallelTaskState {
	/** Task ID */
	taskId: string;
	/** Task description */
	task: string;
	/** Worktree path */
	worktreePath: string;
	/** Branch name */
	branch: string;
	/** Task status */
	status: "pending" | "running" | "complete" | "failed" | "merged";
	/** Error message if failed */
	error?: string;
	/** Modified files if completed */
	modifiedFiles?: string[];
	/** Started timestamp */
	startedAt?: Date;
	/** Completed timestamp */
	completedAt?: Date;
	/** Checkpoint from previous run (for crash recovery) */
	previousCheckpoint?: TaskCheckpoint;
}

/**
 * Recovery state for Orchestrator
 * Simpler than Session recovery - just tracks batch state for resume
 */
export interface ParallelRecoveryState {
	/** Unique batch ID */
	batchId: string;
	/** When the batch started */
	startedAt: Date;
	/** All tasks in the batch */
	tasks: ParallelTaskState[];
	/** Model being used */
	model: "haiku" | "sonnet" | "opus";
	/** Options used for this batch */
	options: {
		maxConcurrent: number;
		autoCommit: boolean;
		reviewPasses: boolean;
		multiLensAtOpus: boolean;
	};
	/** Whether batch is complete */
	isComplete: boolean;
	/** Last updated timestamp */
	lastUpdated: Date;
}

// ============== Atomic Recovery Types ==============
// Directory-based recovery for crash safety

/**
 * Batch metadata stored separately from per-task state.
 * Lives at .undercity/batch-meta.json
 */
export interface BatchMetadata {
	/** Unique batch ID */
	batchId: string;
	/** When the batch started */
	startedAt: Date;
	/** Model tier for this batch */
	model: ModelChoice;
	/** Options used for this batch */
	options: {
		maxConcurrent: number;
		autoCommit: boolean;
		reviewPasses: boolean;
		multiLensAtOpus: boolean;
	};
}

/**
 * Per-task state file stored atomically.
 * Lives at .undercity/active/{taskId}.state
 */
export interface ActiveTaskState {
	/** Task ID */
	taskId: string;
	/** Task description/objective */
	task: string;
	/** Worktree path */
	worktreePath: string;
	/** Branch name */
	branch: string;
	/** Task status */
	status: "pending" | "running";
	/** Batch ID this task belongs to */
	batchId: string;
	/** Started timestamp */
	startedAt?: Date;
	/** Checkpoint from previous run (for crash recovery) */
	previousCheckpoint?: TaskCheckpoint;
}

/**
 * Completed task state file.
 * Lives at .undercity/completed/{taskId}.done
 */
export interface CompletedTaskState {
	/** Task ID */
	taskId: string;
	/** Task description/objective */
	task: string;
	/** Final status */
	status: "complete" | "failed" | "merged";
	/** Batch ID this task belonged to */
	batchId: string;
	/** Completed timestamp */
	completedAt: Date;
	/** Error message if failed */
	error?: string;
	/** Modified files if completed */
	modifiedFiles?: string[];
}

// ============== Error Recovery Types ==============

// Self-Improvement Loop Types
export interface CompletionMetrics {
	sessionId: string;
	goal: string;
	completionTime: number;
	agentsInvolved: AgentType[];
	success: boolean;
}
/**
 * Task execution metrics
 */
export interface TaskExecutionMetrics {
	/** Unique identifier for the task */
	taskId: string;
	/** Timestamp when task started */
	startTime: Date;
	/** Timestamp when task completed */
	endTime?: Date;
	/** Whether the task was successful */
	success: boolean;
	/** Total tokens used */
	tokens: number;
	/** Model used for task execution */
	model: ModelChoice;
	/** Number of escalations/user interventions */
	escalations: number;
	/** Specific reasons for escalations */
	escalationReasons?: string[];
	/** Total time taken for task completion (in milliseconds) */
	timeTakenMs?: number;
	/** Session context */
	sessionId?: string;
}

export interface ImprovementTask {
	/** Unique identifier for the improvement task */
	id: string;
	/** Human-readable title */
	title: string;
	/** Detailed description of the improvement goal */
	description: string;
	/** Priority of the improvement */
	priority: "low" | "medium" | "high" | "critical";
	/** Category of improvement */
	category: "performance" | "quality" | "efficiency" | "reliability" | "usability";
	/** Data source for this task */
	dataSource: "metrics" | "patterns" | "manual";
	/** Evidence supporting this improvement task */
	evidence: string[];
	/** Estimated impact (0-100 score) */
	estimatedImpact: number;
	/** Estimated effort required */
	estimatedEffort: "low" | "medium" | "high";
	/** When the task was created */
	createdAt: Date;
}

/**
 * Prompt Knowledge tracking for institutional learning
 * Captures successful approaches and prompts per task type
 */
export interface PromptKnowledge {
	/** Unique hash identifier for this prompt/approach */
	id: string;
	/** Type of task this knowledge applies to */
	taskType: string;
	/** The original prompt or input */
	prompt: string;
	/** Successful approach or implementation details */
	approach: string;
	/** Performance metrics from successful execution */
	metrics: {
		/** Tokens used */
		tokensUsed: number;
		/** Execution time in milliseconds */
		executionTimeMs: number;
		/** Success rating (1-5) */
		successRating?: number;
		/** Human satisfaction score (1-5) for DSPy evaluation */
		humanSatisfactionScore?: number;
		/** Error categories encountered (for prompt quality analysis) */
		errorCategories?: string[];
		/** Whether this prompt required human intervention */
		requiredHumanIntervention?: boolean;
	};
	/** Metadata tags for searchability */
	tags: string[];
	/** When this knowledge was first recorded */
	recordedAt: Date;
	/** Number of times this approach has been successful */
	successCount: number;
}

// ============== Experiment Framework Types ==============

/**
 * An experiment variant configuration
 */
export interface ExperimentVariant {
	/** Unique variant identifier */
	id: string;
	/** Human-readable name */
	name: string;
	/** Model to use for this variant */
	model: "haiku" | "sonnet" | "opus";
	/** Additional prompt context/instructions */
	promptModifier?: string;
	/** Whether review passes are enabled */
	reviewEnabled?: boolean;
	/** Weight for random assignment (higher = more likely) */
	weight: number;
}

/**
 * Result of a single task execution in an experiment
 */
export interface ExperimentTaskResult {
	/** Task ID */
	taskId: string;
	/** Variant used for this task */
	variantId: string;
	/** Whether task succeeded */
	success: boolean;
	/** Execution time in milliseconds */
	durationMs: number;
	/** Total tokens used */
	tokensUsed: number;
	/** Number of attempts before success/failure */
	attempts: number;
	/** Error categories if failed */
	errorCategories?: string[];
	/** Timestamp */
	timestamp: Date;
}

/**
 * An experiment definition
 */
export interface Experiment {
	/** Unique experiment identifier */
	id: string;
	/** Human-readable name */
	name: string;
	/** Description of what we're testing */
	description: string;
	/** Variants being tested */
	variants: ExperimentVariant[];
	/** Whether experiment is active */
	isActive: boolean;
	/** Created timestamp */
	createdAt: Date;
	/** Results collected */
	results: ExperimentTaskResult[];
}

/**
 * Aggregated metrics for a variant
 */
export interface VariantMetrics {
	/** Variant ID */
	variantId: string;
	/** Total tasks assigned */
	totalTasks: number;
	/** Successful tasks */
	successCount: number;
	/** Success rate (0-1) */
	successRate: number;
	/** Average duration in ms */
	avgDurationMs: number;
	/** Average tokens per task */
	avgTokensPerTask: number;
	/** Average attempts per task */
	avgAttempts: number;
}

/**
 * Experiment storage structure
 */
export interface ExperimentStorage {
	/** All experiments */
	experiments: Experiment[];
	/** Currently active experiment ID */
	activeExperimentId?: string;
	/** Last updated timestamp */
	lastUpdated: Date;
}

// ============================================================================
// Meta-Task Types
// ============================================================================
// Meta-tasks are tasks that operate on the task board itself (triage, prune,
// plan decomposition, etc.). They return recommendations instead of making
// direct mutations. The orchestrator processes these recommendations.

/**
 * Types of meta-tasks that can operate on the task board
 */
export type MetaTaskType = "triage" | "prune" | "plan" | "prioritize" | "generate";

/**
 * Actions that can be recommended by meta-tasks
 */
export type MetaTaskAction =
	| "remove" // Delete a task
	| "complete" // Mark task as complete
	| "fix_status" // Fix inconsistent status
	| "merge" // Merge duplicate tasks
	| "add" // Add new task(s)
	| "update" // Update task fields
	| "prioritize" // Change task priority
	| "decompose" // Decompose into subtasks
	| "block" // Mark task as blocked
	| "unblock"; // Unblock a task

/**
 * Individual recommendation from a meta-task
 */
export interface MetaTaskRecommendation {
	/** The action to take */
	action: MetaTaskAction;
	/** Target task ID (for actions on existing tasks) */
	taskId?: string;
	/** Related task IDs (for merge, dependencies) */
	relatedTaskIds?: string[];
	/** Reason for this recommendation */
	reason: string;
	/** Confidence score (0-1) */
	confidence: number;
	/** New task data (for add action) */
	newTask?: {
		objective: string;
		priority?: number;
		tags?: string[];
		dependsOn?: string[];
	};
	/** Updated fields (for update action) */
	updates?: {
		objective?: string;
		priority?: number;
		tags?: string[];
		status?: string;
	};
}

/**
 * Result returned by a meta-task
 */
export interface MetaTaskResult {
	/** Type of meta-task that produced this result */
	metaTaskType: MetaTaskType;
	/** Recommendations for task board changes */
	recommendations: MetaTaskRecommendation[];
	/** Summary of analysis performed */
	summary: string;
	/** Health metrics (for triage) */
	metrics?: {
		healthScore?: number;
		issuesFound?: number;
		tasksAnalyzed?: number;
	};
}

// ============== Task Assignment (Work Hook) ==============

/**
 * Task assignment written to worktree before worker starts.
 * Survives crashes and enables worker identity detection.
 */
export interface TaskAssignment {
	/** Unique identifier for this task */
	taskId: string;
	/** The task objective */
	objective: string;
	/** Git branch for this task */
	branch: string;
	/** Model tier to use */
	model: ModelChoice;
	/** Absolute path to the worktree */
	worktreePath: string;
	/** When the assignment was created */
	assignedAt: Date;
	/** Maximum attempts allowed */
	maxAttempts: number;
	/** Whether review passes are enabled */
	reviewPasses: boolean;
	/** Whether to auto-commit on success */
	autoCommit: boolean;
	/** Experiment variant ID if assigned */
	experimentVariantId?: string;
	/** Current checkpoint (for crash recovery) */
	checkpoint?: TaskCheckpoint;
}

/**
 * Checkpoint for crash recovery within a task
 */
export interface TaskCheckpoint {
	/** Last known phase */
	phase: "starting" | "context" | "executing" | "verifying" | "reviewing" | "committing";
	/** Model at time of checkpoint */
	model: ModelChoice;
	/** Number of attempts so far */
	attempts: number;
	/** When checkpoint was saved */
	savedAt: Date;
	/** Last verification result if any */
	lastVerification?: {
		passed: boolean;
		errors?: string[];
	};
}

/**
 * Project profile for configurable verification
 */
export interface ProjectProfile {
	/** Package manager (npm, yarn, pnpm, bun) */
	packageManager: "npm" | "yarn" | "pnpm" | "bun";
	/** Verification commands */
	commands: {
		typecheck: string;
		test: string;
		lint: string;
		build: string;
	};
	/** Detected tooling info */
	detected: {
		hasTypescript: boolean;
		testRunner: "vitest" | "jest" | "mocha" | "none";
		linter: "biome" | "eslint" | "none";
		buildTool: "tsc" | "vite" | "webpack" | "esbuild" | "none";
	};
	/** When profile was created */
	createdAt: Date;
	/** When profile was last updated */
	updatedAt: Date;
}

// ============== Research ROI Types ==============

/**
 * Outcome of a research task
 *
 * - implement: Research yielded actionable proposals
 * - no_go: Research indicates feature/direction not worth implementing
 * - insufficient: More research needed, gaps identified
 * - absorbed: Topic already well-covered in existing knowledge
 */
export type ResearchOutcomeType = "implement" | "no_go" | "insufficient" | "absorbed";

/**
 * Conclusion from a research task
 * Stored on tasks with research prefixes
 */
export interface ResearchConclusion {
	/** The outcome of the research */
	outcome: ResearchOutcomeType;
	/** Explanation of why this conclusion was reached */
	rationale: string;
	/** How novel the findings were (0 = all duplicates, 1 = all new) */
	noveltyScore: number;
	/** Number of actionable proposals generated */
	proposalsGenerated: number;
	/** ID of the decision record (for no_go decisions) */
	linkedDecisionId?: string;
	/** IDs of implementation tasks spawned (for implement outcome) */
	linkedTaskIds?: string[];
	/** When the conclusion was recorded */
	concludedAt: string;
}

/**
 * ROI signals gathered for research assessment
 */
export interface ResearchROISignals {
	/** Are findings getting less novel? (0-1, lower = diminishing returns) */
	noveltyTrend: number;
	/** Actionable proposals per research cycle */
	proposalYield: number;
	/** How often are we making same decisions? (0-1, higher = repetitive) */
	decisionRepetition: number;
	/** What % of new learnings are duplicates? (0-1, higher = saturated) */
	knowledgeSaturation: number;
}

/**
 * Recommendation from ROI assessment
 */
export type ResearchROIRecommendation = "continue_research" | "start_implementing" | "conclude_no_go" | "mark_absorbed";

/**
 * Result of assessing research ROI
 */
export interface ResearchROIAssessment {
	/** The recommended action */
	recommendation: ResearchROIRecommendation;
	/** Confidence in the recommendation (0-1) */
	confidence: number;
	/** The signals that informed this assessment */
	signals: ResearchROISignals;
	/** Human-readable explanation */
	rationale: string;
}

// ============== Task Ticket Types ==============

/**
 * Rich ticket content attached to a task.
 * Provides additional context beyond the single-line objective.
 *
 * This is a sub-part of a Task - the "ticket" is the detailed specification
 * while the "task" is the work item record (ID, status, priority, etc.).
 */
export interface TicketContent {
	/** Full description (markdown, separate from title/objective) */
	description?: string;
	/** Definition of done - conditions for completion */
	acceptanceCriteria?: string[];
	/** How to verify task was completed correctly */
	testPlan?: string;
	/** Implementation hints and approach suggestions */
	implementationNotes?: string;
	/** Source of this task */
	source?: "pm" | "user" | "research" | "codebase_gap" | "pattern_analysis";
	/** Research findings that informed this task */
	researchFindings?: string[];
	/** Rationale for why this task matters */
	rationale?: string;
}

/**
 * Types of issues triage can detect on a task
 */
export type TriageIssueType =
	| "test_cruft" // Matches test task patterns
	| "duplicate" // Similar to another task
	| "stale" // Old and not progressing
	| "status_bug" // Status inconsistency (e.g., pending with completedAt)
	| "overly_granular" // Too many similar tasks
	| "vague" // Objective lacks specificity
	| "orphaned" // Parent completed but subtask pending
	| "over_decomposed" // Too many subtasks
	| "research_no_output" // Research task unlikely to produce code
	| "generic_error_handling" // Generic error handling without target
	| "needs_refinement" // Lacks rich ticket content
	| "failed_duplicate" // Failed task duplicates another task
	| "failed_objective_completed" // Failed task objective was achieved by other task
	| "failed_retriable" // Failed task with transient error (can be re-queued)
	| "failed_permanent"; // Failed task with permanent error (should be pruned)

/**
 * Recommended action for a triage issue
 */
export type TriageAction = "remove" | "merge" | "fix" | "review" | "refine" | "requeue";

/**
 * A triage issue detected on a task
 */
export interface TriageIssue {
	/** Type of issue */
	type: TriageIssueType;
	/** Human-readable explanation */
	reason: string;
	/** Recommended action */
	action: TriageAction;
	/** Related task IDs (for duplicates, etc.) */
	relatedTaskIds?: string[];
	/** When this issue was detected */
	detectedAt: Date;
}

/**
 * Summary of triage analysis stored in .undercity/triage-report.json
 */
export interface TriageReport {
	/** When triage was last run */
	timestamp: Date;
	/** Overall board health (0-100) */
	healthScore: number;
	/** Percentage of tasks with complete tickets */
	ticketCoverage: number;
	/** Count of issues by type */
	issueCount: Partial<Record<TriageIssueType, number>>;
	/** Total pending tasks at time of triage */
	pendingTasks: number;
	/** Total failed tasks at time of triage */
	failedTasks: number;
	/** Total tasks at time of triage */
	totalTasks: number;
	/** Failed task breakdown by failure reason */
	failureBreakdown?: Record<string, number>;
}

/**
 * Check if a task objective indicates a meta-task
 * Meta-tasks are prefixed with [meta:type]
 */
export function isMetaTask(objective: string): boolean {
	return /^\[meta:(triage|prune|plan|prioritize|generate)\]/i.test(objective);
}

/**
 * Extract meta-task type from objective
 */
export function getMetaTaskType(objective: string): MetaTaskType | null {
	const match = objective.match(/^\[meta:(triage|prune|plan|prioritize|generate)\]/i);
	return match ? (match[1].toLowerCase() as MetaTaskType) : null;
}
