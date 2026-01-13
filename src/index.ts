/**
 * Undercity - Centralized Export Module
 *
 * @module index
 * @description Single entry point for Undercity core functionality
 *
 * Core exports include:
 * - Capability ledger (model performance tracking)
 * - Git operations and branch management
 * - Live metrics and dashboards
 * - Orchestration and worker management
 * - Output and logging systems
 * - Core type definitions
 *
 * References:
 * - Inspired by Gas Town (Steve Yegge) - Multi-agent orchestration
 * - BMAD-METHOD - Planning-first execution
 *
 * @see https://github.com/steveyegge/gastown
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
// Metrics dashboard
export { launchMetricsDashboard } from "./metrics-dashboard.js";
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
// DSPy-inspired prompt variants
export {
	ATOMICITY_PROMPT_VARIANTS,
	applyPromptVariant,
	BUILDER_PROMPT_VARIANTS,
	createPromptExperimentVariants,
	getAtomicityPrompt,
	getPromptVariant,
	getReviewPrompt,
	type PromptVariant,
	type PromptVariantId,
	REVIEW_PROMPT_VARIANTS,
} from "./prompt-variants.js";
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
	SessionRecovery,
	SessionStatus,
	Step,
	StepStatus,
	TaskAssignment,
	TaskCheckpoint,
	UndercityConfig,
	VariantMetrics,
} from "./types.js";
export { TaskWorker } from "./worker.js";
