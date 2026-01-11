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
import { SoloOrchestrator, type TaskResult } from "./solo.js";
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
 * Run a command in a specific directory
 */
function execInDir(command: string, cwd: string): string {
	return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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

	constructor(options: ParallelSoloOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 3;
		this.startingModel = options.startingModel ?? "sonnet";
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.reviewPasses = options.reviewPasses ?? true; // Default to review enabled
		this.annealingAtOpus = options.annealingAtOpus ?? false;
		this.worktreeManager = new WorktreeManager();
	}

	/**
	 * Run multiple tasks in parallel
	 */
	async runParallel(tasks: string[]): Promise<ParallelBatchResult> {
		const startTime = Date.now();
		const results: ParallelTaskResult[] = [];

		// Limit to maxConcurrent
		const tasksToRun = tasks.slice(0, this.maxConcurrent);

		console.log(chalk.cyan.bold(`\n⚡ Parallel Solo Mode`));
		console.log(chalk.dim(`  Running ${tasksToRun.length} tasks concurrently`));
		console.log(chalk.dim(`  Model: ${this.startingModel} → escalate if needed\n`));

		// Phase 1: Create worktrees and prepare tasks
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

		// Phase 2: Run tasks in parallel
		console.log(chalk.cyan(`\n━━━ Executing ${preparedTasks.length} tasks in parallel ━━━\n`));

		const taskPromises = preparedTasks.map(async (prepared) => {
			const { task, taskId, worktreePath, branch } = prepared;

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

				const status = result.status === "complete" ? chalk.green("✓") : chalk.red("✗");
				console.log(chalk.dim(`  [${taskId}] ${status} ${result.status}`));

				return {
					task,
					taskId,
					result,
					worktreePath,
					branch,
					merged: false,
				};
			} catch (error) {
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

		// Phase 3: Merge successful branches serially
		const successfulTasks = results.filter((r) => r.result?.status === "complete" && r.branch);

		if (successfulTasks.length > 0) {
			console.log(chalk.cyan(`\n━━━ Merging ${successfulTasks.length} successful branches ━━━\n`));

			for (const taskResult of successfulTasks) {
				try {
					await this.mergeBranch(taskResult.branch, taskResult.taskId, taskResult.worktreePath);
					taskResult.merged = true;
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
	 * Merge a worktree's changes into main using rebase strategy
	 *
	 * Strategy: Work from within the worktree to rebase onto origin/main,
	 * run verification, then push directly to main.
	 */
	private async mergeBranch(_branch: string, taskId: string, worktreePath: string): Promise<void> {
		const mainBranch = this.worktreeManager.getMainBranch();

		// Fetch latest main into the worktree
		execInDir(`git fetch origin ${mainBranch}`, worktreePath);

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
}
