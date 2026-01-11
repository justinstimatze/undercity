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
import chalk from "chalk";
import { FileTracker } from "./file-tracker.js";
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
			console.log(chalk.yellow.bold(`\n⏳ Rate Limit Pause Active`));
			console.log(chalk.yellow(`  Reason: ${pauseState.reason || "Rate limit hit"}`));
			console.log(chalk.yellow(`  Remaining: ${remaining}`));

			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		console.log(chalk.cyan.bold(`\n⚡ Solo Mode (Direct)`));
		console.log(chalk.dim(`  Running task directly without worktree`));
		console.log(chalk.dim(`  Model: ${this.startingModel} → escalate if needed\n`));

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
					this.rateLimitTracker.recordQuest(taskId, model, attemptUsage.inputTokens, attemptUsage.outputTokens, {
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
		} catch (error) {
			console.log(chalk.red(`  Error: ${error}`));

			return {
				results: [
					{
						task,
						taskId,
						result: null,
						worktreePath: process.cwd(),
						branch: "current",
						merged: false,
						mergeError: String(error),
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
			console.log(chalk.yellow.bold(`\n⏳ Rate Limit Pause Active`));
			console.log(chalk.yellow(`  Reason: ${pauseState.reason || "Rate limit hit"}`));
			console.log(chalk.yellow(`  Remaining: ${remaining}`));
			console.log(chalk.yellow(`  Resume at: ${pauseState.resumeAt?.toLocaleString() || "unknown"}`));
			console.log(chalk.dim(`\n  Run 'undercity limits' to check rate limit state.`));

			return {
				results: [],
				successful: 0,
				failed: 0,
				merged: 0,
				mergeFailed: 0,
				durationMs: Date.now() - startTime,
			};
		}

		// Limit to maxConcurrent
		const tasksToRun = tasks.slice(0, this.maxConcurrent);

		console.log(chalk.cyan.bold(`\n⚡ Parallel Solo Mode`));
		console.log(chalk.dim(`  Running ${tasksToRun.length} tasks concurrently`));
		console.log(chalk.dim(`  Model: ${this.startingModel} → escalate if needed\n`));

		// Show rate limit usage if approaching threshold
		const usageSummary = this.rateLimitTracker.getUsageSummary();
		if (usageSummary.percentages.fiveHour > 0.5 || usageSummary.percentages.weekly > 0.5) {
			console.log(
				chalk.yellow(
					`  ⚠ Rate limit usage: ${(usageSummary.percentages.fiveHour * 100).toFixed(0)}% (5h) / ${(usageSummary.percentages.weekly * 100).toFixed(0)}% (week)`,
				),
			);
		}

		// Phase 1: Create worktrees and prepare tasks
		const batchId = generateBatchId();
		const preparedTasks: Array<{
			task: string;
			taskId: string;
			worktreePath: string;
			branch: string;
		}> = [];

		for (const task of tasksToRun) {
			const taskId = generateTaskId();
			try {
				const worktreeInfo = this.worktreeManager.createWorktree(taskId);
				preparedTasks.push({
					task,
					taskId,
					worktreePath: worktreeInfo.path,
					branch: worktreeInfo.branch,
				});
				console.log(chalk.green(`  ✓ Created worktree: ${taskId}`));
			} catch (error) {
				console.log(chalk.red(`  ✗ Failed to create worktree: ${error}`));
				results.push({
					task,
					taskId,
					result: null,
					worktreePath: "",
					branch: "",
					merged: false,
					mergeError: `Worktree creation failed: ${error}`,
				});
			}
		}

		// Save recovery state before running tasks
		if (preparedTasks.length > 0) {
			const recoveryState = this.createRecoveryState(batchId, preparedTasks);
			this.persistence.saveParallelRecoveryState(recoveryState);
			console.log(chalk.dim(`  Recovery state saved: ${batchId}`));
		}

		// Phase 2: Run tasks in parallel
		console.log(chalk.cyan(`\n━━━ Executing ${preparedTasks.length} tasks in parallel ━━━\n`));

		// Get main branch for file tracking
		const mainBranch = this.worktreeManager.getMainBranch();

		// Clear completed file tracking entries from previous runs
		this.fileTracker.clearCompleted();

		const taskPromises = preparedTasks.map(async (prepared) => {
			const { task, taskId, worktreePath, branch } = prepared;

			// Start file tracking for this task
			this.fileTracker.startTaskTracking(taskId, taskId);

			// Mark task as running
			this.updateTaskStatus(taskId, "running");

			try {
				console.log(chalk.dim(`  [${taskId}] Starting: ${task.substring(0, 50)}...`));

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
				this.fileTracker.stopQuestTracking(taskId);

				const status = result.status === "complete" ? chalk.green("✓") : chalk.red("✗");
				console.log(chalk.dim(`  [${taskId}] ${status} ${result.status}`));

				if (modifiedFiles.length > 0 && this.verbose) {
					console.log(chalk.dim(`  [${taskId}] Modified ${modifiedFiles.length} files`));
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
			} catch (error) {
				// Stop tracking even on error
				this.fileTracker.stopQuestTracking(taskId);

				// Update recovery state
				this.updateTaskStatus(taskId, "failed", { error: String(error) });

				console.log(chalk.red(`  [${taskId}] Error: ${error}`));
				return {
					task,
					taskId,
					result: null,
					worktreePath,
					branch,
					merged: false,
					mergeError: String(error),
				};
			}
		});

		const parallelResults = await Promise.all(taskPromises);
		results.push(...parallelResults);

		// Record token usage for rate limit tracking
		for (const taskResult of parallelResults) {
			if (taskResult.result?.tokenUsage) {
				// Record each attempt's usage
				for (const attemptUsage of taskResult.result.tokenUsage.attempts) {
					const model = (attemptUsage.model as "haiku" | "sonnet" | "opus") || this.startingModel;
					this.rateLimitTracker.recordQuest(
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
				console.log(chalk.yellow(`\n⚠ Potential file conflicts detected:`));
				for (const [file, taskIds] of fileConflicts) {
					console.log(chalk.yellow(`  ${file}: ${taskIds.join(", ")}`));
				}
				console.log(chalk.dim(`  Serial merge will handle these (later tasks may need rebase)\n`));
			}

			console.log(chalk.cyan(`\n━━━ Merging ${successfulTasks.length} successful branches ━━━\n`));

			for (const taskResult of successfulTasks) {
				try {
					// Check if worktree still exists
					const { existsSync } = await import("node:fs");
					const worktreeExists = existsSync(taskResult.worktreePath);
					if (this.verbose) {
						console.log(chalk.dim(`    Worktree exists: ${worktreeExists} at ${taskResult.worktreePath}`));
					}
					if (!worktreeExists) {
						throw new Error(`Worktree directory missing: ${taskResult.worktreePath}`);
					}
					await this.mergeBranch(taskResult.branch, taskResult.taskId, taskResult.worktreePath);
					taskResult.merged = true;
					this.updateTaskStatus(taskResult.taskId, "merged");
					console.log(chalk.green(`  ✓ Merged: ${taskResult.taskId}`));
				} catch (error) {
					taskResult.mergeError = String(error);
					console.log(chalk.red(`  ✗ Merge failed: ${taskResult.taskId} - ${error}`));
				}
			}
		}

		// Phase 4: Cleanup worktrees
		console.log(chalk.dim(`\n  Cleaning up worktrees...`));
		for (const result of results) {
			if (result.taskId && result.worktreePath) {
				try {
					this.worktreeManager.removeWorktree(result.taskId, true);
				} catch (error) {
					if (this.verbose) {
						console.log(chalk.dim(`  Warning: Failed to cleanup ${result.taskId}: ${error}`));
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

		console.log(chalk.bold(`\n━━━ Parallel Solo Summary ━━━`));
		console.log(`  ${chalk.green("✓")} Successful: ${successful}`);
		console.log(`  ${chalk.red("✗")} Failed: ${failed}`);
		console.log(`  ${chalk.blue("⎇")} Merged: ${merged}`);
		if (mergeFailed > 0) {
			console.log(`  ${chalk.yellow("⚠")} Merge failed: ${mergeFailed}`);
		}
		console.log(`  ${chalk.dim("⏱")}  Duration: ${Math.round(durationMs / 1000)}s`);

		// Save rate limit state and file tracking state
		this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
		this.persistence.saveFileTracking(this.fileTracker.getState());

		// Mark batch as complete
		this.markBatchComplete();

		// Show updated rate limit usage
		const finalUsage = this.rateLimitTracker.getUsageSummary();
		console.log(
			chalk.dim(
				`  📊 Rate limit: ${(finalUsage.percentages.fiveHour * 100).toFixed(0)}% (5h) / ${(finalUsage.percentages.weekly * 100).toFixed(0)}% (week)`,
			),
		);

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
			console.log(chalk.dim(`    Running verification for ${taskId}...`));
			execInDir(`pnpm typecheck`, worktreePath);
			execInDir(`pnpm test --run`, worktreePath);
		} catch (error) {
			throw new Error(`Verification failed for ${taskId}: ${error}`);
		}

		// Push the rebased branch to main
		try {
			execInDir(`git push origin HEAD:${mainBranch}`, worktreePath);
		} catch (error) {
			throw new Error(`Push failed for ${taskId}: ${error}`);
		}

		// Update the main repo to reflect the pushed changes
		const mainRepo = this.worktreeManager.getMainRepoPath();
		try {
			execInDir(`git fetch origin`, mainRepo);
			execInDir(`git checkout ${mainBranch}`, mainRepo);
			execInDir(`git pull origin ${mainBranch}`, mainRepo);
		} catch {
			// Non-fatal - main repo update failed but push succeeded
			console.log(chalk.dim(`    Note: Local main branch not updated, but push succeeded`));
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

		console.log(chalk.yellow.bold(`\n🔄 Resuming interrupted batch: ${state.batchId}`));

		// Clean up any stale worktrees from the previous run
		for (const task of state.tasks) {
			if (task.status === "running" && task.worktreePath) {
				try {
					this.worktreeManager.removeWorktree(task.taskId, true);
					console.log(chalk.dim(`  Cleaned up stale worktree: ${task.taskId}`));
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		// Get tasks that need to be re-run
		const pendingTasks = state.tasks.filter((t) => t.status === "pending" || t.status === "running").map((t) => t.task);

		console.log(chalk.dim(`  ${pendingTasks.length} tasks to resume\n`));

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

		console.log(chalk.yellow(`\n⚠ Abandoning batch: ${state.batchId}`));

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
		console.log(chalk.dim(`  Batch abandoned and cleaned up\n`));
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
