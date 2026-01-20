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
// Vector Embeddings
export {
	calculateVector,
	cosineSimilarity,
	type EmbeddingStats,
	embedAllLearnings,
	embedLearning,
	getEmbeddingStats,
	hybridSearch,
	type SparseVector,
	searchBySemanticSimilarity,
	tokenize,
} from "./embeddings.js";
// Emergency mode (main branch CI failure handling)
export {
	activateEmergencyMode,
	checkMainBranchHealth,
	deactivateEmergencyMode,
	type EmergencyModeState,
	generateFixTaskDescription,
	getEmergencyModeStatus,
	getFixAttemptCount,
	hasExceededMaxFixAttempts,
	isEmergencyModeActive,
	loadEmergencyState,
	MAX_FIX_ATTEMPTS,
	preMergeHealthCheck,
	recordFixWorkerCompleted,
	recordFixWorkerSpawned,
	saveEmergencyState,
	shouldSpawnFixWorker,
} from "./emergency-mode.js";
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
// Human input tracking (breaks retry loops with human guidance)
export {
	clearNeedsHumanInput,
	flagNeedsHumanInput,
	formatGuidanceForWorker,
	getHumanGuidance,
	getHumanInputStats,
	getTasksNeedingInput,
	type HumanGuidance,
	initHumanInputTables,
	markGuidanceUsed,
	type NeedsHumanInputState,
	saveHumanGuidance,
	shouldRequestHumanInput,
} from "./human-input-tracking.js";
// Intent completion (ambiguous objective detection and prediction)
export {
	formatPredictionDisplay,
	type InferredDetail,
	type IntentConfidence,
	type IntentPredictionResult,
	isAmbiguous,
	predictFullIntent,
	shouldSkipIntentCompletion,
} from "./intent-completion.js";
// Knowledge System
export {
	addLearning,
	findRelevantLearnings,
	formatLearningsForPrompt,
	getKnowledgeStats,
	type KnowledgeBase,
	type Learning,
	type LearningCategory,
	loadKnowledge,
	markLearningsUsed,
	pruneUnusedLearnings,
} from "./knowledge.js";
// Live metrics
export {
	type LiveMetrics,
	loadLiveMetrics,
	recordQueryResult,
	resetLiveMetrics,
	saveLiveMetrics,
} from "./live-metrics.js";
// MCP Protocol
export {
	handleMCPRequest,
	JSONRPCErrorCode,
	type JSONRPCErrorResponse,
	type JSONRPCRequest,
	type JSONRPCSuccessResponse,
	MCPProtocolHandler,
} from "./mcp-protocol.js";
// MCP Tools
export { knowledgeTools, type MCPTool, oracleTools } from "./mcp-tools.js";
// Merge queue (extracted from git.ts)
export { MergeQueue } from "./merge-queue.js";
// Metrics dashboard
export { launchMetricsDashboard } from "./metrics-dashboard.js";
// Names - Docker-style worker naming
export {
	generateWorkerName,
	getWorkerDisplayName,
	nameFromId,
	parseWorkerNameFromBranch,
	// Note: generateBranchName not exported - conflicts with git.ts version
} from "./names.js";
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
// SQLite Storage
export {
	autoMigrateIfNeeded,
	closeDatabase,
	type ErrorFix,
	type ErrorPattern,
	findMatchingFixFromDB,
	getAllLearnings,
	getCoModifiedFiles,
	getCorrelatedFiles,
	getDatabase,
	getErrorPattern,
	getFailurePatterns,
	getLearningById,
	getLearningsByCategory,
	getPendingDecisions,
	getStorageStats,
	type MigrationResult,
	migrateFromJSON,
	needsMigration,
	type PermanentFailure,
	recordPermanentFailureDB,
	recordTaskFile,
	resetDatabase,
	type StorageStats,
	saveDecision,
	saveDecisionResolution,
	searchLearningsByKeywords,
	searchResolvedDecisions,
	type TaskFileRecord,
	updateCoModification,
	updateKeywordCorrelation,
	updateLearningUsage,
	upsertErrorPattern,
	upsertLearning,
} from "./storage.js";
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
