/**
 * Undercity Types
 *
 * Core type definitions for the multi-agent orchestrator.
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
 * - Pocket: Critical state surviving crashes (session ID, goal, status)
 * - Inventory: Active state during session (agent sessions, steps)
 * - Loadout: Pre-session config (agent types, rules)
 */
export interface SafePocket {
	sessionId?: string;
	goal?: string;
	status?: SessionStatus;
	checkpoint?: string;
	lastUpdated: Date;
}

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
 * Git merge status for elevator
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

export interface ElevatorItem {
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
}

/**
 * Pre-merge conflict detection result
 * Flags when two queued branches modify the same files
 */
export interface ElevatorConflict {
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
 * Configuration options for elevator retry behavior
 */
export interface ElevatorRetryConfig {
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
export type ModelChoice = "haiku" | "sonnet" | "opus";

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
 */
export type ErrorCategory = "lint" | "typecheck" | "build" | "test" | "spell" | "no_changes" | "unknown";

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

// ============== A/B Efficiency Tracking Types ==============

/**
 * First-order efficiency metrics (direct task completion)
 */
export interface FirstOrderEfficiency {
	/** Initial tokens used for successful completion */
	tokensUsed: number;
	/** Time to first successful completion */
	timeToComplete: number;
	/** Was the task successful on first attempt */
	successfulFirstAttempt: boolean;
}

/**
 * Second-order efficiency metrics (including rework and corrections)
 */
export interface SecondOrderEfficiency {
	/** Total tokens including all rework attempts */
	totalTokens: number;
	/** Total time including all retry cycles */
	totalTime: number;
	/** Number of rework attempts required */
	reworkAttempts: number;
	/** Number of user interventions required */
	userInterventions: number;
	/** Time to stable completion (no further changes needed) */
	timeToStableCompletion: number;
}

/**
 * Efficiency outcome for tracking execution metrics
 */
export interface EfficiencyOutcome {
	/** Unique identifier for this outcome */
	id: string;
	/** Task ID this outcome relates to */
	taskId: string;
	/** Session ID this outcome relates to */
	sessionId: string;
	/** Parallelism level used (linear vs swarm mode) */
	parallelismLevel: ParallelismLevel;
	/** Task objective/description */
	objective: string;
	/** First-order efficiency metrics */
	firstOrder: FirstOrderEfficiency;
	/** Second-order efficiency metrics */
	secondOrder: SecondOrderEfficiency;
	/** Agents used in this task execution */
	agentsUsed: AgentType[];
	/** Model choices used */
	modelChoices: LoadoutModelChoices;
	/** Whether the task ultimately succeeded */
	finalSuccess: boolean;
	/** When this outcome was recorded */
	recordedAt: Date;
	/** Success rates per model complexity level */
	modelSuccessRates: Record<ModelChoice, number>;
}

/**
 * Efficiency comparison result for A/B analysis
 */
export interface EfficiencyComparison {
	/** Name of the comparison */
	name: string;
	/** Linear mode (sequential) results */
	linearMode: {
		sampleSize: number;
		avgFirstOrderTokens: number;
		avgSecondOrderTokens: number;
		avgReworkRate: number;
		avgTimeToStable: number;
		avgUserInterventions: number;
		successRate: number;
	};
	/** Swarm mode (parallel) results */
	swarmMode: {
		sampleSize: number;
		avgFirstOrderTokens: number;
		avgSecondOrderTokens: number;
		avgReworkRate: number;
		avgTimeToStable: number;
		avgUserInterventions: number;
		successRate: number;
	};
	/** Statistical significance tests */
	significance: {
		tokenEfficiencyPValue: number;
		reworkRatePValue: number;
		timeEfficiencyPValue: number;
		successRatePValue: number;
		overallSignificant: boolean;
	};
	/** Empirical model coefficients */
	model: {
		firstOrderMultiplier: number; // How much more tokens for first-order vs second-order
		reworkPenalty: number; // Token penalty per rework cycle
		parallelismBonus: number; // Time saved with parallel execution
		qualityTradeoff: number; // Success rate difference
	};
}

/**
 * Rework attempt tracking
 */
export interface ReworkAttempt {
	/** When the rework was attempted */
	timestamp: Date;
	/** Reason for rework (test failure, review feedback, etc) */
	reason: string;
	/** Agent that performed the rework */
	agentType: AgentType;
	/** Tokens used for this rework attempt */
	tokensUsed: number;
	/** Whether this rework resolved the issue */
	successful: boolean;
}

/**
 * User intervention tracking
 */
export interface UserIntervention {
	/** When the intervention occurred */
	timestamp: Date;
	/** Type of intervention */
	type: "approval_needed" | "conflict_resolution" | "clarification" | "manual_fix" | "direction_change";
	/** Description of what the user did */
	description: string;
	/** Time spent on the intervention (in milliseconds) */
	timeSpentMs: number;
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
}

/**
 * Recovery state for ParallelSoloOrchestrator
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
		annealingAtOpus: boolean;
	};
	/** Whether batch is complete */
	isComplete: boolean;
	/** Last updated timestamp */
	lastUpdated: Date;
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
