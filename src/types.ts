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
	| "planning" // BMAD phase: Scout + Planner working
	| "awaiting_approval" // Human needs to approve the plan
	| "executing" // Gas Town phase: Fabricators working
	| "reviewing" // Auditor checking work
	| "merging" // Serial merge queue processing
	| "extracting" // Final extraction in progress
	| "complete" // Successfully extracted
	| "failed"; // Something went wrong

/**
 * A Raid is a work session with a goal.
 * Raiders (agents) go topside (into the codebase) to complete tasks.
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
 * - Scout: Fast recon (Haiku)
 * - Planner: BMAD-style spec writer (Sonnet)
 * - Fabricator: Code builder (Sonnet)
 * - Auditor: Quality reviewer (Opus)
 */
export type AgentType = "scout" | "planner" | "fabricator" | "auditor";

/**
 * Task status within a raid
 */
export type TaskStatus =
	| "pending" // Not yet started
	| "assigned" // Assigned to an agent
	| "in_progress" // Agent is working
	| "complete" // Successfully done
	| "failed" // Something went wrong
	| "blocked"; // Waiting on something

/**
 * A Task is a unit of work assigned to an agent
 */
export interface Task {
	id: string;
	raidId: string;
	type: AgentType;
	description: string;
	status: TaskStatus;
	agentId?: string;
	branch?: string;
	result?: string;
	error?: string;
	createdAt: Date;
	completedAt?: Date;
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
	task?: Task;
	status: SquadMemberStatus;
	spawnedAt: Date;
	lastActivityAt: Date;
}

/**
 * Persistence hierarchy (from ARC Raiders):
 * - Pocket: Critical state surviving crashes (raid ID, goal, status)
 * - Inventory: Active state during raid (agent sessions, tasks)
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
	tasks: Task[];
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
 * Git merge status for serial queue
 */
export type MergeStatus =
	| "pending" // Waiting in queue
	| "rebasing" // Currently rebasing
	| "testing" // Running tests
	| "merging" // Actually merging
	| "complete" // Successfully merged
	| "conflict" // Needs manual resolution
	| "test_failed"; // Tests failed

export interface MergeQueueItem {
	branch: string;
	taskId: string;
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
 * Configuration options for merge queue retry behavior
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
 * File tracking state for an agent/task
 */
export interface FileTrackingEntry {
	/** The agent ID that touched these files */
	agentId: string;
	/** The task ID associated with this agent */
	taskId: string;
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
		taskId: string;
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
 * A cached scout result entry
 */
export interface ScoutCacheEntry {
	/** SHA-256 hash of CodebaseFingerprint for quick lookup */
	fingerprintHash: string;
	/** The cached scout intel result */
	scoutResult: string;
	/** Hash of the scout goal for per-goal caching */
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
