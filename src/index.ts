/**
 * Undercity
 *
 * Multi-agent orchestrator for Claude Max - Gas Town for normal people.
 *
 * Inspired by:
 * - Gas Town (Steve Yegge) - Multi-agent orchestration
 * - BMAD-METHOD - Planning before execution
 * - ARC Raiders - Extraction shooter mechanics (undercity/topside)
 *
 * @see https://github.com/steveyegge/gastown
 * @see https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04
 */

// Git operations
export {
	branchExists,
	checkoutBranch,
	createAndCheckout,
	createBranch,
	deleteBranch,
	Elevator,
	GitError,
	generateBranchName,
	getCurrentBranch,
	getDefaultBranch,
	isWorkingTreeClean,
	merge,
	pushToOrigin,
	rebase,
	runTests,
	stash,
	stashPop,
} from "./git.js";
// Live metrics
export {
	type LiveMetrics,
	loadLiveMetrics,
	recordQueryResult,
	resetLiveMetrics,
	saveLiveMetrics,
} from "./live-metrics.js";
// Orchestration
export { ParallelSoloOrchestrator } from "./parallel-solo.js";
// Performance management
export { getPerformanceManager } from "./performance-manager.js";
// Persistence layer
export { Persistence } from "./persistence.js";
export { SoloOrchestrator } from "./solo.js";
// Squad management
export {
	createSquadMember,
	determineAgentType,
	generateSquadMemberId,
	getAgentDefinition,
	getAllAgentDefinitions,
	SQUAD_AGENTS,
} from "./squad.js";
// Core types
export type {
	AgentDefinition,
	AgentType,
	ElevatorItem,
	Inventory,
	Loadout,
	MergeStatus,
	Raid,
	RaidStatus,
	SafePocket,
	SquadMember,
	SquadMemberStatus,
	Stash,
	UndercityConfig,
	Waypoint,
	WaypointStatus,
} from "./types.js";
