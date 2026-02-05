/**
 * Grind Module Types
 *
 * Shared types for the grind execution system.
 */

import type { Task } from "../task.js";

/**
 * CLI options passed to grind command
 */
export interface GrindOptions {
	count?: string;
	parallel?: string;
	model?: string;
	commit?: boolean;
	stream?: boolean;
	verbose?: boolean;
	review?: boolean;
	push?: boolean;
	decompose?: boolean;
	postmortem?: boolean;
	duration?: string;
	taskId?: string;
	maxAttempts?: string;
	maxRetriesPerTier?: string;
	maxReviewPasses?: string;
	maxOpusReviewPasses?: string;
	maxDecompositionDepth?: string;
	maxTier?: string;
	dryRun?: boolean;
	continuous?: string | boolean;
}

/**
 * Parsed and validated grind configuration
 */
export interface GrindConfig {
	maxCount: number;
	parallelism: number;
	maxAttempts?: number;
	maxRetriesPerTier?: number;
	maxReviewPassesPerTier?: number;
	maxOpusReviewPasses?: number;
	maxDecompositionDepth: number;
	maxTier?: "sonnet" | "opus";
	startingModel: "sonnet" | "opus";
	autoCommit: boolean;
	stream: boolean;
	verbose: boolean;
	reviewPasses: boolean;
	pushOnSuccess: boolean;
	decompose: boolean;
	postmortem: boolean;
	dryRun: boolean;
	continuous: boolean;
	continuousFocus?: string;
	duration?: string;
	taskId?: string;
	/** Enable bash command auditing via PreToolUse hooks */
	auditBash: boolean;
	/** Use SDK systemPrompt preset with claude_code */
	useSystemPromptPreset: boolean;
}

/**
 * Task with recommended model tier
 */
export interface TaskWithModel extends Task {
	recommendedModel?: "sonnet" | "opus";
}

/**
 * Atomicity assessment result for Ax training
 */
export interface AtomicityResult {
	isAtomic: boolean;
	confidence: number;
	estimatedFiles: number;
	recommendedModel: string;
	reasoning: string;
}

/**
 * Result summary for a single task
 */
export interface TaskResultSummary {
	task: string;
	taskId: string;
	status: "completed" | "failed" | "merged" | "decomposed";
	modifiedFiles?: string[];
	error?: string;
}

/**
 * Grind session state tracked during execution
 */
export interface GrindSessionState {
	batchId: string;
	tasksProcessed: number;
	totalSuccessful: number;
	totalFailed: number;
	totalMerged: number;
	totalDecomposed: number;
	totalDurationMs: number;
	taskResults: TaskResultSummary[];
	atomicityResults: Map<string, AtomicityResult>;
	objectiveToTaskId: Map<string, string>;
	taskVariantMap: Map<string, string>;
}

/**
 * Pre-flight check results
 */
export interface PreflightResult {
	usageOk: boolean;
	usagePercent?: number;
	patternsReady: boolean;
	patternsAdded?: number;
	astIndexReady: boolean;
	astFileCount?: number;
	boardEmpty: boolean;
	pendingCount: number;
	recoveryNeeded: boolean;
	recoveryInfo?: {
		batchId: string;
		tasksComplete: number;
		tasksFailed: number;
		tasksPending: number;
	};
}

/**
 * Validation result for a task
 */
export interface TaskValidationResult {
	taskId: string;
	valid: boolean;
	corrected: boolean;
	correctedObjective?: string;
	blocked: boolean;
	blockReason?: string;
	decomposed: boolean;
	vague: boolean;
	issues: string[];
}

/**
 * Tasks grouped by model tier
 * DEPRECATED: Use prioritizedTasks from processTasksForExecution instead
 */
export interface TasksByModel {
	sonnet: TaskWithModel[];
	opus: TaskWithModel[];
}
