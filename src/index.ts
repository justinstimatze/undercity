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

// Capability ledger (model performance tracking)
export {
	type CapabilityLedger,
	getLedgerStats,
	getRecommendedModel,
	loadLedger,
	type ModelRecommendation,
	type PatternStats,
	updateLedger,
} from "./capability-ledger.js";
// Experiment framework
export { ExperimentManager, getExperimentManager } from "./experiment.js";
// Git operations
export {
	branchExists,
	checkoutBranch,
	createAndCheckout,
	createBranch,
	deleteBranch,
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
// Merge queue (extracted from git.ts)
export { MergeQueue } from "./merge-queue.js";
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
// Persistence layer
export {
	deleteTaskAssignment,
	detectAssignmentFromCwd,
	Persistence,
	readTaskAssignment,
	updateTaskCheckpoint,
	writeTaskAssignment,
} from "./persistence.js";
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
	ActiveTaskState,
	Agent,
	AgentDefinition,
	AgentStatus,
	AgentType,
	BatchMetadata,
	CompletedTaskState,
	Experiment,
	ExperimentStorage,
	ExperimentTaskResult,
	ExperimentVariant,
	Inventory,
	Loadout,
	MergeQueueItem,
	MergeStatus,
	SafePocket,
	SessionStatus,
	Step,
	StepStatus,
	TaskAssignment,
	TaskCheckpoint,
	UndercityConfig,
	VariantMetrics,
} from "./types.js";
export { TaskWorker } from "./worker.js";
