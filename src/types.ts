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
 * - Planner: BMAD-style spec writer (Opus)
 * - Fabricator: Code builder (Opus)
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
export type SquadMemberStatus = "idle" | "working" | "done" | "error";

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
