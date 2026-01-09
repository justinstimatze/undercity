/**
 * Undercity
 *
 * Multi-agent orchestrator for Claude Max - Gas Town for budget extraction.
 *
 * Inspired by:
 * - Gas Town (Steve Yegge) - Multi-agent orchestration
 * - BMAD-METHOD - Planning before execution
 * - ARC Raiders - Extraction shooter mechanics (undercity/topside)
 *
 * @see https://github.com/steveyegge/gastown
 * @see https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04
 */

// Core types
export type {
	AgentDefinition,
	AgentType,
	Inventory,
	Loadout,
	MergeQueueItem,
	MergeStatus,
	Raid,
	RaidStatus,
	SafePocket,
	SquadMember,
	SquadMemberStatus,
	Stash,
	Task,
	TaskStatus,
	UndercityConfig,
} from "./types.js";

// Persistence layer
export { Persistence } from "./persistence.js";

// Squad management
export {
	SQUAD_AGENTS,
	createSquadMember,
	determineAgentType,
	generateSquadMemberId,
	getAgentDefinition,
	getAllAgentDefinitions,
} from "./squad.js";

// Git operations
export {
	GitError,
	MergeQueue,
	branchExists,
	checkoutBranch,
	createAndCheckout,
	createBranch,
	deleteBranch,
	generateBranchName,
	getCurrentBranch,
	getDefaultBranch,
	isWorkingTreeClean,
	merge,
	rebase,
	runTests,
	stash,
	stashPop,
} from "./git.js";

// Raid orchestration
export { RaidOrchestrator } from "./raid.js";
