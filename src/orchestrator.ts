/**
 * Orchestrator: Parallel TaskWorker execution with worktree isolation
 *
 * Architecture: Each task → isolated worktree → independent execution → serial merge
 *
 * | Step | Action                                          |
 * |------|-------------------------------------------------|
 * | 1    | Create worktrees from local main HEAD           |
 * | 2    | Run TaskWorkers in parallel (one per worktree)  |
 * | 3    | Collect results                                 |
 * | 4    | Merge successful branches (rebase → verify → ff)|
 * | 5    | Cleanup worktrees                               |
 * | 6    | User pushes local main when ready               |
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pmRefineTask } from "./automated-pm.js";
import { updateLedger } from "./capability-ledger.js";
import { MAX_MERGE_RETRY_COUNT } from "./constants.js";
import {
	getEmergencyModeStatus,
	hasExceededMaxFixAttempts,
	preMergeHealthCheck,
	recordFixWorkerSpawned,
	shouldSpawnFixWorker,
} from "./emergency-mode.js";
import { type ExperimentManager, getExperimentManager } from "./experiment.js";
import { FileTracker } from "./file-tracker.js";
import { checkAndFixBareRepo } from "./git.js";
import { getTasksNeedingInput } from "./human-input-tracking.js";
import { sessionLogger } from "./logger.js";
import { nameFromId } from "./names.js";
import {
	aggregateTaskResults,
	applyRecommendation,
	attemptMergeVerificationFix,
	buildPredictedConflicts,
	buildSummaryItems,
	canUseOpusBudget,
	cleanWorktreeDirectory,
	createHealthMonitorState,
	detectFileConflicts,
	execGitInDir,
	extractCheckpointsAndCleanup,
	fetchMainIntoWorktree,
	formatResumeMessage,
	type HealthMonitorConfig,
	type HealthMonitorDependencies,
	type HealthMonitorState,
	handleTaskDecomposition,
	handleUnresolvedTickets,
	mergeIntoLocalMain,
	type PredictedConflict,
	type RecoveryTask,
	rebaseOntoMain,
	reportTaskOutcome,
	runPostRebaseVerification,
	startHealthMonitoring,
	stopHealthMonitoring,
	validateGitRef,
	validateRecommendation,
	validateWorktreePath,
} from "./orchestrator/index.js";
import * as output from "./output.js";
import { Persistence, writeTaskAssignment } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import {
	addTask,
	findSimilarInProgressTask,
	getAllTasks,
	getParentTask,
	getSiblingTasks,
	type HandoffContext,
	type Task,
	updateTaskTicket,
} from "./task.js";
import { indexTaskOutcome } from "./task-classifier.js";
import { findRelevantFiles } from "./task-file-patterns.js";
import { isPlanTask, runPlanner } from "./task-planner.js";
import { extractMetaTaskType } from "./task-schema.js";
import { extractPathsFromObjective } from "./task-validator.js";
import type {
	ActiveTaskState,
	BatchMetadata,
	MetaTaskRecommendation,
	MetaTaskResult,
	ModelTier,
	ParallelTaskState,
	TaskAssignment,
	TaskCheckpoint,
	TicketContent,
} from "./types.js";
import { type HistoricalModelChoice, normalizeModel } from "./types.js";
import { type TaskResult, TaskWorker } from "./worker.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface ParallelSoloOptions {
	maxConcurrent?: number; // Max parallel tasks (default: 3)
	startingModel?: ModelTier;
	autoCommit?: boolean;
	stream?: boolean;
	verbose?: boolean;
	reviewPasses?: boolean; // Enable escalating review (sonnet → opus)
	multiLensAtOpus?: boolean; // Enable multi-lens review at opus tier
	pushOnSuccess?: boolean; // Push to remote after successful merge (default: false)
	// Verification retry options
	maxAttempts?: number; // Maximum attempts per task before failing (default: 7)
	maxRetriesPerTier?: number; // Maximum fix attempts at same tier before escalating (default: 2)
	maxReviewPassesPerTier?: number; // Maximum review passes per tier before escalating (default: 2)
	maxOpusReviewPasses?: number; // Maximum review passes at opus tier (default: 6)
	// Model tier cap (prevents escalation beyond this tier)
	maxTier?: ModelTier;
	// Worker health monitoring
	healthCheck?: WorkerHealthConfig;
	// Repository root directory (default: process.cwd())
	// CRITICAL: Capture this at CLI invocation time to avoid wrong repo issues
	repoRoot?: string;
	// Security options
	auditBash?: boolean; // Enable bash command auditing via PreToolUse hooks
	// Experimental options
	useSystemPromptPreset?: boolean; // Use SDK systemPrompt preset with claude_code
	// SDK options
	useExtendedContext?: boolean; // Enable 1M context window beta
	maxBudgetPerTask?: number; // Per-task cost cap in USD (0 = no cap)
}

/**
 * Configuration for worker health monitoring
 */
export interface WorkerHealthConfig {
	/** Enable health monitoring (default: true) */
	enabled?: boolean;
	/** How often to check worker health in ms (default: 60000 = 1 min) */
	checkIntervalMs?: number;
	/** Max time since last checkpoint before worker is considered stuck (default: 300000 = 5 min) */
	stuckThresholdMs?: number;
	/** Whether to attempt recovery intervention before killing (default: true) */
	attemptRecovery?: boolean;
	/** Max recovery attempts before killing worker (default: 2) */
	maxRecoveryAttempts?: number;
}

export interface ParallelTaskResult {
	task: string;
	taskId: string;
	result: TaskResult | null;
	worktreePath: string;
	branch: string;
	merged: boolean;
	mergeError?: string;
	modifiedFiles?: string[]; // Files modified by this task
	decomposed?: boolean; // Task was decomposed into subtasks (not executed)
	parentId?: string; // Parent task ID (for subtasks from decomposition)
}

export interface ParallelBatchResult {
	results: ParallelTaskResult[];
	successful: number; // Tasks that executed successfully (not decomposed)
	failed: number;
	merged: number;
	mergeFailed: number;
	decomposed: number; // Tasks that were decomposed into subtasks (not executed)
	durationMs: number;
	emergencyMode?: boolean; // Execution halted due to emergency mode
}

/**
 * Generate a short unique ID for a task
 */
function generateTaskId(): string {
	return `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Generate a unique batch ID
 */
function generateBatchId(): string {
	return `batch-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Get the list of modified files in a worktree compared to main branch
 */
function getModifiedFilesInWorktree(worktreePath: string, mainBranch: string): string[] {
	const sanitizedBranch = validateGitRef(mainBranch);
	try {
		// Get files that differ from main branch
		const output = execGitInDir(["diff", "--name-only", `origin/${sanitizedBranch}...HEAD`], worktreePath);
		if (!output) return [];
		return output.split("\n").filter((f) => f.trim().length > 0);
	} catch {
		// If git diff fails, try to get uncommitted changes
		try {
			const output = execGitInDir(["diff", "--name-only", "HEAD"], worktreePath);
			if (!output) return [];
			return output.split("\n").filter((f) => f.trim().length > 0);
		} catch {
			return [];
		}
	}
}

/**
 * Orchestrator - Central coordinator for autonomous task execution
 *
 * Manages the full lifecycle of parallel task execution in isolated worktrees:
 * - Worker pool management with health monitoring and recovery
 * - Task scheduling with conflict prediction and deferral
 * - Serial merge queue with rebase-verify-merge workflow
 * - Rate limit tracking and opus budget enforcement
 * - Crash recovery from interrupted batches
 *
 * This is the main entry point for the Undercity autonomous agent framework.
 */
export class Orchestrator {
	private maxConcurrent: number;
	private startingModel: ModelTier;
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private reviewPasses: boolean;
	private multiLensAtOpus: boolean;
	private pushOnSuccess: boolean;
	// Verification retry options
	private maxAttempts: number;
	private maxRetriesPerTier: number;
	private maxReviewPassesPerTier: number;
	private maxOpusReviewPasses: number;
	private maxTier?: ModelTier;
	private worktreeManager: WorktreeManager;
	private persistence: Persistence;
	private rateLimitTracker: RateLimitTracker;
	private fileTracker: FileTracker;
	private experimentManager: ExperimentManager;
	/** Recovered checkpoints from crashed tasks (task objective → checkpoint) */
	private recoveredCheckpoints: Map<string, TaskCheckpoint> = new Map();
	/** Handoff context from calling Claude Code session (task objective → context) */
	private handoffContexts: Map<string, HandoffContext> = new Map();
	/** Rich ticket content from task board (task objective → ticket) */
	private tickets: Map<string, TicketContent> = new Map();
	/** Original task IDs from the board (task objective → board task ID) */
	private originalTaskIds: Map<string, string> = new Map();
	/** Parent task IDs for subtasks (task objective → parent task ID) */
	private parentIds: Map<string, string> = new Map();
	// Worker health monitoring (delegated to health-monitoring module)
	private healthMonitorConfig: HealthMonitorConfig;
	private healthMonitorState: HealthMonitorState = createHealthMonitorState();
	/** Draining flag - when true, finish current tasks but start no more */
	private draining = false;
	/** Callback to invoke when drain completes */
	private onDrainComplete?: () => void;

	/**
	 * Ralph-style opus budget tracking
	 * Limits opus usage to ~10% of tasks to optimize for Max plan usage
	 */
	private opusBudgetPercent: number = 10; // Target 5-10% opus usage
	private opusTasksUsed: number = 0;
	private totalTasksProcessed: number = 0;
	/** Repository root directory */
	private repoRoot: string;
	/** Enable bash command auditing via PreToolUse hooks */
	private auditBash: boolean;
	/** Use SDK systemPrompt preset with claude_code */
	private useSystemPromptPreset: boolean;
	/** Enable 1M context window beta */
	private useExtendedContext: boolean;
	/** Per-task cost cap in USD */
	private maxBudgetPerTask: number;

	constructor(options: ParallelSoloOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 3;
		this.startingModel = options.startingModel ?? "sonnet";
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.reviewPasses = options.reviewPasses ?? true; // Default to review enabled - catches issues before merge
		this.multiLensAtOpus = options.multiLensAtOpus ?? false;
		this.pushOnSuccess = options.pushOnSuccess ?? false; // Default to no push - user must explicitly opt in
		// Verification retry options with defaults
		// maxAttempts of 4 allows: 2 at first tier + 2 at second tier
		this.maxAttempts = options.maxAttempts ?? 4;
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 3;
		this.maxReviewPassesPerTier = options.maxReviewPassesPerTier ?? 2;
		this.maxOpusReviewPasses = options.maxOpusReviewPasses ?? 6;
		this.maxTier = options.maxTier;
		// Health monitoring with defaults
		const healthConfig = options.healthCheck ?? {};
		this.healthMonitorConfig = {
			enabled: healthConfig.enabled ?? true,
			checkIntervalMs: healthConfig.checkIntervalMs ?? 60_000, // 1 minute
			stuckThresholdMs: healthConfig.stuckThresholdMs ?? 300_000, // 5 minutes
			attemptRecovery: healthConfig.attemptRecovery ?? true,
			maxRecoveryAttempts: healthConfig.maxRecoveryAttempts ?? 2,
		};

		// Security and experimental options
		this.auditBash = options.auditBash ?? false;
		this.useSystemPromptPreset = options.useSystemPromptPreset ?? false;
		this.useExtendedContext = options.useExtendedContext ?? true;
		this.maxBudgetPerTask = options.maxBudgetPerTask ?? 0;

		// CRITICAL: Capture repo root at CLI invocation time to avoid wrong repo issues
		// When undercity is installed globally and run from another project, process.cwd()
		// must be captured here, not later when git commands are executed
		this.repoRoot = options.repoRoot ?? process.cwd();
		this.worktreeManager = new WorktreeManager({ repoRoot: this.repoRoot });

		// Check and fix bare repo (can happen due to worktree race conditions)
		checkAndFixBareRepo(this.repoRoot);

		// Initialize persistence and trackers
		this.persistence = new Persistence();
		const savedRateLimitState = this.persistence.getRateLimitState();
		this.rateLimitTracker = new RateLimitTracker(savedRateLimitState ?? undefined);

		// Initialize file tracker for conflict detection
		const savedFileTrackingState = this.persistence.getFileTracking();
		this.fileTracker = new FileTracker(savedFileTrackingState);

		// Initialize experiment manager for A/B testing
		this.experimentManager = getExperimentManager();
	}

	/**
	 * Signal graceful drain - finish current tasks, start no more
	 * @param onComplete Optional callback when drain completes
	 */
	drain(onComplete?: () => void): void {
		if (this.draining) {
			output.warning("Already draining");
			return;
		}
		this.draining = true;
		this.onDrainComplete = onComplete;
		output.progress("Drain initiated - finishing current tasks, starting no more");
	}

	/**
	 * Check if orchestrator is draining
	 */
	isDraining(): boolean {
		return this.draining;
	}

	/**
	 * Handle a [plan] task by running the planner and creating implementation tasks
	 */
	private async handlePlanTask(task: string): Promise<ParallelBatchResult> {
		const startTime = Date.now();

		output.header("Plan Mode", "Analyzing objective and creating implementation tasks");

		const planResult = await runPlanner(task, process.cwd());

		if (!planResult.success || planResult.tasks.length === 0) {
			output.error(`Planning failed: ${planResult.summary}`);
			return {
				results: [],
				successful: 0,
				failed: 1,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		// Add generated tasks to the board
		output.info(`Generated ${planResult.tasks.length} implementation tasks`);
		for (const plannedTask of planResult.tasks) {
			const newTask = addTask(plannedTask.objective, plannedTask.priority);
			output.success(`Added: ${newTask.objective.substring(0, 60)}...`);
		}

		// Show any notes from planning
		if (planResult.notes.length > 0) {
			output.info("Planning notes:");
			for (const note of planResult.notes) {
				output.info(`  - ${note}`);
			}
		}

		output.success(`Plan complete: ${planResult.summary}`);

		return {
			results: [],
			successful: 1, // Plan itself succeeded
			failed: 0,
			merged: 0,
			mergeFailed: 0,
			decomposed: 0,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Process recommendations from a meta-task result
	 * This is the single point where task board mutations happen.
	 *
	 * The orchestrator validates each recommendation against the actual task board
	 * state rather than trusting the agent's self-reported confidence.
	 */
	private processMetaTaskResult(metaResult: MetaTaskResult, metaTaskId: string): void {
		const { metaTaskType, recommendations, summary } = metaResult;

		output.info(`Processing ${metaTaskType} recommendations`, {
			count: recommendations.length,
			summary,
		});

		// Load current tasks for validation
		const allTasks = getAllTasks();
		const taskIds = new Set(allTasks.map((t) => t.id));

		// Track actions
		let applied = 0;
		let rejected = 0;
		const rejectionReasons: string[] = [];

		// Sanity limits
		const MAX_REMOVES_PERCENT = 0.5; // Don't remove more than 50% of tasks
		const MAX_ADDS = 20; // Don't add more than 20 tasks at once
		let removeCount = 0;
		let addCount = 0;

		for (const rec of recommendations) {
			const validation = validateRecommendation(rec, allTasks, taskIds, metaTaskId);

			if (!validation.valid) {
				rejected++;
				rejectionReasons.push(`${rec.action}(${rec.taskId || "new"}): ${validation.reason}`);
				continue;
			}

			// Check sanity limits
			if (rec.action === "remove") {
				removeCount++;
				if (removeCount > allTasks.length * MAX_REMOVES_PERCENT) {
					rejected++;
					rejectionReasons.push(`remove(${rec.taskId}): exceeds ${MAX_REMOVES_PERCENT * 100}% removal limit`);
					continue;
				}
			}

			if (rec.action === "add") {
				addCount++;
				if (addCount > MAX_ADDS) {
					rejected++;
					rejectionReasons.push(`add: exceeds ${MAX_ADDS} task limit`);
					continue;
				}
			}

			try {
				this.applyRecommendationLocal(rec);
				applied++;
			} catch (err) {
				rejected++;
				rejectionReasons.push(`${rec.action}(${rec.taskId || "new"}): ${String(err)}`);
			}
		}

		// Log results
		if (applied > 0) {
			output.success(`Meta-task applied ${applied} recommendations`, { applied, rejected });
		}

		if (rejected > 0) {
			output.warning(`Rejected ${rejected} recommendations`, {
				reasons: rejectionReasons.slice(0, 5), // Show first 5
			});
		}

		// Log metrics if available
		if (metaResult.metrics) {
			output.info(`Task board analysis`, {
				healthScore: metaResult.metrics.healthScore,
				issuesFound: metaResult.metrics.issuesFound,
				tasksAnalyzed: metaResult.metrics.tasksAnalyzed,
			});
		}
	}

	/**
	 * Apply a single recommendation to the task board
	 */
	private applyRecommendationLocal(rec: MetaTaskRecommendation): void {
		applyRecommendation(rec, { verbose: this.verbose });
	}

	/**
	 * Run a single task directly without worktree overhead
	 *
	 * This is an optimization for when only one task needs to run.
	 * It runs TaskWorker directly in the current directory.
	 */
	async runSingle(taskOrObj: string | Task): Promise<ParallelBatchResult> {
		// Extract objective, handoff context, and ticket
		const task = typeof taskOrObj === "string" ? taskOrObj : taskOrObj.objective;
		const handoffContext = typeof taskOrObj === "string" ? undefined : taskOrObj.handoffContext;
		const ticket = typeof taskOrObj === "string" ? undefined : taskOrObj.ticket;

		// Check for [plan] prefix - route to planner instead of worker
		if (isPlanTask(task)) {
			return this.handlePlanTask(task);
		}

		const startTime = Date.now();

		// Check if rate limited
		this.rateLimitTracker.checkAutoResume();

		if (this.rateLimitTracker.isPaused()) {
			const pauseState = this.rateLimitTracker.getPauseState();
			const remaining = this.rateLimitTracker.formatRemainingTime();
			output.warning("Rate limit pause active", {
				reason: pauseState.reason || "Rate limit hit",
				remaining,
			});

			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		const escalationInfo =
			this.maxTier && this.maxTier !== "opus" ? ` (capped at ${this.maxTier})` : " → escalate if needed";
		output.header("Solo Mode (Direct)", `Model: ${this.startingModel}${escalationInfo}`);

		const taskId = generateTaskId();

		try {
			// Run TaskWorker directly in current directory
			const worker = new TaskWorker({
				startingModel: this.startingModel,
				autoCommit: this.autoCommit,
				stream: this.stream,
				verbose: this.verbose,
				reviewPasses: this.reviewPasses,
				multiLensAtOpus: this.multiLensAtOpus,
				maxAttempts: this.maxAttempts,
				maxRetriesPerTier: this.maxRetriesPerTier,
				maxReviewPassesPerTier: this.maxReviewPassesPerTier,
				maxOpusReviewPasses: this.maxOpusReviewPasses,
				maxTier: this.maxTier,
				auditBash: this.auditBash,
				useSystemPromptPreset: this.useSystemPromptPreset,
				useExtendedContext: this.useExtendedContext,
				maxBudgetPerTask: this.maxBudgetPerTask,
				// No workingDirectory - runs in current directory
			});

			const result = await worker.runTask(task, handoffContext, ticket);

			// Record token usage
			if (result.tokenUsage) {
				for (const attemptUsage of result.tokenUsage.attempts) {
					const rawModel = (attemptUsage.model as HistoricalModelChoice | undefined) ?? this.startingModel;
					const model = normalizeModel(rawModel);
					this.rateLimitTracker.recordTask(taskId, model, attemptUsage.inputTokens, attemptUsage.outputTokens, {
						durationMs: result.durationMs,
					});
				}
			}

			// Save rate limit state
			this.persistence.saveRateLimitState(this.rateLimitTracker.getState());

			const taskResult: ParallelTaskResult = {
				task,
				taskId,
				result,
				worktreePath: process.cwd(),
				branch: "current",
				merged: result.status === "complete", // Already committed in place
			};

			return {
				results: [taskResult],
				successful: result.status === "complete" ? 1 : 0,
				failed: result.status === "complete" ? 0 : 1,
				merged: result.status === "complete" ? 1 : 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
			};
		} catch (err) {
			output.error(`Task execution failed: ${err}`);

			return {
				results: [
					{
						task,
						taskId,
						result: null,
						worktreePath: process.cwd(),
						branch: "current",
						merged: false,
						mergeError: String(err),
					},
				],
				successful: 0,
				failed: 1,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
			};
		}
	}

	/**
	 * Run multiple tasks in parallel
	 *
	 * Accepts either task objective strings or full Task objects.
	 * When Task objects are provided, handoff context is preserved.
	 *
	 * If only one task is provided and maxConcurrent is 1, runs in direct mode
	 * without worktree overhead.
	 */
	async runParallel(tasks: Array<string | Task>): Promise<ParallelBatchResult> {
		// Extract objectives and store handoff contexts (with auto-refinement)
		const objectives = await this.extractObjectivesAndContexts(tasks);

		// Separate plan tasks from implementation tasks
		const planTasks = objectives.filter(isPlanTask);
		const implTasks = objectives.filter((t) => !isPlanTask(t));

		// Process plan tasks first (serially, they add to the queue)
		if (planTasks.length > 0) {
			output.info(`Processing ${planTasks.length} plan task(s) first...`);
			for (const planTask of planTasks) {
				await this.handlePlanTask(planTask);
			}
		}

		// If only plan tasks, we're done
		if (implTasks.length === 0) {
			return {
				results: [],
				successful: planTasks.length,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: 0,
			};
		}

		const startTime = Date.now();

		// Check rate limits and setup (syncs with actual claude.ai usage)
		if (!(await this.checkRateLimits(startTime))) {
			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		this.displayExecutionHeader(implTasks.length);
		const mainBranch = this.setupFileTracking();

		// Check emergency mode before processing
		const emergencyCheck = await this.checkEmergencyMode();
		if (!emergencyCheck.proceed) {
			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				decomposed: 0,
				durationMs: Date.now() - startTime,
				emergencyMode: true,
			};
		}

		// Process all task batches
		const batchId = generateBatchId();
		const results = await this.processBatches(implTasks, batchId, mainBranch);

		// Post-processing
		this.recordTokenUsage(results);
		await this.mergeSuccessfulTasks(results);
		await this.cleanupWorktrees(results);

		// Finalization
		const durationMs = Date.now() - startTime;
		this.displaySummary(results, durationMs);
		await this.finalizeExecution();
		stopHealthMonitoring(this.healthMonitorState);

		return this.buildBatchResult(results, durationMs);
	}

	/**
	 * Extract task objectives and store handoff contexts and original task IDs
	 * Auto-refines tasks that lack rich ticket content
	 */
	private async extractObjectivesAndContexts(tasks: Array<string | Task>): Promise<string[]> {
		const objectives: string[] = [];
		for (const t of tasks) {
			if (typeof t === "string") {
				objectives.push(t);
			} else {
				objectives.push(t.objective);
				// Build handoff context, including lastAttempt for retry tasks
				const handoffContext: HandoffContext = { ...t.handoffContext };
				if (t.lastAttempt) {
					handoffContext.lastAttempt = t.lastAttempt;
				}
				if (Object.keys(handoffContext).length > 0) {
					this.handoffContexts.set(t.objective, handoffContext);
				}

				// Auto-refine if task lacks ticket content
				let ticket = t.ticket;
				if (!ticket || !ticket.description) {
					try {
						sessionLogger.info(
							{ taskId: t.id, objective: t.objective.substring(0, 50) },
							"Task lacks ticket content, auto-refining",
						);
						const refineResult = await pmRefineTask(t.objective, this.repoRoot);
						if (refineResult.success) {
							ticket = refineResult.ticket;
							// Persist enriched ticket back to database
							if (t.id) {
								updateTaskTicket(t.id, ticket);
								sessionLogger.info(
									{
										taskId: t.id,
										tokensUsed: refineResult.tokensUsed,
										hasDescription: !!ticket.description,
										hasAcceptanceCriteria: !!ticket.acceptanceCriteria,
									},
									"Task auto-refined successfully",
								);
							}
						}
					} catch (error) {
						sessionLogger.warn(
							{ error: String(error), taskId: t.id },
							"Auto-refinement failed, proceeding with minimal context",
						);
					}
				}

				// Store ticket content for rich task context
				if (ticket) {
					this.tickets.set(t.objective, ticket);
				}

				// Store the original task ID from the board for decomposition
				if (t.id) {
					this.originalTaskIds.set(t.objective, t.id);
				}

				// Store parent ID for subtasks (used for parent-aware merge ordering)
				if (t.parentId) {
					this.parentIds.set(t.objective, t.parentId);
				}
			}
		}
		return objectives;
	}

	/**
	 * Check rate limits and return whether execution can proceed
	 * Syncs with actual claude.ai usage to ensure accurate rate limiting
	 */
	private async checkRateLimits(_startTime: number): Promise<boolean> {
		// Sync with actual claude.ai usage (non-blocking, best effort)
		try {
			const { fetchClaudeUsage } = await import("./claude-usage.js");
			const actualUsage = await fetchClaudeUsage();
			if (actualUsage.success) {
				this.rateLimitTracker.syncWithActualUsage(actualUsage.fiveHourPercent, actualUsage.weeklyPercent);
			}
		} catch {
			// Silent failure - continue with local estimates if fetch fails
		}

		this.rateLimitTracker.checkAutoResume();

		if (this.rateLimitTracker.isPaused()) {
			const pauseState = this.rateLimitTracker.getPauseState();
			const remaining = this.rateLimitTracker.formatRemainingTime();
			output.warning("Rate limit pause active", {
				reason: pauseState.reason || "Rate limit hit",
				remaining,
				resumeAt: pauseState.resumeAt?.toISOString() || "unknown",
			});
			output.info("Run 'undercity usage' to check Claude Max usage");
			return false;
		}

		return true;
	}

	/**
	 * Refresh actual usage from claude.ai and sync with tracker
	 * Silent failure - continues with local estimates if fetch fails
	 */
	private async refreshActualUsage(): Promise<void> {
		try {
			const { fetchClaudeUsage } = await import("./claude-usage.js");
			const actualUsage = await fetchClaudeUsage();
			if (actualUsage.success) {
				this.rateLimitTracker.syncWithActualUsage(actualUsage.fiveHourPercent, actualUsage.weeklyPercent);
			}
		} catch {
			// Silent failure - continue with local estimates
		}
	}

	/**
	 * Check emergency mode status and handle fix worker spawning
	 * Returns true if safe to proceed, false if blocked by emergency mode
	 */
	private async checkEmergencyMode(): Promise<{ proceed: boolean }> {
		// Check if we should skip emergency mode (e.g., in test environments)
		if (process.env.UNDERCITY_SKIP_EMERGENCY_CHECK === "true") {
			return { proceed: true };
		}

		const healthCheck = await preMergeHealthCheck(this.repoRoot);

		if (healthCheck.proceed) {
			return { proceed: true };
		}

		// Emergency mode is active
		const status = getEmergencyModeStatus();
		output.error(`Emergency mode active: ${status.reason || "Main branch unhealthy"}`);

		// Check if we should spawn a fix worker
		if (shouldSpawnFixWorker()) {
			if (hasExceededMaxFixAttempts()) {
				output.error(`Maximum fix attempts (${status.fixAttempts}) exceeded. Human intervention required.`);
				output.info("Run 'undercity emergency --status' to check emergency mode status");
				output.info("Run 'undercity emergency --clear' to manually clear emergency mode after fixing");
			} else {
				output.warning(`Spawning emergency fix worker (attempt ${status.fixAttempts + 1})`);
				await this.spawnEmergencyFixWorker();
			}
		} else if (status.fixWorkerActive) {
			output.info("Emergency fix worker is already active, waiting for completion");
		}

		return { proceed: false };
	}

	/**
	 * Spawn a worker to fix the main branch CI failure
	 */
	private async spawnEmergencyFixWorker(): Promise<void> {
		const { loadEmergencyState, generateFixTaskDescription } = await import("./emergency-mode.js");
		const state = loadEmergencyState();
		const fixTask = generateFixTaskDescription(state);

		// Add emergency fix task to the board
		const task = addTask(fixTask, { priority: 100 }); // Highest priority
		recordFixWorkerSpawned(task.id);

		output.info(`Created emergency fix task: ${task.id}`);
		output.info("The fix task will be processed on the next grind run");
	}

	/**
	 * Display execution header with task and rate limit info
	 */
	private displayExecutionHeader(taskCount: number): void {
		const escalationInfo =
			this.maxTier && this.maxTier !== "opus" ? ` (capped at ${this.maxTier})` : " → escalate if needed";
		output.header(
			"Parallel Mode",
			`${taskCount} tasks (max ${this.maxConcurrent} concurrent) • Model: ${this.startingModel}${escalationInfo}`,
		);

		const usageSummary = this.rateLimitTracker.getUsageSummary();
		if (usageSummary.percentages.fiveHour > 0.5 || usageSummary.percentages.weekly > 0.5) {
			output.warning(
				`Rate limit usage: ${(usageSummary.percentages.fiveHour * 100).toFixed(0)}% (5h) / ${(usageSummary.percentages.weekly * 100).toFixed(0)}% (week)`,
			);
		}
	}

	/**
	 * Setup file tracking and return main branch name
	 */
	private setupFileTracking(): string {
		let mainBranch: string;
		try {
			mainBranch = this.worktreeManager.getMainBranch();
		} catch (branchError) {
			output.warning(`Could not determine main branch, defaulting to 'main': ${branchError}`);
			mainBranch = "main";
		}

		try {
			this.fileTracker.clearCompleted();
		} catch (clearError) {
			output.debug(`File tracker cleanup failed (non-fatal): ${clearError}`);
		}

		return mainBranch;
	}

	/**
	 * Process all task batches and return aggregated results
	 */
	private async processBatches(tasks: string[], batchId: string, mainBranch: string): Promise<ParallelTaskResult[]> {
		const results: ParallelTaskResult[] = [];

		startHealthMonitoring(this.healthMonitorState, this.healthMonitorConfig, this.buildHealthMonitorDeps());

		let remaining = [...tasks];
		let batchNum = 0;

		while (remaining.length > 0 && !this.draining) {
			// Refresh actual usage from claude.ai at start of each batch
			await this.refreshActualUsage();

			const batch = remaining.slice(0, this.maxConcurrent);
			const deferred = remaining.slice(this.maxConcurrent);

			// Pre-assign file ownership: defer tasks with predicted file conflicts
			const { execute, defer } = this.filterConflictingTasks(batch);

			batchNum++;
			const totalBatches = batchNum + Math.ceil((deferred.length + defer.length) / this.maxConcurrent);

			output.section(`Batch ${batchNum}/~${totalBatches}: Processing ${execute.length} tasks`);

			const preparedTasks = await this.scheduleBatchTasks(execute, results);

			if (batchNum === 1 && preparedTasks.length > 0) {
				this.initializeBatch(batchId, preparedTasks);
				output.debug(`Batch initialized: ${batchId}`);
			} else if (preparedTasks.length > 0) {
				this.saveBatchTaskStates(preparedTasks, batchId);
			}

			const batchResults = await this.executeBatchWorkers(preparedTasks, mainBranch);
			results.push(...batchResults);

			// Deferred tasks go to front of remaining queue (run in next batch)
			remaining = [...defer, ...deferred];
		}

		if (this.draining && remaining.length > 0) {
			output.progress(`Drain: skipping ${remaining.length} remaining tasks`);
		}

		// If we drained, invoke the callback
		if (this.draining && this.onDrainComplete) {
			output.success("Drain complete - all in-progress tasks finished");
			this.onDrainComplete();
		}

		return results;
	}

	/**
	 * Schedule tasks for a batch by creating worktrees
	 */
	private async scheduleBatchTasks(
		batchTasks: string[],
		existingResults: ParallelTaskResult[],
	): Promise<Array<{ task: string; taskId: string; worktreePath: string; branch: string }>> {
		const preparedTasks: Array<{
			task: string;
			taskId: string;
			worktreePath: string;
			branch: string;
		}> = [];

		for (const task of batchTasks) {
			const taskId = generateTaskId();

			// Check for similar in-progress tasks to avoid duplication
			const similarTask = findSimilarInProgressTask(task, 0.7);
			if (similarTask) {
				output.warning(
					`Skipping task (${(similarTask.similarity * 100).toFixed(0)}% similar to in-progress): ${task.substring(0, 50)}`,
				);
				existingResults.push({
					task,
					taskId,
					result: null,
					worktreePath: "",
					branch: "",
					merged: false,
					mergeError: `Skipped: too similar to in-progress task "${similarTask.task.objective.substring(0, 50)}"`,
				});
				continue;
			}

			// Fast path: meta-tasks analyze the task board, not source code
			const metaType = extractMetaTaskType(task);
			if (metaType !== null) {
				const workerName = nameFromId(taskId);
				preparedTasks.push({ task, taskId, worktreePath: "", branch: "" });
				output.success(`Spawned worker: ${workerName} (${taskId}) [no worktree]`);
				continue;
			}

			try {
				// INVARIANT: Each task gets an isolated worktree. No two tasks share
				// a working directory. See: .claude/adrs/0001-worktree-isolation.md
				const worktreeInfo = this.worktreeManager.createWorktree(taskId);
				const workerName = nameFromId(taskId);
				preparedTasks.push({
					task,
					taskId,
					worktreePath: worktreeInfo.path,
					branch: worktreeInfo.branch,
				});
				output.success(`Spawned worker: ${workerName} (${taskId})`);
			} catch (err) {
				output.error(`Failed to create worktree: ${err}`);
				existingResults.push({
					task,
					taskId,
					result: null,
					worktreePath: "",
					branch: "",
					merged: false,
					mergeError: `Worktree creation failed: ${err}`,
				});
			}
		}

		// Warn about predicted file conflicts in this batch
		if (preparedTasks.length > 1) {
			this.warnPredictedConflicts(preparedTasks);
		}

		return preparedTasks;
	}

	/**
	 * Save task states for a batch
	 */
	private saveBatchTaskStates(
		preparedTasks: Array<{ task: string; taskId: string; worktreePath: string; branch: string }>,
		batchId: string,
	): void {
		for (const t of preparedTasks) {
			const activeState: ActiveTaskState = {
				taskId: t.taskId,
				task: t.task,
				worktreePath: t.worktreePath,
				branch: t.branch,
				status: "pending",
				batchId,
			};
			this.persistence.writeActiveTask(activeState);
		}
	}

	/**
	 * Execute workers for a batch of prepared tasks
	 */
	private async executeBatchWorkers(
		preparedTasks: Array<{ task: string; taskId: string; worktreePath: string; branch: string }>,
		mainBranch: string,
	): Promise<ParallelTaskResult[]> {
		const taskPromises = preparedTasks.map((prepared) => this.spawnWorker(prepared, mainBranch));
		return Promise.all(taskPromises);
	}

	/**
	 * Spawn a worker for a single task
	 */
	private async spawnWorker(
		prepared: { task: string; taskId: string; worktreePath: string; branch: string },
		mainBranch: string,
	): Promise<ParallelTaskResult> {
		const { task, taskId, worktreePath, branch } = prepared;
		const isFastPath = !worktreePath;

		if (!isFastPath) {
			this.fileTracker.startTaskTracking(taskId, taskId);
		}
		this.updateTaskStatus(taskId, "running");

		try {
			const workerName = nameFromId(taskId);
			output.taskStart(taskId, task.substring(0, 50), { workerName });
			this.totalTasksProcessed++;

			const variant = this.experimentManager.selectVariant();
			const rawModel = (variant?.model as HistoricalModelChoice | undefined) ?? this.startingModel;
			let effectiveModel = normalizeModel(rawModel);
			const effectiveReview = variant?.reviewEnabled ?? this.reviewPasses;

			// Ralph-style: enforce opus budget to maintain optimal model ratios
			// If starting model is opus and budget is exhausted, cap to sonnet
			if (effectiveModel === "opus" && !this.canUseOpus()) {
				sessionLogger.info(
					{
						opusUsed: this.opusTasksUsed,
						totalTasks: this.totalTasksProcessed,
						budgetPercent: this.opusBudgetPercent,
					},
					"Opus budget exhausted - capping to sonnet",
				);
				effectiveModel = "sonnet";
			} else if (effectiveModel === "opus") {
				this.opusTasksUsed++;
			}

			// Fast path: meta-tasks use main repo, not worktree
			const workingDirectory = worktreePath || this.worktreeManager.getMainRepoPath();

			const worker = new TaskWorker({
				startingModel: effectiveModel,
				autoCommit: this.autoCommit,
				stream: this.stream,
				verbose: this.verbose,
				workingDirectory,
				reviewPasses: effectiveReview,
				multiLensAtOpus: this.multiLensAtOpus,
				maxAttempts: this.maxAttempts,
				maxRetriesPerTier: this.maxRetriesPerTier,
				maxReviewPassesPerTier: this.maxReviewPassesPerTier,
				maxOpusReviewPasses: this.maxOpusReviewPasses,
				maxTier: this.maxTier,
				auditBash: this.auditBash,
				useSystemPromptPreset: this.useSystemPromptPreset,
				useExtendedContext: this.useExtendedContext,
				maxBudgetPerTask: this.maxBudgetPerTask,
			});

			const assignment: TaskAssignment = {
				taskId,
				objective: task,
				branch,
				model: effectiveModel,
				worktreePath,
				assignedAt: new Date(),
				maxAttempts: this.maxAttempts,
				reviewPasses: effectiveReview,
				autoCommit: this.autoCommit,
				experimentVariantId: variant?.id,
				checkpoint: this.recoveredCheckpoints.get(task),
			};
			writeTaskAssignment(assignment);

			// Verify assignment was actually persisted (debug: investigate missing checkpoints)
			if (worktreePath) {
				const { existsSync } = await import("node:fs");
				const expectedPath = `${worktreePath}/.undercity-assignment.json`;
				if (!existsSync(expectedPath)) {
					sessionLogger.warn({ taskId, worktreePath, expectedPath }, "Assignment file missing immediately after write");
				}
			}

			this.recoveredCheckpoints.delete(task);

			let handoffContext = this.handoffContexts.get(task);
			const ticket = this.tickets.get(task);

			// Inject sibling context for decomposed subtasks
			const parentId = this.parentIds.get(task);
			if (parentId) {
				const siblingContext = this.buildSiblingContext(task, parentId);
				if (siblingContext) {
					handoffContext = {
						...handoffContext,
						notes: [handoffContext?.notes, siblingContext].filter(Boolean).join("\n\n"),
					};
				}
			}

			const result = await worker.runTask(task, handoffContext, ticket);

			return this.processWorkerResult(task, taskId, worktreePath, branch, result, mainBranch, variant);
		} catch (err) {
			return this.handleWorkerError(task, taskId, worktreePath, branch, err);
		}
	}

	/**
	 * Build sibling context string for decomposed subtasks.
	 * Tells the worker about its parent goal, sibling tasks, and file boundaries.
	 */
	private buildSiblingContext(task: string, parentId: string): string | undefined {
		try {
			const boardTaskId = this.originalTaskIds.get(task);
			if (!boardTaskId) return undefined;

			const parentTask = getParentTask(boardTaskId);
			const siblings = getSiblingTasks(boardTaskId);
			if (siblings.length === 0 && !parentTask) return undefined;

			const lines: string[] = ["# Decomposition Context", ""];
			lines.push("You are working on a SUBTASK of a larger goal.");

			if (parentTask) {
				lines.push(`PARENT TASK: ${parentTask.objective}`);
			}

			if (siblings.length > 0) {
				lines.push("", "SIBLING SUBTASKS (do NOT touch their files):");
				for (const sibling of siblings) {
					const status = sibling.status === "complete" ? "complete" : sibling.status;
					const files = sibling.estimatedFiles?.join(", ") ?? "unknown";
					lines.push(`- [${status}] "${sibling.objective.substring(0, 80)}" (files: ${files})`);
				}
			}

			lines.push(
				"",
				"RULES:",
				"- Only modify files assigned to YOUR subtask",
				"- Do NOT modify files listed under other siblings",
				"- If you need changes in a sibling's file, note it in a comment and move on",
			);

			return lines.join("\n");
		} catch (error) {
			sessionLogger.debug({ error: String(error), parentId }, "Failed to build sibling context");
			return undefined;
		}
	}

	/**
	 * Process successful worker result
	 */
	private async processWorkerResult(
		task: string,
		taskId: string,
		worktreePath: string,
		branch: string,
		result: TaskResult,
		mainBranch: string,
		variant: { id: string; model: string; reviewEnabled?: boolean } | null,
	): Promise<ParallelTaskResult> {
		const isFastPath = !worktreePath;

		// Fast path: meta-tasks don't modify source files, skip file tracking and merge
		const modifiedFiles = isFastPath ? [] : getModifiedFilesInWorktree(worktreePath, mainBranch);

		if (!isFastPath) {
			for (const file of modifiedFiles) {
				this.fileTracker.recordFileAccess(taskId, file, "edit", taskId, worktreePath);
			}
			this.fileTracker.stopTaskTracking(taskId);
		}

		// Handle decomposition: agent determined task needs to be broken down
		const decompositionResult = handleTaskDecomposition(
			task,
			taskId,
			worktreePath,
			branch,
			result,
			modifiedFiles,
			this.originalTaskIds,
		);
		if (decompositionResult.earlyReturn) {
			return decompositionResult.earlyReturn;
		}

		// Handle unresolved tickets from review - spawn follow-up tasks
		if (result.unresolvedTickets && result.unresolvedTickets.length > 0) {
			handleUnresolvedTickets(taskId, task, result.unresolvedTickets, this.originalTaskIds);
		}

		const workerName = nameFromId(taskId);
		reportTaskOutcome(taskId, result, modifiedFiles, workerName, this.processMetaTaskResult.bind(this));

		if (modifiedFiles.length > 0 && this.verbose) {
			output.debug(`[${taskId}] Modified ${modifiedFiles.length} files`);
		}

		const taskStatus = result.status === "complete" ? "complete" : "failed";
		this.updateTaskStatus(taskId, taskStatus, { modifiedFiles });

		try {
			const escalated = normalizeModel(result.model as HistoricalModelChoice) !== this.startingModel;

			// Track if task escalated to opus (for budget tracking)
			// This catches cases where task started at haiku/sonnet but escalated to opus
			if (normalizeModel(result.model as HistoricalModelChoice) === "opus" && this.startingModel !== "opus") {
				this.opusTasksUsed++;
				sessionLogger.debug(
					{
						opusUsed: this.opusTasksUsed,
						totalTasks: this.totalTasksProcessed,
					},
					"Task escalated to opus",
				);
			}

			updateLedger({
				objective: task,
				model: normalizeModel(result.model as HistoricalModelChoice),
				success: result.status === "complete",
				escalated,
				tokenCost: result.tokenUsage?.total,
				durationMs: result.durationMs,
				attempts: result.attempts,
			});
		} catch {
			// Silent failure - ledger is optional
		}

		// Index task outcome for semantic classification
		try {
			// Derive failure category from error string if task failed
			const { categorizeFailure } = await import("./grind-events.js");
			const failureCategory = result.error ? categorizeFailure(result.error) : undefined;

			await indexTaskOutcome(taskId, task, result.status === "complete" ? "success" : "failure", {
				failureReason: result.error,
				failureCategory,
				filesModified: modifiedFiles,
				durationMs: result.durationMs,
				modelUsed: normalizeModel(result.model as HistoricalModelChoice),
			});
		} catch {
			// Silent failure - classification is optional enhancement
		}

		if (variant) {
			try {
				this.experimentManager.recordResult({
					taskId,
					variantId: variant.id,
					success: result.status === "complete",
					durationMs: result.durationMs,
					tokensUsed: result.tokenUsage?.total ?? 0,
					attempts: result.attempts,
				});
			} catch {
				// Silent failure - experiments are optional
			}
		}

		return {
			task,
			taskId,
			result,
			worktreePath,
			branch,
			merged: false,
			modifiedFiles,
			parentId: this.parentIds.get(task),
		};
	}

	/**
	 * Handle worker execution error
	 */
	private handleWorkerError(
		task: string,
		taskId: string,
		worktreePath: string,
		branch: string,
		err: unknown,
	): ParallelTaskResult {
		const workerName = nameFromId(taskId);
		// Only stop file tracking if it was started (fast-path tasks skip tracking)
		if (worktreePath) {
			this.fileTracker.stopTaskTracking(taskId);
		}
		this.updateTaskStatus(taskId, "failed", { error: String(err) });
		output.taskFailed(taskId, "Task error", String(err), { workerName });

		return {
			task,
			taskId,
			result: null,
			worktreePath,
			branch,
			merged: false,
			mergeError: String(err),
			parentId: this.parentIds.get(task),
		};
	}

	/**
	 * Record token usage for rate limit tracking
	 */
	private recordTokenUsage(results: ParallelTaskResult[]): void {
		try {
			for (const taskResult of results) {
				if (taskResult.result?.tokenUsage) {
					for (const attemptUsage of taskResult.result.tokenUsage.attempts) {
						const rawModel = (attemptUsage.model as HistoricalModelChoice | undefined) ?? this.startingModel;
						const model = normalizeModel(rawModel);
						this.rateLimitTracker.recordTask(
							taskResult.taskId,
							model,
							attemptUsage.inputTokens,
							attemptUsage.outputTokens,
							{
								durationMs: taskResult.result.durationMs,
							},
						);
					}
				}

				if (taskResult.mergeError?.includes("429") || taskResult.result?.error?.includes("429")) {
					this.rateLimitTracker.recordRateLimitHit(
						this.startingModel,
						taskResult.mergeError || taskResult.result?.error,
					);
				}
			}
		} catch (tokenRecordingError) {
			output.warning(`Token recording failed (non-fatal): ${tokenRecordingError}`);
		}
	}

	/**
	 * Merge successful tasks serially with parent-aware ordering.
	 *
	 * Groups subtasks by their parent task and merges siblings together before
	 * moving to the next parent group. This reduces rebase conflicts between
	 * related tasks that often touch the same files.
	 */
	private async mergeSuccessfulTasks(results: ParallelTaskResult[]): Promise<void> {
		// Only merge tasks that completed execution (not decomposed)
		const successfulTasks = results.filter((r) => r.result?.status === "complete" && r.branch && !r.decomposed);

		if (successfulTasks.length === 0) {
			return;
		}

		// Detect conflicts with sibling relationship instrumentation
		const fileConflicts = detectFileConflicts(successfulTasks);
		if (fileConflicts.size > 0) {
			this.logConflictInstrumentation(successfulTasks, fileConflicts);
		}

		// Parent-aware ordering: group subtasks by parent, merge siblings together
		const orderedTasks = this.orderTasksByParent(successfulTasks);

		output.section(`Merging ${orderedTasks.length} successful branches`);

		let pendingMerges = [...orderedTasks];

		for (let pass = 0; pass < MAX_MERGE_RETRY_COUNT && pendingMerges.length > 0; pass++) {
			if (pass > 0) {
				output.section(`Merge retry pass ${pass + 1}: retrying ${pendingMerges.length} failed merge(s)`);
			}

			const failedThisPass: ParallelTaskResult[] = [];
			let mergedThisPass = 0;

			for (const taskResult of pendingMerges) {
				try {
					const { existsSync } = await import("node:fs");
					const worktreeExists = existsSync(taskResult.worktreePath);
					if (this.verbose) {
						output.debug(`Worktree exists: ${worktreeExists} at ${taskResult.worktreePath}`);
					}
					if (!worktreeExists) {
						throw new Error(`Worktree directory missing: ${taskResult.worktreePath}`);
					}
					await this.mergeBranch(taskResult.branch, taskResult.taskId, taskResult.worktreePath);
					taskResult.merged = true;
					taskResult.mergeError = undefined;
					this.updateTaskStatus(taskResult.taskId, "merged");
					output.success(`Merged: ${taskResult.taskId}`);
					mergedThisPass++;
				} catch (err) {
					taskResult.mergeError = String(err);
					failedThisPass.push(taskResult);
				}
			}

			// Only retry if at least one succeeded this pass (conflict landscape changed)
			if (failedThisPass.length > 0 && mergedThisPass > 0) {
				sessionLogger.info(
					{ pass: pass + 1, merged: mergedThisPass, failed: failedThisPass.length },
					"Merge pass complete, retrying failed merges",
				);
				pendingMerges = failedThisPass;
			} else {
				// No progress or all succeeded - log final failures and stop
				for (const failed of failedThisPass) {
					output.error(`Merge failed: ${failed.taskId}`, { error: failed.mergeError });
				}
				break;
			}
		}

		if (this.pushOnSuccess) {
			await this.pushMergedCommits(successfulTasks);
		}
	}

	/**
	 * Order tasks by parent for optimal merge ordering.
	 * Tasks with the same parentId are grouped together.
	 * Orphan tasks (no parent) come first, then grouped by parent.
	 */
	private orderTasksByParent(tasks: ParallelTaskResult[]): ParallelTaskResult[] {
		// Group by parentId
		const orphans: ParallelTaskResult[] = [];
		const byParent = new Map<string, ParallelTaskResult[]>();

		for (const task of tasks) {
			if (!task.parentId) {
				orphans.push(task);
			} else {
				if (!byParent.has(task.parentId)) {
					byParent.set(task.parentId, []);
				}
				byParent.get(task.parentId)!.push(task);
			}
		}

		// Combine: orphans first, then each parent group
		const ordered: ParallelTaskResult[] = [...orphans];
		for (const siblings of byParent.values()) {
			ordered.push(...siblings);
		}

		// Log if reordering occurred
		if (byParent.size > 0) {
			const groupInfo = Array.from(byParent.entries()).map(([parent, siblings]) => ({
				parent,
				count: siblings.length,
			}));
			sessionLogger.info({ orphans: orphans.length, groups: groupInfo }, "Parent-aware merge ordering applied");
		}

		return ordered;
	}

	/**
	 * Log conflict instrumentation with sibling relationship tracking.
	 * Tracks whether conflicting tasks share a parent (siblings).
	 */
	private logConflictInstrumentation(tasks: ParallelTaskResult[], fileConflicts: Map<string, string[]>): void {
		const conflictMap: Record<string, string[]> = {};
		let siblingConflicts = 0;
		let nonSiblingConflicts = 0;

		// Build task lookup for parent checking
		const taskParentMap = new Map<string, string | undefined>();
		for (const task of tasks) {
			taskParentMap.set(task.taskId, task.parentId);
		}

		for (const [file, taskIds] of fileConflicts) {
			conflictMap[file] = taskIds;

			// Check if any pair of conflicting tasks are siblings (same parent)
			for (let i = 0; i < taskIds.length; i++) {
				for (let j = i + 1; j < taskIds.length; j++) {
					const parent1 = taskParentMap.get(taskIds[i]);
					const parent2 = taskParentMap.get(taskIds[j]);

					if (parent1 && parent2 && parent1 === parent2) {
						siblingConflicts++;
					} else {
						nonSiblingConflicts++;
					}
				}
			}
		}

		output.warning("Potential file conflicts detected", { conflicts: conflictMap });
		output.info("Serial merge will handle these (later tasks may need rebase)");

		// Log instrumentation data for analysis
		sessionLogger.info(
			{
				totalConflicts: fileConflicts.size,
				siblingConflicts,
				nonSiblingConflicts,
				conflictFiles: Array.from(fileConflicts.keys()),
			},
			"Merge conflict instrumentation",
		);

		// If sibling conflicts dominate, suggest decomposition review
		if (siblingConflicts > nonSiblingConflicts && siblingConflicts > 2) {
			output.info("Most conflicts are between sibling tasks - consider reviewing task decomposition to reduce overlap");
		}
	}

	/**
	 * Push merged commits to remote
	 */
	private async pushMergedCommits(successfulTasks: ParallelTaskResult[]): Promise<void> {
		const mergedCount = successfulTasks.filter((t) => t.merged).length;
		if (mergedCount === 0) {
			return;
		}

		output.progress("Pushing to remote...");
		try {
			const mainRepo = this.worktreeManager.getMainRepoPath();
			const mainBranch = this.worktreeManager.getMainBranch();
			const sanitizedBranch = validateGitRef(mainBranch);
			// Use "--" separator to prevent option injection attacks
			execGitInDir(["push", "origin", "--", sanitizedBranch], mainRepo);
			output.success(`Pushed ${mergedCount} merged commit(s) to origin/${sanitizedBranch}`);
		} catch (pushErr) {
			output.error("Push to remote failed", { error: String(pushErr) });
			output.info("Changes remain in local main. Push manually when ready.");
		}
	}

	/**
	 * Cleanup worktrees after execution
	 * Preserves worktrees with uncommitted work, failed merges, or failed tasks (for investigation)
	 */
	private async cleanupWorktrees(results: ParallelTaskResult[]): Promise<void> {
		output.progress("Cleaning up worktrees...");
		const preserved: string[] = [];
		const preservedForInvestigation: string[] = [];
		const worktreesToDelete: string[] = [];

		for (const r of results) {
			if (r.taskId && r.worktreePath) {
				try {
					// Check if worktree has uncommitted work worth preserving
					const hasUncommittedWork = this.checkWorktreeHasWork(r.worktreePath);
					const mergeFailed = r.result?.status === "complete" && !r.merged;
					const taskFailed = r.result?.status === "failed";

					if (hasUncommittedWork || mergeFailed) {
						preserved.push(r.worktreePath);
						sessionLogger.info(
							{ taskId: r.taskId, worktreePath: r.worktreePath, hasUncommittedWork, mergeFailed },
							"Preserving worktree with unsaved work",
						);
						continue; // Don't remove
					}

					// Preserve failed worktrees for investigation (last N)
					if (taskFailed && r.worktreePath !== process.cwd()) {
						const failedInfo: import("./types.js").FailedWorktreeInfo = {
							taskId: r.taskId,
							task: r.task,
							worktreePath: r.worktreePath,
							branch: r.branch,
							failedAt: new Date().toISOString(),
							error: r.result?.error || "Unknown error",
							model: r.result?.model || "unknown",
							attempts: r.result?.attempts || 0,
						};

						// Add to preserved list, get back list of old worktrees to delete
						const toDelete = this.persistence.addFailedWorktree(failedInfo);
						worktreesToDelete.push(...toDelete);
						preservedForInvestigation.push(r.worktreePath);

						sessionLogger.info(
							{ taskId: r.taskId, worktreePath: r.worktreePath },
							"Preserving failed worktree for investigation",
						);
						continue; // Don't remove
					}

					this.worktreeManager.removeWorktree(r.taskId, true);
				} catch (err) {
					if (this.verbose) {
						output.debug(`Warning: Failed to cleanup ${r.taskId}: ${err}`);
					}
				}
			}
		}

		// Delete old failed worktrees that got bumped from the preservation list
		for (const oldPath of worktreesToDelete) {
			try {
				// Find the taskId from the path
				const match = oldPath.match(/task-([a-z0-9-]+)/i);
				if (match) {
					this.worktreeManager.removeWorktree(match[0], true);
					sessionLogger.debug({ worktreePath: oldPath }, "Removed old failed worktree");
				}
			} catch {
				// Ignore cleanup errors for old worktrees
			}
		}

		if (preserved.length > 0) {
			output.warning(`Preserved ${preserved.length} worktree(s) with unsaved work:`);
			for (const path of preserved) {
				output.info(`  ${path}`);
			}
			output.info("To recover: cd <path> && git status");
		}

		if (preservedForInvestigation.length > 0) {
			output.info(`Preserved ${preservedForInvestigation.length} failed worktree(s) for investigation:`);
			for (const path of preservedForInvestigation) {
				output.info(`  ${path}`);
			}
			output.info("Use 'undercity cleanup --failed-worktrees' to remove them");
		}
	}

	/**
	 * Check if a worktree has uncommitted work worth preserving
	 */
	private checkWorktreeHasWork(worktreePath: string): boolean {
		try {
			// Check for any changes (staged, unstaged, or untracked)
			const status = execFileSync("git", ["status", "--porcelain"], {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
			return status.length > 0;
		} catch {
			return false; // Can't check, assume no work
		}
	}

	/**
	 * Display execution summary
	 * Uses aggregateTaskResults and buildSummaryItems from budget-and-aggregation module.
	 */
	private displaySummary(results: ParallelTaskResult[], durationMs: number): void {
		// Use extracted aggregation logic
		const aggregates = aggregateTaskResults(
			results.map((r) => ({
				task: r.task,
				taskId: r.taskId,
				result: r.result
					? {
							task: r.task,
							status: r.result.status as "complete" | "failed" | "escalated",
							model: normalizeModel(r.result.model as HistoricalModelChoice),
							attempts: r.result.attempts,
							durationMs: r.result.durationMs,
						}
					: null,
				branch: r.branch,
				merged: r.merged,
				decomposed: r.decomposed,
			})),
		);
		const summaryItems = buildSummaryItems(aggregates, durationMs);

		output.summary("Parallel Execution Summary", summaryItems);

		// Check for tasks needing human input (batch-friendly summary)
		try {
			const tasksNeedingInput = getTasksNeedingInput();
			if (tasksNeedingInput.length > 0) {
				output.warning(`${tasksNeedingInput.length} task(s) need human input to retry. Run: undercity human-input`);
			}
		} catch {
			// Non-critical
		}
	}

	/**
	 * Finalize execution with state saves and profile updates
	 */
	private async finalizeExecution(): Promise<void> {
		try {
			this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
			this.persistence.saveFileTracking(this.fileTracker.getState());
		} catch (stateSaveError) {
			output.warning(`State save failed (non-fatal): ${stateSaveError}`);
		}

		try {
			this.markBatchComplete();
		} catch (batchCompleteError) {
			output.warning(`Batch completion tracking failed (non-fatal): ${batchCompleteError}`);
		}

		try {
			const { maybeUpdateProfile } = await import("./self-tuning.js");
			const updated = maybeUpdateProfile(process.cwd(), 5);
			if (updated) {
				output.debug("Routing profile updated from task metrics");
			}
		} catch (tuningError) {
			output.debug(`Self-tuning update failed (non-fatal): ${tuningError}`);
		}

		try {
			const finalUsage = this.rateLimitTracker.getUsageSummary();
			output.metrics("Rate limit usage", {
				fiveHourPercent: (finalUsage.percentages.fiveHour * 100).toFixed(0),
				weeklyPercent: (finalUsage.percentages.weekly * 100).toFixed(0),
			});
		} catch (metricsError) {
			output.debug(`Metrics display failed (non-fatal): ${metricsError}`);
		}
	}

	/**
	 * Build the final batch result object
	 * Uses aggregateTaskResults from budget-and-aggregation module.
	 */
	private buildBatchResult(results: ParallelTaskResult[], durationMs: number): ParallelBatchResult {
		// Use extracted aggregation logic
		const aggregates = aggregateTaskResults(
			results.map((r) => ({
				task: r.task,
				taskId: r.taskId,
				result: r.result
					? {
							task: r.task,
							status: r.result.status as "complete" | "failed" | "escalated",
							model: normalizeModel(r.result.model as HistoricalModelChoice),
							attempts: r.result.attempts,
							durationMs: r.result.durationMs,
						}
					: null,
				branch: r.branch,
				merged: r.merged,
				decomposed: r.decomposed,
			})),
		);

		return {
			results,
			successful: aggregates.successful,
			failed: aggregates.failed,
			merged: aggregates.merged,
			mergeFailed: aggregates.mergeFailed,
			decomposed: aggregates.decomposed,
			durationMs,
		};
	}

	/**
	 * Detect predicted file conflicts before tasks execute
	 * Uses task-file patterns to predict what files each task will modify,
	 * then warns about potential conflicts on documentation/rules files
	 */
	private detectPredictedConflicts(tasks: Array<{ task: string; taskId: string }>): PredictedConflict[] {
		// Get predicted files for each task
		const taskPredictions = new Map<string, string[]>();
		const taskObjectives = new Map<string, string>();

		for (const { task, taskId } of tasks) {
			const relevant = findRelevantFiles(task, 10);
			const predictedFiles = relevant.map((r) => r.file);
			taskPredictions.set(taskId, predictedFiles);
			taskObjectives.set(taskId, task);
		}

		// Use extracted pure function for conflict detection
		return buildPredictedConflicts(taskPredictions, taskObjectives);
	}

	/**
	 * Filter batch tasks by predicted file ownership to prevent conflicts.
	 * Tasks with overlapping high-confidence file predictions are deferred
	 * to a later batch (after the conflicting task completes).
	 */
	private filterConflictingTasks(batchTasks: string[]): {
		execute: string[];
		defer: string[];
	} {
		if (batchTasks.length <= 1) {
			return { execute: batchTasks, defer: [] };
		}

		const execute: string[] = [];
		const defer: string[] = [];
		const fileOwnership = new Map<string, string>();

		for (const task of batchTasks) {
			// Primary: pattern-based predictions with learned weighting
			const predictions = findRelevantFiles(task, 10);
			const highConfidence = predictions.filter((p) => p.score >= 0.5);

			// Fallback: regex-extracted file paths from task description.
			// Covers tasks with no pattern history (new task types, explicit file mentions).
			const claimedFiles =
				highConfidence.length > 0 ? highConfidence.map((p) => p.file) : extractPathsFromObjective(task);

			const hasConflict = claimedFiles.some((f) => fileOwnership.has(f));

			if (hasConflict) {
				defer.push(task);
				output.warning(`Deferred task (predicted conflict): ${task.substring(0, 60)}`);
			} else {
				execute.push(task);
				for (const f of claimedFiles) {
					fileOwnership.set(f, task);
				}
			}
		}

		return { execute, defer };
	}

	/**
	 * Warn about predicted conflicts before batch execution
	 */
	private warnPredictedConflicts(batchTasks: Array<{ task: string; taskId: string }>): void {
		const conflicts = this.detectPredictedConflicts(batchTasks);

		// Filter to only conflict-prone files (docs/rules)
		const highSeverityConflicts = conflicts.filter((c) => c.severity === "error");

		if (highSeverityConflicts.length > 0) {
			output.warning(`Predicted file conflicts detected in batch (may cause merge issues):`);
			for (const conflict of highSeverityConflicts.slice(0, 3)) {
				output.warning(`  ${conflict.file}: ${conflict.tasks.length} tasks`);
			}
			output.info(`Consider running tasks that modify docs/rules files serially (--parallel 1)`);
		}
	}

	/**
	 * Merge a worktree's changes into local main using rebase strategy
	 *
	 * Strategy: Rebase worktree onto local main HEAD, run verification,
	 * then fast-forward merge into local main. No automatic push to origin.
	 */
	private async mergeBranch(_branch: string, taskId: string, worktreePath: string): Promise<void> {
		// Validate worktree path before proceeding
		validateWorktreePath(taskId, worktreePath);

		const mainBranch = this.worktreeManager.getMainBranch();
		const mainRepo = this.worktreeManager.getMainRepoPath();

		// Ensure clean working directory before rebase
		cleanWorktreeDirectory(taskId, worktreePath);

		// Fetch latest local main into the worktree
		fetchMainIntoWorktree(taskId, worktreePath, mainRepo, mainBranch);

		// Rebase onto local main (via FETCH_HEAD from the fetch above)
		await rebaseOntoMain(taskId, worktreePath);

		// Run verification after rebase with fix loop
		await runPostRebaseVerification(taskId, worktreePath, attemptMergeVerificationFix);

		// Merge worktree changes into local main
		mergeIntoLocalMain(taskId, worktreePath, mainRepo, mainBranch);
	}

	// ============== Recovery Methods ==============

	/**
	 * Check if there's an active recovery batch
	 */
	hasActiveRecovery(): boolean {
		// Check new atomic system first
		if (this.persistence.hasActiveTasks()) {
			return true;
		}
		// Fall back to legacy system for backward compatibility
		return this.persistence.hasActiveParallelBatch();
	}

	/**
	 * Get details about any active recovery batch
	 */
	getRecoveryInfo(): {
		batchId: string;
		startedAt: Date;
		tasksTotal: number;
		tasksComplete: number;
		tasksFailed: number;
		tasksPending: number;
	} | null {
		// Try new atomic system first
		const metadata = this.persistence.getBatchMetadata();
		if (metadata) {
			const activeTasks = this.persistence.scanActiveTasks();
			const completedTasks = this.persistence.getCompletedTasks(metadata.batchId);

			if (activeTasks.length === 0 && completedTasks.length === 0) {
				return null;
			}

			const tasksPending = activeTasks.filter((t) => t.status === "pending" || t.status === "running").length;
			const tasksComplete = completedTasks.filter((t) => t.status === "complete" || t.status === "merged").length;
			const tasksFailed = completedTasks.filter((t) => t.status === "failed").length;

			return {
				batchId: metadata.batchId,
				startedAt: new Date(metadata.startedAt),
				tasksTotal: activeTasks.length + completedTasks.length,
				tasksComplete,
				tasksFailed,
				tasksPending,
			};
		}

		// Fall back to legacy system
		const state = this.persistence.getParallelRecoveryState();
		if (!state || state.isComplete) {
			return null;
		}

		const tasksComplete = state.tasks.filter((t) => t.status === "complete" || t.status === "merged").length;
		const tasksFailed = state.tasks.filter((t) => t.status === "failed").length;
		const tasksPending = state.tasks.filter((t) => t.status === "pending" || t.status === "running").length;

		return {
			batchId: state.batchId,
			startedAt: new Date(state.startedAt),
			tasksTotal: state.tasks.length,
			tasksComplete,
			tasksFailed,
			tasksPending,
		};
	}

	/**
	 * Resume an interrupted batch
	 * Returns the pending tasks that need to be re-run
	 */
	async resumeRecovery(): Promise<string[]> {
		// Clear recovered checkpoints from any previous recovery
		this.recoveredCheckpoints.clear();

		// Worktree cleanup function bound to manager
		const removeWorktree = (taskId: string, force: boolean) => this.worktreeManager.removeWorktree(taskId, force);

		// Try new atomic system first
		const activeTasks = this.persistence.scanActiveTasks();
		if (activeTasks.length > 0) {
			const metadata = this.persistence.getBatchMetadata();
			output.progress(`Resuming interrupted batch: ${metadata?.batchId ?? "unknown"}`);

			// Extract checkpoints and cleanup worktrees
			const checkpointsRecovered = extractCheckpointsAndCleanup(
				activeTasks as RecoveryTask[],
				this.recoveredCheckpoints,
				removeWorktree,
			);

			// Get tasks that need to be re-run
			const pendingTasks = activeTasks.map((t) => t.task);
			output.info(formatResumeMessage(pendingTasks.length, checkpointsRecovered));

			// Clear the active tasks - runParallel will create new state
			if (metadata) {
				this.persistence.clearBatch(metadata.batchId);
			}

			return pendingTasks;
		}

		// Fall back to legacy system
		const state = this.persistence.getParallelRecoveryState();
		if (!state || state.isComplete) {
			return [];
		}

		output.progress(`Resuming interrupted batch: ${state.batchId}`);

		// Extract checkpoints and cleanup worktrees
		const checkpointsRecovered = extractCheckpointsAndCleanup(
			state.tasks as RecoveryTask[],
			this.recoveredCheckpoints,
			removeWorktree,
		);

		// Get tasks that need to be re-run
		const pendingTasks = state.tasks.filter((t) => t.status === "pending" || t.status === "running").map((t) => t.task);
		output.info(formatResumeMessage(pendingTasks.length, checkpointsRecovered));

		// Clear the old state - runParallel will create new state
		this.persistence.clearParallelRecoveryState();

		return pendingTasks;
	}

	/**
	 * Abandon an interrupted batch without resuming
	 */
	abandonRecovery(): void {
		// Try new atomic system first
		const metadata = this.persistence.getBatchMetadata();
		if (metadata) {
			output.warning(`Abandoning batch: ${metadata.batchId}`);

			// Clean up any worktrees
			const activeTasks = this.persistence.scanActiveTasks();
			for (const task of activeTasks) {
				if (task.worktreePath) {
					try {
						this.worktreeManager.removeWorktree(task.taskId, true);
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			this.persistence.clearBatch(metadata.batchId);
			output.info("Batch abandoned and cleaned up");
			return;
		}

		// Fall back to legacy system
		const state = this.persistence.getParallelRecoveryState();
		if (!state) {
			return;
		}

		output.warning(`Abandoning batch: ${state.batchId}`);

		// Clean up any worktrees
		for (const task of state.tasks) {
			if (task.worktreePath) {
				try {
					this.worktreeManager.removeWorktree(task.taskId, true);
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		this.persistence.clearParallelRecoveryState();
		output.info("Batch abandoned and cleaned up");
	}

	/**
	 * Save batch metadata and initial task states (atomic per-task)
	 */
	private initializeBatch(
		batchId: string,
		tasks: Array<{ task: string; taskId: string; worktreePath: string; branch: string }>,
	): void {
		// Save batch metadata once
		const metadata: BatchMetadata = {
			batchId,
			startedAt: new Date(),
			model: this.startingModel,
			options: {
				maxConcurrent: this.maxConcurrent,
				autoCommit: this.autoCommit,
				reviewPasses: this.reviewPasses,
				multiLensAtOpus: this.multiLensAtOpus,
			},
		};
		this.persistence.saveBatchMetadata(metadata);

		// Write each task state atomically
		for (const t of tasks) {
			const activeState: ActiveTaskState = {
				taskId: t.taskId,
				task: t.task,
				worktreePath: t.worktreePath,
				branch: t.branch,
				status: "pending",
				batchId,
			};
			this.persistence.writeActiveTask(activeState);
		}
	}

	/**
	 * Update task status atomically
	 */
	private updateTaskStatus(
		taskId: string,
		status: ParallelTaskState["status"],
		extra?: { error?: string; modifiedFiles?: string[] },
	): void {
		if (status === "running") {
			// Update active task status
			this.persistence.updateActiveTaskStatus(taskId, "running", new Date());
		} else if (status === "complete" || status === "failed" || status === "merged") {
			// Move from active/ to completed/
			this.persistence.markTaskCompleted(taskId, status, extra);
		}
	}

	/**
	 * Ralph-style: Check if opus budget allows another opus task
	 * Delegates to budget-and-aggregation module.
	 */
	private canUseOpus(): boolean {
		return canUseOpusBudget(this.opusTasksUsed, this.totalTasksProcessed, this.opusBudgetPercent);
	}

	/**
	 * Mark batch as complete (cleanup)
	 */
	private markBatchComplete(): void {
		// Batch is complete when no active tasks remain
		// Clear batch metadata to signal completion
		if (this.persistence.isBatchComplete()) {
			const metadata = this.persistence.getBatchMetadata();
			if (metadata) {
				this.persistence.clearBatch(metadata.batchId);
			}
		}
	}

	// ============== Worker Health Monitoring (delegated to health-monitoring module) ==============

	/**
	 * Build dependencies for health monitoring
	 */
	private buildHealthMonitorDeps(): HealthMonitorDependencies {
		return {
			scanActiveTasks: () => this.persistence.scanActiveTasks(),
		};
	}
}
