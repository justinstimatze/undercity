/**
 * Undercity Types
 *
 * Core type definitions for the multi-agent orchestrator.
 * Inspired by Gas Town (Steve Yegge) and ARC Raiders extraction mechanics.
 */

/**
 * Raid status - the overall state of a work session
 */
export type RaidStatus =
	| "planning" // BMAD phase: Flute + Logistics working
	| "awaiting_approval" // Human needs to approve the plan
	| "executing" // Gas Town phase: Fabricators working
	| "reviewing" // Sheriff checking work
	| "merging" // Serial elevator processing
	| "extracting" // Final extraction in progress
	| "complete" // Successfully extracted
	| "failed"; // Something went wrong

/**
 * A Raid is a work session with a goal.
 * Raiders (agents) go topside (into the codebase) to complete waypoints.
 */
export interface Raid {
	id: string;
	goal: string;
	status: RaidStatus;
	startedAt: Date;
	completedAt?: Date;
	planApproved: boolean;
	planSummary?: string;
	branch?: string;
}

/**
 * Agent types in the squad
 * - Flute: Fast recon (Haiku)
 * - Logistics: BMAD-style spec writer (Sonnet)
 * - Quester: Code builder (Sonnet)
 * - Sheriff: Quality reviewer (Opus)
 */
export type AgentType = "flute" | "logistics" | "quester" | "sheriff";

/**
 * Waypoint status within a raid
 */
export type WaypointStatus =
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
 * A Waypoint is a unit of work assigned to an agent during a raid
 */
export interface Waypoint {
	id: string;
	raidId: string;
	type: AgentType;
	description: string;
	status: WaypointStatus;
	agentId?: string;
	branch?: string;
	result?: string;
	error?: string;
	createdAt: Date;
	completedAt?: Date;
	/** Checkpoint data for recovery */
	checkpoint?: WaypointCheckpoint;
	/** Recovery attempt count */
	recoveryAttempts?: number;
	/** Maximum recovery attempts allowed */
	maxRecoveryAttempts?: number;
}

/**
 * Squad member status
 */
export type SquadMemberStatus = "idle" | "working" | "done" | "error" | "stuck";

/**
 * A SquadMember is an active agent working on the raid
 */
export interface SquadMember {
	id: string;
	type: AgentType;
	sessionId?: string; // Claude SDK session ID for resumption
	waypoint?: Waypoint;
	status: SquadMemberStatus;
	spawnedAt: Date;
	lastActivityAt: Date;
}

/**
 * Persistence hierarchy (from ARC Raiders):
 * - Pocket: Critical state surviving crashes (raid ID, goal, status)
 * - Inventory: Active state during raid (agent sessions, waypoints)
 * - Loadout: Pre-raid config (agent types, rules)
 * - Stash: Long-term storage between raids
 */
export interface SafePocket {
	raidId?: string;
	raidGoal?: string;
	raidStatus?: RaidStatus;
	checkpoint?: string;
	lastUpdated: Date;
}

export interface Inventory {
	raid?: Raid;
	waypoints: Waypoint[];
	squad: SquadMember[];
	lastUpdated: Date;
}

export interface Loadout {
	maxSquadSize: number;
	enabledAgentTypes: AgentType[];
	autoApprove: boolean; // Skip human approval for plan
	lastUpdated: Date;
}

export interface Stash {
	completedRaids: Array<{
		id: string;
		goal: string;
		completedAt: Date;
		success: boolean;
	}>;
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
	| "complete" // Successfully merged
	| "conflict" // Needs manual resolution
	| "test_failed"; // Tests failed

export interface ElevatorItem {
	branch: string;
	waypointId: string;
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
	maxSquadSize: number;
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

// ============== Flute Cache Types ==============

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
 * File tracking state for an agent/waypoint
 */
export interface FileTrackingEntry {
	/** The agent ID that touched these files */
	agentId: string;
	/** The waypoint ID associated with this agent */
	waypointId: string;
	/** The raid ID this belongs to */
	raidId: string;
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
		waypointId: string;
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
export interface FluteCacheEntry {
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
 * Flute cache storage structure
 */
export interface FluteCache {
	/** Cache entries keyed by combined fingerprintHash + goalHash */
	entries: Record<string, FluteCacheEntry>;
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
	flute: "haiku" | "sonnet" | "opus";
	logistics: "haiku" | "sonnet" | "opus";
	quester: "haiku" | "sonnet" | "opus";
	sheriff: "haiku" | "sonnet" | "opus";
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
	maxSquadSize: number;
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
 * Performance record for a loadout on a specific quest
 */
export interface LoadoutPerformanceRecord {
	/** The loadout ID used */
	loadoutId: string;
	/** The quest ID */
	questId: string;
	/** Quest type/category if known */
	questType?: string;
	/** Whether the quest succeeded */
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
	/** Number of quests completed with this loadout */
	questCount: number;
	/** Success rate (0-1) */
	successRate: number;
	/** Average tokens per quest */
	avgTokensPerQuest: number;
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

// ============== Quest Matchmaking Types ==============

/**
 * Cross-quest conflict detection
 * NEW: Types for parallel quest execution
 */
export interface CrossQuestConflict {
	questIds: string[];
	conflictingFiles: string[];
	severity: "warning" | "error" | "critical";
}

/**
 * Quest batch execution result
 * NEW: Result tracking for parallel quest execution
 */
export interface QuestBatchResult {
	completedQuests: string[];
	failedQuests: string[];
	totalDuration: number;
	conflicts: CrossQuestConflict[];
}

/**
 * Quest set metadata
 * NEW: Metadata for quest batching
 */
export interface QuestSetMetadata {
	questIds: string[];
	raidIds: string[];
	startedAt: Date;
	estimatedDuration: number;
	riskLevel: "low" | "medium" | "high";
}

// ============== Metrics and Rate Limit Types ==============

/**
 * Quest types for categorization
 */
export type QuestType = "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore" | "unknown";

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
 * Quest-level usage tracking
 */
export interface QuestUsage {
	questId: string;
	raidId?: string;
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
}

/**
 * Rate limit state
 */
export interface RateLimitState {
	quests: QuestUsage[];
	rateLimitHits: RateLimitHit[];
	config: RateLimitConfig;
	lastUpdated: Date;
	/** Current pause state */
	pause: RateLimitPause;
}

/**
 * Quest metrics for efficiency tracking
 */
export interface QuestMetrics {
	questId: string;
	raidId: string;
	objective: string;
	success: boolean;
	durationMs: number;
	totalTokens: number;
	agentsSpawned: number;
	agentTypes: AgentType[];
	startedAt: Date;
	completedAt: Date;
	error?: string;
}

/**
 * Efficiency metrics summary
 */
export interface EfficiencyMetrics {
	questId: string;
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
	totalQuests: number;
	successRate: number;
	avgTokensPerCompletion: number;
	avgDurationMs: number;
	avgAgentsSpawned: number;
	mostEfficientAgentType: AgentType | null;
	tokensByAgentType: Record<AgentType, { total: number; avgPerQuest: number }>;
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
 * First-order efficiency metrics (direct quest completion)
 */
export interface FirstOrderEfficiency {
	/** Initial tokens used for successful completion */
	tokensUsed: number;
	/** Time to first successful completion */
	timeToComplete: number;
	/** Was the quest successful on first attempt */
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
 * Efficiency outcome for A/B testing
 */
export interface EfficiencyOutcome {
	/** Unique identifier for this outcome */
	id: string;
	/** Quest ID this outcome relates to */
	questId: string;
	/** Raid ID this outcome relates to */
	raidId: string;
	/** Experiment ID if part of an A/B test */
	experimentId?: string;
	/** Variant name if part of an A/B test */
	variantName?: string;
	/** Parallelism level used (linear vs swarm mode) */
	parallelismLevel: ParallelismLevel;
	/** Quest objective/description */
	objective: string;
	/** First-order efficiency metrics */
	firstOrder: FirstOrderEfficiency;
	/** Second-order efficiency metrics */
	secondOrder: SecondOrderEfficiency;
	/** Agents used in this quest execution */
	agentsUsed: AgentType[];
	/** Model choices used */
	modelChoices: LoadoutModelChoices;
	/** Whether the quest ultimately succeeded */
	finalSuccess: boolean;
	/** When this outcome was recorded */
	recordedAt: Date;
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
 * Information about an active worktree for a raid
 */
export interface WorktreeInfo {
	/** The raid ID this worktree belongs to */
	raidId: string;
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
	/** Active worktrees by raid ID */
	worktrees: Record<string, WorktreeInfo>;
	/** Last updated timestamp */
	lastUpdated: Date;
}

// ============== Error Recovery Types ==============

/**
 * Failure severity levels for escalation
 */
export type FailureSeverity = "low" | "medium" | "high" | "critical";

/**
 * Recovery strategy types
 */
export type RecoveryStrategy =
	| "retry" // Simple retry with same agent
	| "different_agent" // Retry with different agent type
	| "checkpoint_restore" // Restore from checkpoint
	| "escalate" // Human intervention needed
	| "abandon"; // Give up on waypoint

/**
 * Error classification for recovery decisions
 */
export interface ErrorClassification {
	/** Error type category */
	type: "rate_limit" | "timeout" | "tool_error" | "validation_error" | "crash" | "unknown";
	/** Severity assessment */
	severity: FailureSeverity;
	/** Whether error is likely temporary */
	isTransient: boolean;
	/** Whether error affects other agents */
	affectsOthers: boolean;
	/** Recommended recovery strategy */
	recommendedStrategy: RecoveryStrategy;
}

/**
 * Checkpoint data for waypoint recovery
 */
export interface WaypointCheckpoint {
	/** When checkpoint was created */
	createdAt: Date;
	/** Partial progress description */
	progressDescription: string;
	/** Files modified so far */
	modifiedFiles: string[];
	/** Agent session data if available */
	agentSessionData?: string;
	/** Work completed percentage (0-100) */
	completionPercent: number;
	/** Important context to preserve */
	context: string;
	/** Risk level assessment */
	riskLevel: "low" | "medium" | "high";
}

/**
 * Recovery attempt record
 */
export interface RecoveryAttempt {
	/** Attempt number */
	attemptNumber: number;
	/** When recovery was attempted */
	attemptedAt: Date;
	/** Strategy used */
	strategy: RecoveryStrategy;
	/** Agent type used for recovery */
	agentType: AgentType;
	/** Whether attempt succeeded */
	successful: boolean;
	/** Error if attempt failed */
	error?: string;
	/** Time spent on recovery */
	durationMs: number;
}

/**
 * Agent-specific recovery configuration
 */
export interface AgentRecoveryConfig {
	/** Maximum retry attempts */
	maxRetries: number;
	/** Whether checkpoints are enabled */
	checkpointsEnabled: boolean;
	/** Checkpoint interval in minutes */
	checkpointIntervalMinutes: number;
	/** Timeout before considering agent stuck (minutes) */
	timeoutMinutes: number;
}

/**
 * Recovery orchestrator state
 */
export interface RecoveryState {
	/** Active recovery attempts by waypoint ID */
	activeRecoveries: Record<string, RecoveryAttempt[]>;
	/** Agent-specific recovery configurations */
	agentConfigs: Record<AgentType, AgentRecoveryConfig>;
	/** Global recovery statistics */
	stats: {
		totalRecoveries: number;
		successfulRecoveries: number;
		escalations: number;
		lastUpdated: Date;
	};
}
