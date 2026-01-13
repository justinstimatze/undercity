/**
 * Undercity - Centralized Export Module
 *
 * @module index
 * @description Comprehensive module serving as the single entry point for Undercity's core functionality
 *
 * This module aggregates and re-exports key components across the Undercity ecosystem:
 * - Capability ledger for tracking model performance and routing
 * - Git operations for branch and repository management
 * - Live metrics for real-time system monitoring
 * - Orchestration primitives for task execution and worker management
 * - Structured output and logging systems
 * - Core type definitions and interfaces
 *
 * Architecture Inspirations:
 * - Gas Town (Steve Yegge) - Multi-agent autonomous orchestration
 * - BMAD-METHOD - Iterative, planning-first execution strategy
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
