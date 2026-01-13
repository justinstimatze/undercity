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

import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { updateLedger } from "./capability-ledger.js";
import { type ExperimentManager, getExperimentManager } from "./experiment.js";
import { FileTracker } from "./file-tracker.js";
import * as output from "./output.js";
import { Persistence, readTaskAssignment, writeTaskAssignment } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import {
	addTask,
	findSimilarInProgressTask,
	type HandoffContext,
	loadTaskBoard,
	removeTasks,
	saveTaskBoard,
	type Task,
} from "./task.js";
import { isPlanTask, runPlanner } from "./task-planner.js";
import type {
	ActiveTaskState,
	BatchMetadata,
	MetaTaskRecommendation,
	MetaTaskResult,
	ParallelTaskState,
	TaskAssignment,
	TaskCheckpoint,
} from "./types.js";
import { type TaskResult, TaskWorker } from "./worker.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface ParallelSoloOptions {
	maxConcurrent?: number; // Max parallel tasks (default: 3)
	startingModel?: "haiku" | "sonnet" | "opus";
	autoCommit?: boolean;
	stream?: boolean;
	verbose?: boolean;
	reviewPasses?: boolean; // Enable escalating review (haiku → sonnet → opus)
	annealingAtOpus?: boolean; // Enable annealing review at opus tier
	pushOnSuccess?: boolean; // Push to remote after successful merge (default: false)
	// Verification retry options
	maxAttempts?: number; // Maximum attempts per task before failing (default: 7)
	maxRetriesPerTier?: number; // Maximum fix attempts at same tier before escalating (default: 2)
	maxReviewPassesPerTier?: number; // Maximum review passes per tier before escalating (default: 2)
	maxOpusReviewPasses?: number; // Maximum review passes at opus tier (default: 6)
	// Worker health monitoring
	healthCheck?: WorkerHealthConfig;
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
}

export interface ParallelBatchResult {
	results: ParallelTaskResult[];
	successful: number;
	failed: number;
	merged: number;
	mergeFailed: number;
	durationMs: number;
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
 * Validate a directory path before executing commands in it
 */
function validateCwd(cwd: string): void {
	const normalized = normalize(cwd);
	if (!isAbsolute(normalized)) {
		throw new Error(`Invalid cwd: must be absolute path, got ${cwd}`);
	}
	if (!existsSync(normalized)) {
		throw new Error(`Invalid cwd: path does not exist: ${cwd}`);
	}
}

/**
 * Execute a git command in a specific directory (safe from shell injection)
 */
function execGitInDir(args: string[], cwd: string): string {
	validateCwd(cwd);
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Run a shell command in a specific directory (use only for trusted commands)
 */
function execInDir(command: string, cwd: string): string {
	validateCwd(cwd);
	return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Validate a git ref name (branch, tag, etc.) to prevent injection
 */
function validateGitRef(ref: string): void {
	// Git ref names cannot contain: space, ~, ^, :, ?, *, [, \, control chars
	// Also reject shell metacharacters for extra safety
	if (!/^[\w./-]+$/.test(ref)) {
		throw new Error(`Invalid git ref: ${ref}`);
	}
}

/**
 * Get the list of modified files in a worktree compared to main branch
 */
function getModifiedFilesInWorktree(worktreePath: string, mainBranch: string): string[] {
	validateGitRef(mainBranch);
	try {
		// Get files that differ from main branch
		const output = execGitInDir(["diff", "--name-only", `origin/${mainBranch}...HEAD`], worktreePath);
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
 * Main production orchestrator for parallel task execution.
 */
export class Orchestrator {
	private maxConcurrent: number;
	private startingModel: "haiku" | "sonnet" | "opus";
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private reviewPasses: boolean;
	private annealingAtOpus: boolean;
	private pushOnSuccess: boolean;
	// Verification retry options
	private maxAttempts: number;
	private maxRetriesPerTier: number;
	private maxReviewPassesPerTier: number;
	private maxOpusReviewPasses: number;
	private worktreeManager: WorktreeManager;
	private persistence: Persistence;
	private rateLimitTracker: RateLimitTracker;
	private fileTracker: FileTracker;
	private experimentManager: ExperimentManager;
	/** Recovered checkpoints from crashed tasks (task objective → checkpoint) */
	private recoveredCheckpoints: Map<string, TaskCheckpoint> = new Map();
	/** Handoff context from calling Claude Code session (task objective → context) */
	private handoffContexts: Map<string, HandoffContext> = new Map();
	// Worker health monitoring
	private healthCheckEnabled: boolean;
	private healthCheckIntervalMs: number;
	private stuckThresholdMs: number;
	private attemptRecovery: boolean;
	private maxRecoveryAttempts: number;
	/** Track recovery attempts per task (taskId → attempts) */
	private recoveryAttempts: Map<string, number> = new Map();
	/** Active health check interval handle */
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

	constructor(options: ParallelSoloOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 3;
		this.startingModel = options.startingModel ?? "sonnet";
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.reviewPasses = options.reviewPasses ?? false; // Default to no automatic reviews - use --review flag to enable
		this.annealingAtOpus = options.annealingAtOpus ?? false;
		this.pushOnSuccess = options.pushOnSuccess ?? false; // Default to no push - user must explicitly opt in
		// Verification retry options with defaults
		// 7 attempts allows full escalation: 2 haiku + 2 sonnet + 3 opus
		this.maxAttempts = options.maxAttempts ?? 7;
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 2;
		this.maxReviewPassesPerTier = options.maxReviewPassesPerTier ?? 2;
		this.maxOpusReviewPasses = options.maxOpusReviewPasses ?? 6;
		// Health monitoring with defaults
		const healthConfig = options.healthCheck ?? {};
		this.healthCheckEnabled = healthConfig.enabled ?? true;
		this.healthCheckIntervalMs = healthConfig.checkIntervalMs ?? 60_000; // 1 minute
		this.stuckThresholdMs = healthConfig.stuckThresholdMs ?? 300_000; // 5 minutes
		this.attemptRecovery = healthConfig.attemptRecovery ?? true;
		this.maxRecoveryAttempts = healthConfig.maxRecoveryAttempts ?? 2;

		this.worktreeManager = new WorktreeManager();

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

		// Load current task board for validation
		const board = loadTaskBoard();
		const taskIds = new Set(board.tasks.map((t) => t.id));

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
			const validation = this.validateRecommendation(rec, board, taskIds, metaTaskId);

			if (!validation.valid) {
				rejected++;
				rejectionReasons.push(`${rec.action}(${rec.taskId || "new"}): ${validation.reason}`);
				continue;
			}

			// Check sanity limits
			if (rec.action === "remove") {
				removeCount++;
				if (removeCount > board.tasks.length * MAX_REMOVES_PERCENT) {
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
				this.applyRecommendation(rec);
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
	 * Validate a recommendation against the actual task board state.
	 * Returns whether the recommendation should be applied.
	 */
	private validateRecommendation(
		rec: MetaTaskRecommendation,
		board: { tasks: Array<{ id: string; status: string; objective: string }> },
		taskIds: Set<string>,
		metaTaskId: string,
	): { valid: boolean; reason?: string } {
		// Self-protection: don't let meta-task modify itself
		if (rec.taskId === metaTaskId) {
			return { valid: false, reason: "cannot modify self" };
		}

		// Actions that require existing task
		const requiresExistingTask = ["remove", "complete", "fix_status", "prioritize", "update", "block", "unblock"];

		if (requiresExistingTask.includes(rec.action)) {
			if (!rec.taskId) {
				return { valid: false, reason: "missing taskId" };
			}

			if (!taskIds.has(rec.taskId)) {
				return { valid: false, reason: "task does not exist" };
			}

			const task = board.tasks.find((t) => t.id === rec.taskId);
			if (!task) {
				return { valid: false, reason: "task not found" };
			}

			// State transition validation
			switch (rec.action) {
				case "complete":
				case "fix_status":
					if (task.status === "complete") {
						return { valid: false, reason: "task already complete" };
					}
					break;

				case "unblock":
					if (task.status !== "blocked") {
						return { valid: false, reason: "task is not blocked" };
					}
					break;

				case "block":
					if (task.status === "blocked") {
						return { valid: false, reason: "task already blocked" };
					}
					if (task.status === "complete") {
						return { valid: false, reason: "cannot block completed task" };
					}
					break;
			}
		}

		// Validate "add" action
		if (rec.action === "add") {
			if (!rec.newTask?.objective) {
				return { valid: false, reason: "missing objective for new task" };
			}

			// Check for obvious duplicates (exact match)
			const isDuplicate = board.tasks.some((t) => t.objective.toLowerCase() === rec.newTask!.objective.toLowerCase());
			if (isDuplicate) {
				return { valid: false, reason: "duplicate objective" };
			}
		}

		// Validate "merge" action
		if (rec.action === "merge") {
			if (!rec.relatedTaskIds || rec.relatedTaskIds.length === 0) {
				return { valid: false, reason: "merge requires relatedTaskIds" };
			}
			for (const relatedId of rec.relatedTaskIds) {
				if (!taskIds.has(relatedId)) {
					return { valid: false, reason: `related task ${relatedId} does not exist` };
				}
			}
		}

		return { valid: true };
	}

	/**
	 * Apply a single recommendation to the task board
	 */
	private applyRecommendation(rec: MetaTaskRecommendation): void {
		switch (rec.action) {
			case "remove": {
				if (rec.taskId) {
					const removed = removeTasks([rec.taskId]);
					if (removed > 0 && this.verbose) {
						output.debug(`Removed task ${rec.taskId}: ${rec.reason}`);
					}
				}
				break;
			}

			case "add": {
				if (rec.newTask) {
					const task = addTask(rec.newTask.objective, rec.newTask.priority);
					if (this.verbose) {
						output.debug(`Added task ${task.id}: ${rec.newTask.objective.substring(0, 50)}...`);
					}
				}
				break;
			}

			case "complete":
			case "fix_status": {
				if (rec.taskId) {
					const board = loadTaskBoard();
					const task = board.tasks.find((t) => t.id === rec.taskId);
					if (task) {
						task.status = "complete";
						task.completedAt = new Date();
						task.resolution = rec.reason;
						saveTaskBoard(board);
						if (this.verbose) {
							output.debug(`Marked ${rec.taskId} complete: ${rec.reason}`);
						}
					}
				}
				break;
			}

			case "prioritize": {
				if (rec.taskId && rec.updates?.priority !== undefined) {
					const board = loadTaskBoard();
					const task = board.tasks.find((t) => t.id === rec.taskId);
					if (task) {
						task.priority = rec.updates.priority;
						saveTaskBoard(board);
						if (this.verbose) {
							output.debug(`Updated priority for ${rec.taskId} to ${rec.updates.priority}`);
						}
					}
				}
				break;
			}

			case "update": {
				if (rec.taskId && rec.updates) {
					const board = loadTaskBoard();
					const task = board.tasks.find((t) => t.id === rec.taskId);
					if (task) {
						if (rec.updates.objective) task.objective = rec.updates.objective;
						if (rec.updates.priority !== undefined) task.priority = rec.updates.priority;
						if (rec.updates.tags) task.tags = rec.updates.tags;
						saveTaskBoard(board);
						if (this.verbose) {
							output.debug(`Updated task ${rec.taskId}`);
						}
					}
				}
				break;
			}

			case "block": {
				if (rec.taskId) {
					const board = loadTaskBoard();
					const task = board.tasks.find((t) => t.id === rec.taskId);
					if (task) {
						task.status = "blocked";
						task.resolution = rec.reason;
						saveTaskBoard(board);
					}
				}
				break;
			}

			case "unblock": {
				if (rec.taskId) {
					const board = loadTaskBoard();
					const task = board.tasks.find((t) => t.id === rec.taskId);
					if (task && task.status === "blocked") {
						task.status = "pending";
						task.resolution = undefined;
						saveTaskBoard(board);
					}
				}
				break;
			}

			// merge and decompose are more complex - log for manual review
			case "merge":
			case "decompose": {
				output.info(`Recommendation requires manual review: ${rec.action}`, {
					taskId: rec.taskId,
					relatedTaskIds: rec.relatedTaskIds,
					reason: rec.reason,
				});
				break;
			}
		}
	}

	/**
	 * Run a single task directly without worktree overhead
	 *
	 * This is an optimization for when only one task needs to run.
	 * It runs TaskWorker directly in the current directory.
	 */
	async runSingle(taskOrObj: string | Task): Promise<ParallelBatchResult> {
		// Extract objective and handoff context
		const task = typeof taskOrObj === "string" ? taskOrObj : taskOrObj.objective;
		const handoffContext = typeof taskOrObj === "string" ? undefined : taskOrObj.handoffContext;

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
				durationMs: Date.now() - startTime,
			};
		}

		output.header("Solo Mode (Direct)", `Model: ${this.startingModel} → escalate if needed`);

		const taskId = generateTaskId();

		try {
			// Run TaskWorker directly in current directory
			const worker = new TaskWorker({
				startingModel: this.startingModel,
				autoCommit: this.autoCommit,
				stream: this.stream,
				verbose: this.verbose,
				reviewPasses: this.reviewPasses,
				annealingAtOpus: this.annealingAtOpus,
				maxAttempts: this.maxAttempts,
				maxRetriesPerTier: this.maxRetriesPerTier,
				maxReviewPassesPerTier: this.maxReviewPassesPerTier,
				maxOpusReviewPasses: this.maxOpusReviewPasses,
				// No workingDirectory - runs in current directory
			});

			const result = await worker.runTask(task, handoffContext);

			// Record token usage
			if (result.tokenUsage) {
				for (const attemptUsage of result.tokenUsage.attempts) {
					const model = (attemptUsage.model as "haiku" | "sonnet" | "opus") || this.startingModel;
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
		// Extract objectives and store handoff contexts
		const objectives: string[] = [];
		for (const t of tasks) {
			if (typeof t === "string") {
				objectives.push(t);
			} else {
				objectives.push(t.objective);
				// Store handoff context if present
				if (t.handoffContext) {
					this.handoffContexts.set(t.objective, t.handoffContext);
				}
			}
		}

		// Separate plan tasks from implementation tasks
		// Plan tasks are processed first since they generate new tasks
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
				durationMs: 0,
			};
		}

		// Always use worktrees for isolation (even single tasks)
		// This prevents agents from modifying the main repo directly
		const startTime = Date.now();
		const results: ParallelTaskResult[] = [];
		const tasks_to_run = implTasks; // Use implementation tasks only

		// Check if rate limited - try to auto-resume first
		this.rateLimitTracker.checkAutoResume();

		if (this.rateLimitTracker.isPaused()) {
			const pauseState = this.rateLimitTracker.getPauseState();
			const remaining = this.rateLimitTracker.formatRemainingTime();
			output.warning("Rate limit pause active", {
				reason: pauseState.reason || "Rate limit hit",
				remaining,
				resumeAt: pauseState.resumeAt?.toISOString() || "unknown",
			});
			output.info("Run 'undercity limits' to check rate limit state");

			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		output.header(
			"Parallel Mode",
			`${tasks_to_run.length} tasks (max ${this.maxConcurrent} concurrent) • Model: ${this.startingModel} → escalate if needed`,
		);

		// Show rate limit usage if approaching threshold
		const usageSummary = this.rateLimitTracker.getUsageSummary();
		if (usageSummary.percentages.fiveHour > 0.5 || usageSummary.percentages.weekly > 0.5) {
			output.warning(
				`Rate limit usage: ${(usageSummary.percentages.fiveHour * 100).toFixed(0)}% (5h) / ${(usageSummary.percentages.weekly * 100).toFixed(0)}% (week)`,
			);
		}

		// Get main branch for file tracking (with error boundary)
		let mainBranch: string;
		try {
			mainBranch = this.worktreeManager.getMainBranch();
		} catch (branchError) {
			output.warning(`Could not determine main branch, defaulting to 'main': ${branchError}`);
			mainBranch = "main";
		}

		// Clear completed file tracking entries from previous runs (with error boundary)
		try {
			this.fileTracker.clearCompleted();
		} catch (clearError) {
			output.debug(`File tracker cleanup failed (non-fatal): ${clearError}`);
		}

		// Process tasks in batches of maxConcurrent
		const batchId = generateBatchId();
		const allPreparedTasks: Array<{
			task: string;
			taskId: string;
			worktreePath: string;
			branch: string;
		}> = [];

		const totalBatches = Math.ceil(tasks_to_run.length / this.maxConcurrent);

		// Start health monitoring for this batch
		this.startHealthMonitoring();

		for (let batchStart = 0; batchStart < tasks_to_run.length; batchStart += this.maxConcurrent) {
			const batchEnd = Math.min(batchStart + this.maxConcurrent, tasks_to_run.length);
			const batchTasks = tasks_to_run.slice(batchStart, batchEnd);
			const batchNum = Math.floor(batchStart / this.maxConcurrent) + 1;

			output.section(`Batch ${batchNum}/${totalBatches}: Processing ${batchTasks.length} tasks`);

			// Phase 1: Create worktrees for this batch
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
					results.push({
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

				try {
					const worktreeInfo = this.worktreeManager.createWorktree(taskId);
					preparedTasks.push({
						task,
						taskId,
						worktreePath: worktreeInfo.path,
						branch: worktreeInfo.branch,
					});
					output.success(`Created worktree: ${taskId}`);
				} catch (err) {
					output.error(`Failed to create worktree: ${err}`);
					results.push({
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

			allPreparedTasks.push(...preparedTasks);

			// Save recovery state before running tasks (atomic per-task)
			if (batchStart === 0 && preparedTasks.length > 0) {
				// First batch: initialize batch metadata
				this.initializeBatch(batchId, preparedTasks);
				output.debug(`Batch initialized: ${batchId}`);
			} else if (preparedTasks.length > 0) {
				// Subsequent batches: just write each task state
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

			// Phase 2: Run this batch in parallel
			const taskPromises = preparedTasks.map(async (prepared) => {
				const { task, taskId, worktreePath, branch } = prepared;

				// Start file tracking for this task
				this.fileTracker.startTaskTracking(taskId, taskId);

				// Mark task as running
				this.updateTaskStatus(taskId, "running");

				try {
					output.taskStart(taskId, task.substring(0, 50));

					// Check for active experiment and get variant settings
					const variant = this.experimentManager.selectVariant();
					const experimentModel = variant?.model as "haiku" | "sonnet" | "opus" | undefined;
					const experimentReview = variant?.reviewEnabled;

					// Create TaskWorker that runs in the worktree directory
					// Experiment variant overrides default settings if present
					const effectiveModel = experimentModel ?? this.startingModel;
					const effectiveReview = experimentReview ?? this.reviewPasses;

					const worker = new TaskWorker({
						startingModel: effectiveModel,
						autoCommit: this.autoCommit,
						stream: this.stream,
						verbose: this.verbose,
						workingDirectory: worktreePath,
						reviewPasses: effectiveReview,
						annealingAtOpus: this.annealingAtOpus,
						maxAttempts: this.maxAttempts,
						maxRetriesPerTier: this.maxRetriesPerTier,
						maxReviewPassesPerTier: this.maxReviewPassesPerTier,
						maxOpusReviewPasses: this.maxOpusReviewPasses,
					});

					// Write task assignment to worktree (work hook)
					// This enables crash recovery and worker identity detection
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
						// Inject recovered checkpoint if resuming from crash
						checkpoint: this.recoveredCheckpoints.get(task),
					};
					writeTaskAssignment(assignment);

					// Clear the recovered checkpoint after use (one-time injection)
					this.recoveredCheckpoints.delete(task);

					// Get handoff context if available
					const handoffContext = this.handoffContexts.get(task);

					const result = await worker.runTask(task, handoffContext);

					// Get modified files from git diff
					const modifiedFiles = getModifiedFilesInWorktree(worktreePath, mainBranch);

					// Record file operations in tracker
					for (const file of modifiedFiles) {
						this.fileTracker.recordFileAccess(taskId, file, "edit", taskId, worktreePath);
					}

					// Stop tracking for this task
					this.fileTracker.stopTaskTracking(taskId);

					if (result.status === "complete") {
						output.taskComplete(taskId, "Task completed", { modifiedFiles: modifiedFiles.length });

						// Process meta-task recommendations if present
						if (result.metaTaskResult) {
							this.processMetaTaskResult(result.metaTaskResult, taskId);
						}
					} else {
						output.taskFailed(taskId, "Task failed", result.error);
					}

					if (modifiedFiles.length > 0 && this.verbose) {
						output.debug(`[${taskId}] Modified ${modifiedFiles.length} files`);
					}

					// Update recovery state
					const taskStatus = result.status === "complete" ? "complete" : "failed";
					this.updateTaskStatus(taskId, taskStatus, { modifiedFiles });

					// Update capability ledger with task outcome
					try {
						const escalated = result.model !== this.startingModel;
						updateLedger({
							objective: task,
							model: result.model,
							success: result.status === "complete",
							escalated,
						});
					} catch {
						// Silent failure - ledger is optional
					}

					// Record experiment result if variant was assigned
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
					};
				} catch (err) {
					// Stop tracking even on error
					this.fileTracker.stopTaskTracking(taskId);

					// Update recovery state
					this.updateTaskStatus(taskId, "failed", { error: String(err) });

					output.taskFailed(taskId, "Task error", String(err));
					return {
						task,
						taskId,
						result: null,
						worktreePath,
						branch,
						merged: false,
						mergeError: String(err),
					};
				}
			});

			const batchResults = await Promise.all(taskPromises);
			results.push(...batchResults);
		}

		// Record token usage for rate limit tracking (with error boundary)
		try {
			for (const taskResult of results) {
				if (taskResult.result?.tokenUsage) {
					// Record each attempt's usage
					for (const attemptUsage of taskResult.result.tokenUsage.attempts) {
						const model = (attemptUsage.model as "haiku" | "sonnet" | "opus") || this.startingModel;
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

				// Check for rate limit errors
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

		// Phase 3: Merge successful branches serially
		// TODO: Serial merge strategy explained
		// We process merges one at a time to avoid conflicts and maintain consistency:
		// 1. Each task rebases onto the current local main HEAD before merging
		// 2. Fast-forward merge ensures clean history without merge commits
		// 3. If conflicts occur during rebase, the task fails gracefully
		// 4. Later tasks automatically get the latest state from earlier merges
		// 5. This serial approach prevents race conditions in parallel merges
		const successfulTasks = results.filter((r) => r.result?.status === "complete" && r.branch);

		if (successfulTasks.length > 0) {
			// Detect file conflicts between tasks before merging
			const fileConflicts = this.detectFileConflicts(successfulTasks);
			if (fileConflicts.size > 0) {
				const conflictMap: Record<string, string[]> = {};
				for (const [file, taskIds] of fileConflicts) {
					conflictMap[file] = taskIds;
				}
				output.warning("Potential file conflicts detected", { conflicts: conflictMap });
				output.info("Serial merge will handle these (later tasks may need rebase)");
			}

			output.section(`Merging ${successfulTasks.length} successful branches`);

			for (const taskResult of successfulTasks) {
				try {
					// Check if worktree still exists
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
					this.updateTaskStatus(taskResult.taskId, "merged");
					output.success(`Merged: ${taskResult.taskId}`);
				} catch (err) {
					taskResult.mergeError = String(err);
					output.error(`Merge failed: ${taskResult.taskId}`, { error: String(err) });
				}
			}

			// Push to remote if enabled and there were successful merges
			if (this.pushOnSuccess) {
				const mergedCount = successfulTasks.filter((t) => t.merged).length;
				if (mergedCount > 0) {
					output.progress("Pushing to remote...");
					try {
						const mainRepo = this.worktreeManager.getMainRepoPath();
						const mainBranch = this.worktreeManager.getMainBranch();
						validateGitRef(mainBranch);
						execGitInDir(["push", "origin", mainBranch], mainRepo);
						output.success(`Pushed ${mergedCount} merged commit(s) to origin/${mainBranch}`);
					} catch (pushErr) {
						output.error("Push to remote failed", { error: String(pushErr) });
						output.info("Changes remain in local main. Push manually when ready.");
					}
				}
			}
		}

		// Phase 4: Cleanup worktrees
		output.progress("Cleaning up worktrees...");
		for (const r of results) {
			if (r.taskId && r.worktreePath) {
				try {
					this.worktreeManager.removeWorktree(r.taskId, true);
				} catch (err) {
					if (this.verbose) {
						output.debug(`Warning: Failed to cleanup ${r.taskId}: ${err}`);
					}
				}
			}
		}

		// Summary
		const durationMs = Date.now() - startTime;
		const successful = results.filter((r) => r.result?.status === "complete").length;
		const failed = results.filter((r) => r.result?.status === "failed" || r.result === null).length;
		const merged = results.filter((r) => r.merged).length;
		const mergeFailed = successfulTasks.length - merged;

		const summaryItems: Array<{ label: string; value: string | number; status?: "good" | "bad" | "neutral" }> = [
			{ label: "Successful", value: successful, status: successful > 0 ? "good" : "neutral" },
			{ label: "Failed", value: failed, status: failed > 0 ? "bad" : "neutral" },
			{ label: "Merged", value: merged },
			{ label: "Duration", value: `${Math.round(durationMs / 1000)}s` },
		];
		if (mergeFailed > 0) {
			summaryItems.push({ label: "Merge failed", value: mergeFailed, status: "bad" });
		}

		output.summary("Parallel Execution Summary", summaryItems);

		// Save rate limit state and file tracking state (with error boundary)
		try {
			this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
			this.persistence.saveFileTracking(this.fileTracker.getState());
		} catch (stateSaveError) {
			output.warning(`State save failed (non-fatal): ${stateSaveError}`);
		}

		// Mark batch as complete (with error boundary)
		try {
			this.markBatchComplete();
		} catch (batchCompleteError) {
			output.warning(`Batch completion tracking failed (non-fatal): ${batchCompleteError}`);
		}

		// Update routing profile from accumulated metrics (with error boundary)
		try {
			const { maybeUpdateProfile } = await import("./self-tuning.js");
			const updated = maybeUpdateProfile(process.cwd(), 5);
			if (updated) {
				output.debug("Routing profile updated from task metrics");
			}
		} catch (tuningError) {
			output.debug(`Self-tuning update failed (non-fatal): ${tuningError}`);
		}

		// Show updated rate limit usage (with error boundary)
		try {
			const finalUsage = this.rateLimitTracker.getUsageSummary();
			output.metrics("Rate limit usage", {
				fiveHourPercent: (finalUsage.percentages.fiveHour * 100).toFixed(0),
				weeklyPercent: (finalUsage.percentages.weekly * 100).toFixed(0),
			});
		} catch (metricsError) {
			output.debug(`Metrics display failed (non-fatal): ${metricsError}`);
		}

		// Stop health monitoring
		this.stopHealthMonitoring();

		return {
			results,
			successful,
			failed,
			merged,
			mergeFailed,
			durationMs,
		};
	}

	/**
	 * Detect file conflicts between parallel tasks
	 * Returns a map of file -> taskIds that modified it
	 */
	private detectFileConflicts(tasks: ParallelTaskResult[]): Map<string, string[]> {
		const fileToTasks = new Map<string, string[]>();

		for (const task of tasks) {
			if (!task.modifiedFiles) continue;

			for (const file of task.modifiedFiles) {
				const existing = fileToTasks.get(file) || [];
				existing.push(task.taskId);
				fileToTasks.set(file, existing);
			}
		}

		// Filter to only files with multiple tasks
		const conflicts = new Map<string, string[]>();
		for (const [file, taskIds] of fileToTasks) {
			if (taskIds.length > 1) {
				conflicts.set(file, taskIds);
			}
		}

		return conflicts;
	}

	/**
	 * Merge a worktree's changes into local main using rebase strategy
	 *
	 * Strategy: Rebase worktree onto local main HEAD, run verification,
	 * then fast-forward merge into local main. No automatic push to origin.
	 */
	private async mergeBranch(_branch: string, taskId: string, worktreePath: string): Promise<void> {
		const { existsSync, statSync } = await import("node:fs");

		// Validate worktree path before proceeding
		if (!worktreePath) {
			throw new Error(`Worktree path is empty for ${taskId}`);
		}

		if (!existsSync(worktreePath)) {
			throw new Error(`Worktree path does not exist for ${taskId}: ${worktreePath}`);
		}

		try {
			const stats = statSync(worktreePath);
			if (!stats.isDirectory()) {
				throw new Error(`Worktree path is not a directory for ${taskId}: ${worktreePath}`);
			}
		} catch (statError) {
			throw new Error(`Cannot stat worktree path for ${taskId}: ${worktreePath} - ${statError}`);
		}

		const mainBranch = this.worktreeManager.getMainBranch();
		const mainRepo = this.worktreeManager.getMainRepoPath();

		// Fetch latest local main into the worktree
		// This ensures we rebase onto the current state of main, including unpushed commits
		validateGitRef(mainBranch);
		try {
			execGitInDir(["fetch", mainRepo, mainBranch], worktreePath);
		} catch (fetchError) {
			throw new Error(`Git fetch from main repo failed for ${taskId}: ${fetchError}`);
		}

		// Rebase onto local main (via FETCH_HEAD from the fetch above)
		try {
			execGitInDir(["rebase", "FETCH_HEAD"], worktreePath);
		} catch (error) {
			// Abort rebase if it fails
			try {
				execGitInDir(["rebase", "--abort"], worktreePath);
			} catch {
				// Ignore abort errors
			}
			throw new Error(`Rebase failed for ${taskId}: ${error}`);
		}

		// Run verification after rebase (catches any merge issues)
		try {
			output.progress(`Running verification for ${taskId}...`);
			execInDir(`pnpm typecheck`, worktreePath);
			execInDir(`pnpm test --run`, worktreePath);
		} catch (verifyError) {
			throw new Error(`Verification failed for ${taskId}: ${verifyError}`);
		}

		// Merge worktree changes into local main
		// Since worktree already rebased onto local main, this should fast-forward
		try {
			// Get the current commit SHA before detaching
			const commitSha = execGitInDir(["rev-parse", "HEAD"], worktreePath).trim();

			// Detach HEAD in worktree to release the branch lock
			// This prevents "refusing to fetch into branch checked out" error
			execGitInDir(["checkout", "--detach"], worktreePath);

			// Checkout main and fast-forward merge the worktree branch
			execGitInDir(["checkout", mainBranch], mainRepo);
			execGitInDir(["merge", "--ff-only", commitSha], mainRepo);

			output.debug(`Merged ${taskId} into local main (${commitSha.slice(0, 7)})`);
		} catch (mergeError) {
			throw new Error(`Merge into local main failed for ${taskId}: ${mergeError}`);
		}
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

		// Try new atomic system first
		const activeTasks = this.persistence.scanActiveTasks();
		if (activeTasks.length > 0) {
			const metadata = this.persistence.getBatchMetadata();
			output.progress(`Resuming interrupted batch: ${metadata?.batchId ?? "unknown"}`);

			// Extract checkpoints from worktrees before cleaning them up
			for (const task of activeTasks) {
				if (task.status === "running" && task.worktreePath) {
					try {
						// Read the assignment file to get checkpoint data
						const assignment = readTaskAssignment(task.worktreePath);
						if (assignment?.checkpoint) {
							// Store checkpoint keyed by task objective for use in runParallel
							this.recoveredCheckpoints.set(task.task, assignment.checkpoint);
							output.debug(`Recovered checkpoint for: ${task.task.substring(0, 40)}...`);
						}
					} catch {
						// Ignore read errors - checkpoint recovery is best-effort
					}

					// Clean up the stale worktree
					try {
						this.worktreeManager.removeWorktree(task.taskId, true);
						output.debug(`Cleaned up stale worktree: ${task.taskId}`);
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			// Get tasks that need to be re-run
			const pendingTasks = activeTasks.map((t) => t.task);

			const checkpointsRecovered = this.recoveredCheckpoints.size;
			output.info(
				`${pendingTasks.length} tasks to resume${checkpointsRecovered > 0 ? ` (${checkpointsRecovered} with checkpoints)` : ""}`,
			);

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

		// Extract checkpoints from worktrees before cleaning them up
		for (const task of state.tasks) {
			if (task.status === "running" && task.worktreePath) {
				try {
					// Read the assignment file to get checkpoint data
					const assignment = readTaskAssignment(task.worktreePath);
					if (assignment?.checkpoint) {
						// Store checkpoint keyed by task objective for use in runParallel
						this.recoveredCheckpoints.set(task.task, assignment.checkpoint);
						output.debug(`Recovered checkpoint for: ${task.task.substring(0, 40)}...`);
					}
				} catch {
					// Ignore read errors - checkpoint recovery is best-effort
				}

				// Clean up the stale worktree
				try {
					this.worktreeManager.removeWorktree(task.taskId, true);
					output.debug(`Cleaned up stale worktree: ${task.taskId}`);
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		// Get tasks that need to be re-run
		const pendingTasks = state.tasks.filter((t) => t.status === "pending" || t.status === "running").map((t) => t.task);

		const checkpointsRecovered = this.recoveredCheckpoints.size;
		output.info(
			`${pendingTasks.length} tasks to resume${checkpointsRecovered > 0 ? ` (${checkpointsRecovered} with checkpoints)` : ""}`,
		);

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
				annealingAtOpus: this.annealingAtOpus,
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

	// ============== Worker Health Monitoring ==============

	/**
	 * Start periodic health checks for active workers
	 */
	private startHealthMonitoring(): void {
		if (!this.healthCheckEnabled) {
			return;
		}

		// Clear any existing interval
		this.stopHealthMonitoring();

		output.debug(
			`Health monitoring started (check every ${this.healthCheckIntervalMs / 1000}s, stuck after ${this.stuckThresholdMs / 1000}s)`,
		);

		this.healthCheckInterval = setInterval(() => {
			this.checkWorkerHealth();
		}, this.healthCheckIntervalMs);
	}

	/**
	 * Stop health monitoring
	 */
	private stopHealthMonitoring(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		// Clear recovery attempts tracking
		this.recoveryAttempts.clear();
	}

	/**
	 * Check health of all active workers
	 * Detects stuck workers via stale checkpoints
	 */
	private checkWorkerHealth(): void {
		const activeTasks = this.persistence.scanActiveTasks();
		const now = Date.now();

		for (const task of activeTasks) {
			// Only check running tasks (not pending)
			if (task.status !== "running") {
				continue;
			}

			// Read the assignment to get checkpoint timestamp
			const assignment = readTaskAssignment(task.worktreePath);
			if (!assignment?.checkpoint?.savedAt) {
				// No checkpoint yet - check if task has been running too long without one
				if (task.startedAt) {
					const startedAtMs = new Date(task.startedAt).getTime();
					const elapsedMs = now - startedAtMs;
					if (elapsedMs > this.stuckThresholdMs) {
						output.warning(`Worker ${task.taskId} has no checkpoint after ${Math.round(elapsedMs / 1000)}s`);
						this.handleStuckWorker(task.taskId, task.worktreePath, "no_checkpoint");
					}
				}
				continue;
			}

			// Check checkpoint staleness
			const checkpointMs = new Date(assignment.checkpoint.savedAt).getTime();
			const staleDurationMs = now - checkpointMs;

			if (staleDurationMs > this.stuckThresholdMs) {
				const phase = assignment.checkpoint.phase;
				output.warning(`Worker ${task.taskId} stuck in '${phase}' phase for ${Math.round(staleDurationMs / 1000)}s`);
				this.handleStuckWorker(task.taskId, task.worktreePath, phase);
			}
		}
	}

	/**
	 * Handle a stuck worker - attempt recovery or terminate
	 */
	private handleStuckWorker(taskId: string, worktreePath: string, stuckPhase: string): void {
		const attempts = this.recoveryAttempts.get(taskId) ?? 0;

		if (this.attemptRecovery && attempts < this.maxRecoveryAttempts) {
			// Attempt recovery intervention
			this.recoveryAttempts.set(taskId, attempts + 1);
			output.info(`Attempting recovery for ${taskId} (attempt ${attempts + 1}/${this.maxRecoveryAttempts})`);

			// Write a nudge file to the worktree that the worker can detect
			try {
				const nudgePath = `${worktreePath}/.undercity-nudge`;
				const nudgeContent = JSON.stringify(
					{
						timestamp: new Date().toISOString(),
						reason: `Stuck in ${stuckPhase} phase`,
						attempt: attempts + 1,
						message: "Health check detected inactivity. Please continue or report status.",
					},
					null,
					2,
				);
				writeFileSync(nudgePath, nudgeContent, "utf-8");
				output.debug(`Wrote nudge file to ${nudgePath}`);
			} catch (err) {
				output.debug(`Failed to write nudge file: ${err}`);
			}
		} else {
			// Max recovery attempts exceeded - log for manual intervention
			// Note: We don't actually kill the process here because we don't have
			// direct control over the worker process. The worker will eventually
			// timeout or complete. This is just alerting.
			output.error(
				`Worker ${taskId} unresponsive after ${this.maxRecoveryAttempts} recovery attempts. ` +
					`Consider manual intervention or wait for worker timeout.`,
			);

			// Clear recovery attempts since we've given up
			this.recoveryAttempts.delete(taskId);
		}
	}
}
