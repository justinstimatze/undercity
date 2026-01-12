/**
 * Parallel Solo Orchestrator
 *
 * Runs multiple SoloOrchestrator instances concurrently in isolated git worktrees.
 * Each task gets its own worktree branched from local main, runs independently,
 * then merges back into local main via serial queue.
 *
 * Flow:
 * 1. Create worktrees from local main HEAD (includes unpushed commits)
 * 2. Run SoloOrchestrators in parallel (one per worktree)
 * 3. Collect results
 * 4. Merge successful branches serially (rebase onto local main → verify → fast-forward merge)
 * 5. Cleanup worktrees
 * 6. User pushes local main to origin when ready
 */

import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { FileTracker } from "./file-tracker.js";
import * as output from "./output.js";
import { Persistence } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import { addTask, loadTaskBoard, removeTasks, saveTaskBoard } from "./task.js";
import { isPlanTask, runPlanner } from "./task-planner.js";
import type { MetaTaskRecommendation, MetaTaskResult, ParallelRecoveryState, ParallelTaskState } from "./types.js";
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
	// Verification retry options
	maxAttempts?: number; // Maximum attempts per task before failing (default: 3)
	maxRetriesPerTier?: number; // Maximum fix attempts at same tier before escalating (default: 3)
	maxReviewPassesPerTier?: number; // Maximum review passes per tier before escalating (default: 2)
	maxOpusReviewPasses?: number; // Maximum review passes at opus tier (default: 6)
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
 * Parallel Solo Orchestrator
 */
export class Orchestrator {
	private maxConcurrent: number;
	private startingModel: "haiku" | "sonnet" | "opus";
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private reviewPasses: boolean;
	private annealingAtOpus: boolean;
	// Verification retry options
	private maxAttempts: number;
	private maxRetriesPerTier: number;
	private maxReviewPassesPerTier: number;
	private maxOpusReviewPasses: number;
	private worktreeManager: WorktreeManager;
	private persistence: Persistence;
	private rateLimitTracker: RateLimitTracker;
	private fileTracker: FileTracker;

	constructor(options: ParallelSoloOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 3;
		this.startingModel = options.startingModel ?? "sonnet";
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.reviewPasses = options.reviewPasses ?? false; // Default to no automatic reviews - use --review flag to enable
		this.annealingAtOpus = options.annealingAtOpus ?? false;
		// Verification retry options with defaults
		this.maxAttempts = options.maxAttempts ?? 3;
		this.maxRetriesPerTier = options.maxRetriesPerTier ?? 3;
		this.maxReviewPassesPerTier = options.maxReviewPassesPerTier ?? 2;
		this.maxOpusReviewPasses = options.maxOpusReviewPasses ?? 6;
		this.worktreeManager = new WorktreeManager();

		// Initialize persistence and trackers
		this.persistence = new Persistence();
		const savedRateLimitState = this.persistence.getRateLimitState();
		this.rateLimitTracker = new RateLimitTracker(savedRateLimitState ?? undefined);

		// Initialize file tracker for conflict detection
		const savedFileTrackingState = this.persistence.getFileTracking();
		this.fileTracker = new FileTracker(savedFileTrackingState);
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
	 * This is the single point where task board mutations happen
	 */
	private processMetaTaskResult(metaResult: MetaTaskResult, taskId: string): void {
		const { metaTaskType, recommendations, summary } = metaResult;

		output.info(`Processing ${metaTaskType} recommendations`, {
			count: recommendations.length,
			summary,
		});

		// Track actions taken
		let removed = 0;
		let added = 0;
		let updated = 0;

		// Group recommendations by confidence for logging
		const highConfidence = recommendations.filter((r) => r.confidence >= 0.8);
		const lowConfidence = recommendations.filter((r) => r.confidence < 0.8);

		if (lowConfidence.length > 0) {
			output.warning(`Skipping ${lowConfidence.length} low-confidence recommendations (< 0.8)`);
		}

		// Only process high-confidence recommendations
		for (const rec of highConfidence) {
			try {
				this.applyRecommendation(rec);
				switch (rec.action) {
					case "remove":
						removed++;
						break;
					case "add":
						added++;
						break;
					default:
						updated++;
				}
			} catch (err) {
				output.warning(`Failed to apply recommendation: ${rec.action} on ${rec.taskId}`, {
					error: String(err),
				});
			}
		}

		// Log summary
		if (removed + added + updated > 0) {
			output.success(`Meta-task ${taskId} applied`, {
				removed,
				added,
				updated,
			});
		}

		// Log metrics if available
		if (metaResult.metrics) {
			output.info(`Task board health: ${metaResult.metrics.healthScore}%`, {
				issuesFound: metaResult.metrics.issuesFound,
				tasksAnalyzed: metaResult.metrics.tasksAnalyzed,
			});
		}
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
	 * It runs SoloOrchestrator directly in the current directory.
	 */
	async runSingle(task: string): Promise<ParallelBatchResult> {
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
			// Run SoloOrchestrator directly in current directory
			const orchestrator = new TaskWorker({
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

			const result = await orchestrator.runTask(task);

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
	 * If only one task is provided and maxConcurrent is 1, runs in direct mode
	 * without worktree overhead.
	 */
	async runParallel(tasks: string[]): Promise<ParallelBatchResult> {
		// Separate plan tasks from implementation tasks
		// Plan tasks are processed first since they generate new tasks
		const planTasks = tasks.filter(isPlanTask);
		const implTasks = tasks.filter((t) => !isPlanTask(t));

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
			"Parallel Solo Mode",
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

			// Save recovery state before running tasks (on first batch, include all prepared so far)
			if (batchStart === 0 && allPreparedTasks.length > 0) {
				const recoveryState = this.createRecoveryState(batchId, allPreparedTasks);
				this.persistence.saveParallelRecoveryState(recoveryState);
				output.debug(`Recovery state saved: ${batchId}`);
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

					// Create orchestrator that runs in the worktree directory
					const orchestrator = new TaskWorker({
						startingModel: this.startingModel,
						autoCommit: this.autoCommit,
						stream: this.stream,
						verbose: this.verbose,
						workingDirectory: worktreePath,
						reviewPasses: this.reviewPasses,
						annealingAtOpus: this.annealingAtOpus,
						maxAttempts: this.maxAttempts,
						maxRetriesPerTier: this.maxRetriesPerTier,
						maxReviewPassesPerTier: this.maxReviewPassesPerTier,
						maxOpusReviewPasses: this.maxOpusReviewPasses,
					});

					const result = await orchestrator.runTask(task);

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

		output.summary("Parallel Solo Summary", summaryItems);

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
		const state = this.persistence.getParallelRecoveryState();
		if (!state || state.isComplete) {
			return [];
		}

		output.progress(`Resuming interrupted batch: ${state.batchId}`);

		// Clean up any stale worktrees from the previous run
		for (const task of state.tasks) {
			if (task.status === "running" && task.worktreePath) {
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

		output.info(`${pendingTasks.length} tasks to resume`);

		// Clear the old state - runParallel will create new state
		this.persistence.clearParallelRecoveryState();

		return pendingTasks;
	}

	/**
	 * Abandon an interrupted batch without resuming
	 */
	abandonRecovery(): void {
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
	 * Create initial recovery state for a new batch
	 */
	private createRecoveryState(
		batchId: string,
		tasks: Array<{ task: string; taskId: string; worktreePath: string; branch: string }>,
	): ParallelRecoveryState {
		const taskStates: ParallelTaskState[] = tasks.map((t) => ({
			taskId: t.taskId,
			task: t.task,
			worktreePath: t.worktreePath,
			branch: t.branch,
			status: "pending",
		}));

		return {
			batchId,
			startedAt: new Date(),
			tasks: taskStates,
			model: this.startingModel,
			options: {
				maxConcurrent: this.maxConcurrent,
				autoCommit: this.autoCommit,
				reviewPasses: this.reviewPasses,
				annealingAtOpus: this.annealingAtOpus,
			},
			isComplete: false,
			lastUpdated: new Date(),
		};
	}

	/**
	 * Update task status in recovery state
	 */
	private updateTaskStatus(
		taskId: string,
		status: ParallelTaskState["status"],
		extra?: { error?: string; modifiedFiles?: string[] },
	): void {
		const state = this.persistence.getParallelRecoveryState();
		if (!state) return;

		const task = state.tasks.find((t) => t.taskId === taskId);
		if (task) {
			task.status = status;
			if (status === "running") {
				task.startedAt = new Date();
			}
			if (status === "complete" || status === "failed" || status === "merged") {
				task.completedAt = new Date();
			}
			if (extra?.error) {
				task.error = extra.error;
			}
			if (extra?.modifiedFiles) {
				task.modifiedFiles = extra.modifiedFiles;
			}
		}

		// Check if batch is complete
		const allDone = state.tasks.every((t) => t.status === "complete" || t.status === "failed" || t.status === "merged");
		state.isComplete = allDone;

		this.persistence.saveParallelRecoveryState(state);
	}

	/**
	 * Mark batch as complete
	 */
	private markBatchComplete(): void {
		const state = this.persistence.getParallelRecoveryState();
		if (state) {
			state.isComplete = true;
			this.persistence.saveParallelRecoveryState(state);
		}
	}
}
