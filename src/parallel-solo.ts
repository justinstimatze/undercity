/**
 * Parallel Solo Orchestrator
 *
 * Runs multiple SoloOrchestrator instances concurrently in isolated git worktrees.
 * Each task gets its own worktree, runs independently, then merges via serial queue.
 *
 * Flow:
 * 1. Create worktrees for each task
 * 2. Run SoloOrchestrators in parallel (one per worktree)
 * 3. Collect results
 * 4. Merge successful branches serially (rebase → test → merge)
 * 5. Cleanup worktrees
 */

import { execSync } from "node:child_process";
import { FileTracker } from "./file-tracker.js";
import * as output from "./output.js";
import { Persistence } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import { SoloOrchestrator, type TaskResult } from "./solo.js";
import type { ParallelRecoveryState, ParallelTaskState } from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface ParallelSoloOptions {
	maxConcurrent?: number; // Max parallel tasks (default: 3)
	startingModel?: "haiku" | "sonnet" | "opus";
	autoCommit?: boolean;
	stream?: boolean;
	verbose?: boolean;
	reviewPasses?: boolean; // Enable escalating review (haiku → sonnet → opus)
	annealingAtOpus?: boolean; // Enable annealing review at opus tier
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
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Generate a unique batch ID
 */
function generateBatchId(): string {
	return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Run a command in a specific directory
 */
function execInDir(command: string, cwd: string): string {
	return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Get the list of modified files in a worktree compared to main branch
 */
function getModifiedFilesInWorktree(worktreePath: string, mainBranch: string): string[] {
	try {
		// Get files that differ from main branch
		const output = execInDir(`git diff --name-only origin/${mainBranch}...HEAD`, worktreePath);
		if (!output) return [];
		return output.split("\n").filter((f) => f.trim().length > 0);
	} catch {
		// If git diff fails, try to get uncommitted changes
		try {
			const output = execInDir("git diff --name-only HEAD", worktreePath);
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
export class ParallelSoloOrchestrator {
	private maxConcurrent: number;
	private startingModel: "haiku" | "sonnet" | "opus";
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private reviewPasses: boolean;
	private annealingAtOpus: boolean;
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
		this.reviewPasses = options.reviewPasses ?? true; // Default to review enabled
		this.annealingAtOpus = options.annealingAtOpus ?? false;
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
	 * Run a single task directly without worktree overhead
	 *
	 * This is an optimization for when only one task needs to run.
	 * It runs SoloOrchestrator directly in the current directory.
	 */
	async runSingle(task: string): Promise<ParallelBatchResult> {
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
			const orchestrator = new SoloOrchestrator({
				startingModel: this.startingModel,
				autoCommit: this.autoCommit,
				stream: this.stream,
				verbose: this.verbose,
				reviewPasses: this.reviewPasses,
				annealingAtOpus: this.annealingAtOpus,
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
		// Optimization: run single task directly without worktree
		if (tasks.length === 1 && this.maxConcurrent <= 1) {
			return this.runSingle(tasks[0]);
		}
		const startTime = Date.now();
		const results: ParallelTaskResult[] = [];

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
			`${tasks.length} tasks (max ${this.maxConcurrent} concurrent) • Model: ${this.startingModel} → escalate if needed`,
		);

		// Show rate limit usage if approaching threshold
		const usageSummary = this.rateLimitTracker.getUsageSummary();
		if (usageSummary.percentages.fiveHour > 0.5 || usageSummary.percentages.weekly > 0.5) {
			output.warning(
				`Rate limit usage: ${(usageSummary.percentages.fiveHour * 100).toFixed(0)}% (5h) / ${(usageSummary.percentages.weekly * 100).toFixed(0)}% (week)`,
			);
		}

		// Get main branch for file tracking
		const mainBranch = this.worktreeManager.getMainBranch();

		// Clear completed file tracking entries from previous runs
		this.fileTracker.clearCompleted();

		// Process tasks in batches of maxConcurrent
		const batchId = generateBatchId();
		const allPreparedTasks: Array<{
			task: string;
			taskId: string;
			worktreePath: string;
			branch: string;
		}> = [];

		const totalBatches = Math.ceil(tasks.length / this.maxConcurrent);

		for (let batchStart = 0; batchStart < tasks.length; batchStart += this.maxConcurrent) {
			const batchEnd = Math.min(batchStart + this.maxConcurrent, tasks.length);
			const batchTasks = tasks.slice(batchStart, batchEnd);
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
					const orchestrator = new SoloOrchestrator({
						startingModel: this.startingModel,
						autoCommit: this.autoCommit,
						stream: this.stream,
						verbose: this.verbose,
						workingDirectory: worktreePath,
						reviewPasses: this.reviewPasses,
						annealingAtOpus: this.annealingAtOpus,
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

		// Record token usage for rate limit tracking
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
				this.rateLimitTracker.recordRateLimitHit(this.startingModel, taskResult.mergeError || taskResult.result?.error);
			}
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

		// Save rate limit state and file tracking state
		this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
		this.persistence.saveFileTracking(this.fileTracker.getState());

		// Mark batch as complete
		this.markBatchComplete();

		// Show updated rate limit usage
		const finalUsage = this.rateLimitTracker.getUsageSummary();
		output.metrics("Rate limit usage", {
			fiveHourPercent: (finalUsage.percentages.fiveHour * 100).toFixed(0),
			weeklyPercent: (finalUsage.percentages.weekly * 100).toFixed(0),
		});

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
	 * Merge a worktree's changes into main using rebase strategy
	 *
	 * Strategy: Work from within the worktree to rebase onto origin/main,
	 * run verification, then push directly to main.
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

		// Fetch latest main into the worktree
		try {
			execInDir(`git fetch origin ${mainBranch}`, worktreePath);
		} catch (fetchError) {
			throw new Error(`Git fetch failed for ${taskId} in ${worktreePath}: ${fetchError}`);
		}

		// Rebase onto origin/main
		try {
			execInDir(`git rebase origin/${mainBranch}`, worktreePath);
		} catch (error) {
			// Abort rebase if it fails
			try {
				execInDir(`git rebase --abort`, worktreePath);
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

		// Push from main repo (worktree push URLs are blocked to prevent agent bypass)
		const mainRepo = this.worktreeManager.getMainRepoPath();
		const worktreeBranch = execInDir(`git rev-parse --abbrev-ref HEAD`, worktreePath).trim();

		try {
			// Get the current commit SHA before detaching
			const commitSha = execInDir(`git rev-parse HEAD`, worktreePath).trim();

			// Detach HEAD in worktree to release the branch lock
			// This prevents "refusing to fetch into branch checked out" error
			execInDir(`git checkout --detach`, worktreePath);

			// Fetch the worktree branch into main repo, then push from there
			execInDir(`git fetch ${worktreePath} ${commitSha}:${worktreeBranch}`, mainRepo);
			execInDir(`git push origin ${worktreeBranch}:${mainBranch}`, mainRepo);
		} catch (pushError) {
			throw new Error(`Push failed for ${taskId}: ${pushError}`);
		}

		// Update local main branch to reflect the pushed changes
		try {
			execInDir(`git fetch origin`, mainRepo);
			execInDir(`git checkout ${mainBranch}`, mainRepo);
			execInDir(`git pull origin ${mainBranch}`, mainRepo);
		} catch {
			// Non-fatal - local update failed but remote push succeeded
			output.debug("Local main branch not updated, but push succeeded");
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
