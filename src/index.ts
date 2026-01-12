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
export { Orchestrator } from "./orchestrator.js";
// Output system
export {
	configureOutput,
	createProgressTracker,
	debug,
	error,
	getOutputMode,
	header,
	info,
	isHumanMode,
	keyValue,
	list,
	metrics,
	type OutputEvent,
	type OutputMode,
	progress,
	section,
	status,
	success,
	summary,
	taskComplete,
	taskFailed,
	taskStart,
	warning,
} from "./output.js";
// Performance management
export { getPerformanceManager } from "./performance-manager.js";
// Persistence layer
export { Persistence } from "./persistence.js";
// HTTP Server
export {
	clearDaemonState,
	type DaemonState,
	getDaemonState,
	isDaemonRunning,
	queryDaemon,
	type ServerConfig,
	saveDaemonState,
	UndercityServer,
} from "./server.js";
// Squad management
export {
	createAgent,
	determineAgentType,
	generateAgentId,
	getAgentDefinition,
	getAllAgentDefinitions,
	SQUAD_AGENTS,
} from "./squad.js";
// Core types
export type {
	Agent,
	AgentDefinition,
	AgentStatus,
	AgentType,
	ElevatorItem,
	Inventory,
	Loadout,
	MergeStatus,
	SafePocket,
	SessionStatus,
	Step,
	StepStatus,
	UndercityConfig,
} from "./types.js";
export { TaskWorker } from "./worker.js";
// Experiment framework
export { ExperimentManager, getExperimentManager } from "./experiment.js";
export type {
	Experiment,
	ExperimentStorage,
	ExperimentTaskResult,
	ExperimentVariant,
	VariantMetrics,
} from "./types.js";
