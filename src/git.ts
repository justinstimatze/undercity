/**
 * Git Operations Module
 *
 * Handles git operations for the serial elevator:
 * - Branch creation
 * - Rebasing
 * - Test running
 * - Merging
 *
 * The serial elevator ensures clean merges by processing
 * one branch at a time: rebase → test → merge.
 */

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gitLogger } from "./logger.js";
import type { CodebaseFingerprint, ElevatorItem, ElevatorRetryConfig } from "./types.js";

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: ElevatorRetryConfig = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

/**
 * Git operation error
 */
export class GitError extends Error {
	constructor(
		message: string,
		public readonly command: string,
		public readonly exitCode?: number,
	) {
		super(message);
		this.name = "GitError";
	}
}

/**
 * Execute a git command and return stdout
 */
function execGit(args: string[], cwd?: string): string {
	const command = `git ${args.join(" ")}`;
	try {
		const result = execSync(command, {
			cwd: cwd || process.cwd(),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return result.trim();
	} catch (error) {
		const execError = error as { status?: number; stderr?: Buffer };
		const stderr = execError.stderr?.toString() || "";
		throw new GitError(stderr || "Git command failed", command, execError.status);
	}
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(): string {
	return execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Get the default branch (usually 'main' or 'master')
 */
export function getDefaultBranch(path?: string): string {
	const cwd = path ? { cwd: path } : undefined;

	try {
		// Try to get from remote HEAD
		const ref = execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd?.cwd);
		return ref.replace("refs/remotes/origin/", "");
	} catch {
		// Fall back to checking if 'main' exists
		try {
			execGit(["rev-parse", "--verify", "main"], cwd?.cwd);
			return "main";
		} catch {
			return "master";
		}
	}
}

/**
 * Resolve a relative path to an absolute path
 * @param basePath Base directory to resolve relative paths against
 * @param relativePath Path to resolve
 * @returns Absolute resolved path
 */
export function resolveRepositoryPath(basePath: string, relativePath: string): string {
	const path = require("node:path");
	return path.isAbsolute(relativePath) ? relativePath : path.resolve(basePath, relativePath);
}

/**
 * Check if a directory is part of a git repository
 * @param path Directory path to check
 * @returns true if path is part of a git repository, false otherwise
 */
export function isInsideGitRepo(path: string): boolean {
	try {
		execSync(`git -C "${path}" rev-parse --is-inside-work-tree`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Perform a shallow clone of a repository to a specified directory
 * @param repoUrl Repository URL to clone
 * @param targetDir Target directory for the clone
 * @param branch Optional specific branch to clone (default is main)
 */
export function shallowCloneRepository(repoUrl: string, targetDir: string, branch?: string): void {
	const args = ["clone", "--depth", "1"];

	if (branch) {
		args.push("-b", branch);
	}

	args.push(repoUrl, targetDir);

	try {
		execSync(args.join(" "), {
			encoding: "utf-8",
			stdio: "inherit",
		});
	} catch (error) {
		throw new GitError(`Failed to clone repository: ${String(error)}`, args.join(" "));
	}
}

/**
 * Get repository URL for a given path
 * @param path Directory path of the git repository
 * @returns Repository remote URL, or null if not available
 */
export function getRepositoryUrl(path: string): string | null {
	try {
		const url = execSync(`git -C "${path}" config --get remote.origin.url`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return url || null;
	} catch {
		return null;
	}
}

/**
 * Check if a branch exists
 */
export function branchExists(branch: string): boolean {
	try {
		execGit(["rev-parse", "--verify", branch]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a new branch from the current HEAD
 */
export function createBranch(name: string): void {
	if (branchExists(name)) {
		throw new GitError(`Branch '${name}' already exists`, `git checkout -b ${name}`);
	}
	execGit(["checkout", "-b", name]);
}

/**
 * Switch to a branch
 */
export function checkoutBranch(name: string): void {
	execGit(["checkout", name]);
}

/**
 * Create and switch to a new branch
 */
export function createAndCheckout(name: string, baseBranch?: string): void {
	const base = baseBranch || getDefaultBranch();
	execGit(["checkout", "-b", name, base]);
}

/**
 * Get the current git status (clean or dirty)
 */
export function isWorkingTreeClean(): boolean {
	const status = execGit(["status", "--porcelain"]);
	return status === "";
}

/**
 * Stash current changes
 */
export function stash(message?: string): void {
	const args = ["stash", "push"];
	if (message) {
		args.push("-m", message);
	}
	execGit(args);
}

/**
 * Pop stashed changes
 */
export function stashPop(): void {
	execGit(["stash", "pop"]);
}

/**
 * Rebase current branch onto target
 */
export function rebase(targetBranch: string): boolean {
	try {
		execGit(["rebase", targetBranch]);
		return true;
	} catch (_error) {
		// Abort on conflict
		try {
			execGit(["rebase", "--abort"]);
		} catch {
			// Ignore abort errors
		}
		return false;
	}
}

/**
 * Merge strategy options for conflict resolution
 */
export type MergeStrategy = "theirs" | "ours" | "default";

/**
 * Get list of files with merge conflicts
 * @returns Array of file paths that have conflicts
 */
export function getConflictFiles(): string[] {
	try {
		// git diff --name-only --diff-filter=U lists files with unmerged changes (conflicts)
		const output = execGit(["diff", "--name-only", "--diff-filter=U"]);
		if (!output) {
			return [];
		}
		return output.split("\n").filter((f) => f.trim().length > 0);
	} catch {
		return [];
	}
}

/**
 * Check if there is a merge in progress
 */
export function isMergeInProgress(): boolean {
	try {
		// Check for MERGE_HEAD which exists during a merge
		execGit(["rev-parse", "--verify", "MERGE_HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Abort an in-progress merge
 */
export function abortMerge(): void {
	try {
		execGit(["merge", "--abort"]);
	} catch {
		// Ignore abort errors
	}
}

/**
 * Result of a merge operation with fallback strategies
 */
export interface MergeResult {
	success: boolean;
	strategyUsed?: MergeStrategy;
	conflictFiles?: string[];
	error?: string;
}

/**
 * Merge a branch into the current branch
 * @param branch - The branch to merge
 * @param message - Optional commit message
 * @param strategy - Conflict resolution strategy: "theirs" (auto-resolve favoring incoming), "ours" (auto-resolve favoring current), or "default" (no auto-resolution)
 */
export function merge(branch: string, message?: string, strategy?: MergeStrategy): boolean {
	try {
		const args = ["merge", "--no-ff"];
		// Add strategy flag for auto-conflict resolution
		if (strategy && strategy !== "default") {
			args.push("-X", strategy);
		}
		args.push(branch);
		if (message) {
			args.push("-m", message);
		}
		execGit(args);
		return true;
	} catch {
		// Abort on conflict
		abortMerge();
		return false;
	}
}

/**
 * Try to merge a branch with fallback strategies
 *
 * OPTIMAL MERGE STRATEGY:
 * 1. Try clean merge (default) - respects all conflicts, most precise
 * 2. Try -X ours - auto-resolve favoring main branch
 * 3. Report only truly unresolvable conflicts
 *
 * This ensures we only report conflicts that can't be automatically resolved.
 *
 * @param branch - The branch to merge
 * @param message - Optional commit message
 * @returns MergeResult with success status, strategy used, and conflict details
 */
export function mergeWithFallback(branch: string, message?: string): MergeResult {
	// Step 1: Try clean merge first (most precise, respects all conflicts)
	gitLogger.debug({ branch, strategy: "default" }, "Attempting clean merge");
	try {
		const args = ["merge", "--no-ff", branch];
		if (message) {
			args.push("-m", message);
		}
		execGit(args);
		gitLogger.info({ branch, strategy: "default" }, "Clean merge succeeded");
		return {
			success: true,
			strategyUsed: "default",
		};
	} catch {
		abortMerge();
		gitLogger.debug({ branch }, "Clean merge failed, trying -X ours");
	}

	// Step 2: Try -X ours (favor main branch, auto-resolve conflicts)
	gitLogger.debug({ branch, strategy: "ours" }, "Attempting merge with -X ours");
	try {
		const args = ["merge", "--no-ff", "-X", "ours", branch];
		if (message) {
			args.push("-m", message);
		}
		execGit(args);
		gitLogger.info({ branch, strategy: "ours" }, "Merge succeeded with -X ours");
		return {
			success: true,
			strategyUsed: "ours",
		};
	} catch {
		abortMerge();
		gitLogger.debug({ branch }, "-X ours failed, conflicts are truly unresolvable");
	}

	// Step 3: All strategies failed - get conflict info for reporting
	gitLogger.debug({ branch }, "All strategies failed, getting conflict info");
	try {
		execGit(["merge", "--no-ff", "--no-commit", branch]);
		// If we somehow get here, commit it
		execGit(["commit", "-m", message || `Merge ${branch}`]);
		return {
			success: true,
			strategyUsed: "default",
		};
	} catch {
		const conflictFiles = getConflictFiles();
		abortMerge();

		gitLogger.warn(
			{ branch, conflictFiles, conflictCount: conflictFiles.length },
			"Merge failed - truly unresolvable conflicts require manual resolution",
		);

		return {
			success: false,
			conflictFiles,
			error: `Truly unresolvable conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
		};
	}
}

/**
 * Delete a branch
 */
export function deleteBranch(branch: string, force = false): void {
	const flag = force ? "-D" : "-d";
	execGit(["branch", flag, branch]);
}

/**
 * Push current branch to origin
 * CRITICAL: This ensures merged work is saved to remote, not just local
 */
export function pushToOrigin(branch?: string): void {
	const args = ["push", "origin"];
	if (branch) {
		args.push(branch);
	}
	execGit(args);
}

/**
 * Run tests using pnpm
 * Returns { success: boolean, output: string }
 */
export async function runTests(cwd?: string): Promise<{ success: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("pnpm", ["test"], {
			cwd: cwd || process.cwd(),
			shell: true,
		});

		let output = "";

		child.stdout.on("data", (data) => {
			output += data.toString();
		});

		child.stderr.on("data", (data) => {
			output += data.toString();
		});

		child.on("close", (code) => {
			resolve({
				success: code === 0,
				output,
			});
		});

		child.on("error", (error) => {
			resolve({
				success: false,
				output: error.message,
			});
		});
	});
}

/**
 * Generate a branch name for a raid waypoint
 */
export function generateBranchName(raidId: string, waypointId: string): string {
	const timestamp = Date.now().toString(36);
	return `undercity/${raidId}/${waypointId}-${timestamp}`;
}

// ============== Codebase Fingerprinting ==============

/**
 * Get the current commit hash (HEAD)
 * @returns The full SHA-1 hash of HEAD, or empty string if not in a git repo
 */
export function getHeadCommitHash(): string {
	try {
		return execGit(["rev-parse", "HEAD"]);
	} catch {
		return "";
	}
}

/**
 * Get the git status in porcelain format (for fingerprinting)
 * @returns Git status output, empty string if clean
 */
export function getWorkingTreeStatus(): string {
	try {
		return execGit(["status", "--porcelain"]);
	} catch {
		return "";
	}
}

/**
 * Calculate a fingerprint of the current codebase state.
 *
 * The fingerprint includes:
 * - Current commit hash (captures committed state)
 * - Working tree status (captures uncommitted changes)
 * - Current branch (for context)
 *
 * @returns CodebaseFingerprint or null if not in a git repository
 */
export function calculateCodebaseFingerprint(): CodebaseFingerprint | null {
	try {
		const commitHash = getHeadCommitHash();
		if (!commitHash) {
			gitLogger.debug("Not in a git repository, cannot calculate fingerprint");
			return null;
		}

		const workingTreeStatus = getWorkingTreeStatus();
		const branch = getCurrentBranch();

		return {
			commitHash,
			workingTreeStatus,
			branch,
			timestamp: new Date(),
		};
	} catch (error) {
		gitLogger.warn({ error }, "Failed to calculate codebase fingerprint");
		return null;
	}
}

/**
 * Create a stable hash from a fingerprint for cache key lookup.
 *
 * Only hashes the commit and working tree status (not timestamp or branch)
 * since those are what actually affect the codebase content.
 *
 * @param fingerprint The codebase fingerprint to hash
 * @returns SHA-256 hash string
 */
export function hashFingerprint(fingerprint: CodebaseFingerprint): string {
	const content = `${fingerprint.commitHash}:${fingerprint.workingTreeStatus}`;
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Create a hash from a goal string for per-goal caching.
 *
 * @param goal The scout goal text
 * @returns SHA-256 hash string
 */
export function hashGoal(goal: string): string {
	// Normalize whitespace for consistent hashing
	const normalized = goal.trim().replace(/\s+/g, " ");
	return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Check if the codebase is in a cacheable state.
 *
 * For conservative caching, we require:
 * - Clean working tree (no uncommitted changes)
 * - Valid git repository
 *
 * @returns true if caching is safe, false otherwise
 */
export function isCacheableState(): boolean {
	try {
		const commitHash = getHeadCommitHash();
		if (!commitHash) {
			return false;
		}
		return isWorkingTreeClean();
	} catch {
		return false;
	}
}

/**
 * Serial Elevator
 *
 * Processes merge items one at a time to avoid conflicts:
 * 1. Checkout the branch
 * 2. Rebase onto main
 * 3. Run tests
 * 4. Merge if tests pass
 * 5. Delete the branch
 *
 * Supports auto-conflict resolution using git merge strategies:
 * - "theirs": Auto-resolve conflicts by accepting incoming changes
 * - "ours": Auto-resolve conflicts by keeping current changes
 * - "default": No auto-resolution, conflicts require manual intervention
 *
 * Retry functionality:
 * - Failed merges are retried after successful merges complete
 * - Uses exponential backoff to prevent system overload
 * - Conflicts may resolve after other branches are merged
 */
export class Elevator {
	private queue: ElevatorItem[] = [];
	private processing = false;
	private mainBranch: string;
	private mergeStrategy: MergeStrategy;
	private retryConfig: ElevatorRetryConfig;

	/**
	 * Create a new elevator
	 * @param mainBranch - The target branch for merges (defaults to main/master)
	 * @param mergeStrategy - Strategy for auto-resolving conflicts (defaults to "theirs" for automatic resolution)
	 * @param retryConfig - Configuration for retry behavior
	 */
	constructor(mainBranch?: string, mergeStrategy?: MergeStrategy, retryConfig?: Partial<ElevatorRetryConfig>) {
		this.mainBranch = mainBranch || getDefaultBranch();
		this.mergeStrategy = mergeStrategy ?? "theirs";
		this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
	}

	/**
	 * Add a branch to the elevator
	 */
	add(branch: string, waypointId: string, agentId: string): ElevatorItem {
		const item: ElevatorItem = {
			branch,
			waypointId,
			agentId,
			status: "pending",
			queuedAt: new Date(),
			retryCount: 0,
			maxRetries: this.retryConfig.maxRetries,
			isRetry: false,
		};
		this.queue.push(item);
		gitLogger.debug({ branch, waypointId, agentId }, "Added to elevator");
		return item;
	}

	/**
	 * Get the current queue
	 */
	getQueue(): ElevatorItem[] {
		return [...this.queue];
	}

	/**
	 * Get the current merge strategy
	 */
	getMergeStrategy(): MergeStrategy {
		return this.mergeStrategy;
	}

	/**
	 * Set the merge strategy for conflict resolution
	 * @param strategy - The strategy to use: "theirs", "ours", or "default"
	 */
	setMergeStrategy(strategy: MergeStrategy): void {
		this.mergeStrategy = strategy;
		gitLogger.debug({ strategy }, "Merge strategy updated");
	}

	/**
	 * Get the current retry configuration
	 */
	getRetryConfig(): ElevatorRetryConfig {
		return { ...this.retryConfig };
	}

	/**
	 * Update retry configuration
	 */
	setRetryConfig(config: Partial<ElevatorRetryConfig>): void {
		this.retryConfig = { ...this.retryConfig, ...config };
		gitLogger.debug({ config: this.retryConfig }, "Retry config updated");
	}

	/**
	 * Calculate the next retry delay using exponential backoff
	 * @param retryCount - Current retry count
	 * @returns Delay in milliseconds
	 */
	private calculateRetryDelay(retryCount: number): number {
		const delay = this.retryConfig.baseDelayMs * 2 ** retryCount;
		return Math.min(delay, this.retryConfig.maxDelayMs);
	}

	/**
	 * Check if a branch is owned by a worktree
	 * @param branch - The branch name to check
	 * @returns true if the branch is checked out in a worktree
	 */
	private isWorktreeBranch(branch: string): boolean {
		try {
			// List all worktrees and check if any have this branch checked out
			const output = execGit(["worktree", "list", "--porcelain"]);
			if (!output.trim()) {
				return false;
			}

			const lines = output.split("\n");
			let currentWorktreeBranch = "";
			let currentWorktreePath = "";

			for (const line of lines) {
				if (line.startsWith("worktree ")) {
					currentWorktreePath = line.substring("worktree ".length);
				} else if (line.startsWith("branch ")) {
					currentWorktreeBranch = line.substring("branch refs/heads/".length);
					// Check if this worktree has our target branch
					if (currentWorktreeBranch === branch) {
						gitLogger.debug({ branch, worktreePath: currentWorktreePath }, "Branch is owned by worktree");
						return true;
					}
				} else if (line === "") {
					// Reset for next worktree
					currentWorktreeBranch = "";
					currentWorktreePath = "";
				}
			}

			return false;
		} catch (error) {
			gitLogger.warn({ branch, error: String(error) }, "Failed to check if branch is in worktree");
			return false;
		}
	}

	/**
	 * Get the worktree path for a branch
	 * @param branch - The branch name
	 * @returns the worktree path if found, null otherwise
	 */
	private getWorktreePath(branch: string): string | null {
		try {
			const output = execGit(["worktree", "list", "--porcelain"]);
			if (!output.trim()) {
				return null;
			}

			const lines = output.split("\n");
			let currentWorktreeBranch = "";
			let currentWorktreePath = "";

			for (const line of lines) {
				if (line.startsWith("worktree ")) {
					currentWorktreePath = line.substring("worktree ".length);
				} else if (line.startsWith("branch ")) {
					currentWorktreeBranch = line.substring("branch refs/heads/".length);
					if (currentWorktreeBranch === branch) {
						return currentWorktreePath;
					}
				} else if (line === "") {
					// Reset for next worktree
					currentWorktreeBranch = "";
					currentWorktreePath = "";
				}
			}

			return null;
		} catch (error) {
			gitLogger.warn({ branch, error: String(error) }, "Failed to get worktree path");
			return null;
		}
	}

	/**
	 * Process a worktree branch safely without checkout conflicts
	 * @param item - The elevator item to process
	 * @returns the processed item
	 */
	private async processWorktreeBranch(item: ElevatorItem, cwd: string): Promise<ElevatorItem> {
		const worktreePath = this.getWorktreePath(item.branch);
		if (!worktreePath) {
			item.status = "conflict";
			item.error = "Could not find worktree path for branch";
			item.completedAt = new Date();
			gitLogger.warn({ branch: item.branch }, "Branch preserved for manual recovery - worktree path not found");
			return item;
		}

		try {
			// Step 1: Rebase in the worktree
			item.status = "rebasing";
			gitLogger.debug({ branch: item.branch, worktreePath, onto: this.mainBranch }, "Rebasing in worktree");

			try {
				execGit(["rebase", this.mainBranch], worktreePath);
			} catch (rebaseError) {
				// Abort the rebase to clean up
				try {
					execGit(["rebase", "--abort"], worktreePath);
				} catch {
					// Ignore abort errors
				}
				item.status = "conflict";
				item.error = "Rebase failed - manual resolution required";
				item.completedAt = new Date();
				gitLogger.warn({ branch: item.branch }, "Branch preserved for manual recovery - rebase failed");
				return item;
			}

			// Step 2: Run tests in the worktree
			item.status = "testing";
			gitLogger.debug({ branch: item.branch, worktreePath }, "Running tests in worktree");
			const testResult = await runTests(worktreePath || cwd);

			if (!testResult.success) {
				item.status = "test_failed";
				item.error = testResult.output;
				item.completedAt = new Date();
				gitLogger.warn({ branch: item.branch }, "Branch preserved for manual recovery - tests failed");
				return item;
			}

			// Step 3: Switch to main in the main repo and merge
			const originalBranch = getCurrentBranch();
			try {
				checkoutBranch(this.mainBranch);

				item.status = "merging";
				gitLogger.debug(
					{ branch: item.branch, into: this.mainBranch },
					"Merging worktree branch with optimal strategy (clean → ours → report)",
				);

				// Use mergeWithFallback for optimal merge strategy:
				// 1. Try clean merge (most precise)
				// 2. Try -X ours (favor main)
				// 3. Report truly unresolvable conflicts
				const mergeResult = mergeWithFallback(item.branch, `Merge ${item.branch} via undercity`);

				if (!mergeResult.success) {
					item.status = "conflict";
					item.error = mergeResult.error || "Merge failed - manual resolution required";
					item.conflictFiles = mergeResult.conflictFiles;
					item.completedAt = new Date();
					gitLogger.warn(
						{ branch: item.branch, conflictFiles: mergeResult.conflictFiles },
						"Branch preserved for manual recovery - truly unresolvable conflicts",
					);
					return item;
				}

				// Record which strategy succeeded
				item.strategyUsed = mergeResult.strategyUsed;
				if (mergeResult.strategyUsed !== "default") {
					gitLogger.info(
						{ branch: item.branch, strategy: mergeResult.strategyUsed },
						"Merge succeeded with fallback strategy",
					);
				}

				// Step 4: Push to origin - CRITICAL to save work remotely
				item.status = "pushing";
				try {
					pushToOrigin(this.mainBranch);
					gitLogger.info({ branch: this.mainBranch }, "Pushed merge to origin");
				} catch (pushError) {
					// Push failure is serious but don't fail the whole merge
					// Work is on local main, user can push manually
					gitLogger.error(
						{ branch: this.mainBranch, error: String(pushError) },
						"Failed to push to origin - work is on local main, push manually",
					);
				}

				// Step 5: On successful merge, we can safely delete the branch
				// The worktree cleanup will happen separately via WorktreeManager
				try {
					// First remove the worktree to release the branch lock
					execGit(["worktree", "remove", worktreePath, "--force"]);
					gitLogger.debug({ branch: item.branch, worktreePath }, "Removed worktree after successful merge");
				} catch (worktreeError) {
					gitLogger.warn(
						{ branch: item.branch, error: String(worktreeError) },
						"Failed to remove worktree, but merge succeeded",
					);
				}

				// Now delete the branch
				try {
					deleteBranch(item.branch);
				} catch (branchError) {
					gitLogger.warn({ branch: item.branch, error: String(branchError) }, "Failed to delete branch after merge");
				}

				item.status = "complete";
				item.completedAt = new Date();

				// Remove from queue
				this.queue = this.queue.filter((i) => i !== item);

				gitLogger.info({ branch: item.branch, waypointId: item.waypointId }, "Worktree branch merge complete");
				return item;
			} finally {
				// Return to original branch
				try {
					checkoutBranch(originalBranch);
				} catch {
					// Best effort
				}
			}
		} catch (error) {
			item.status = "conflict";
			item.error = error instanceof Error ? error.message : String(error);
			item.completedAt = new Date();
			gitLogger.warn({ branch: item.branch, error: item.error }, "Branch preserved for manual recovery");
			return item;
		}
	}

	/**
	 * Check if an item is eligible for retry
	 * @param item - The elevator item to check
	 * @returns true if the item can be retried
	 */
	private canRetry(item: ElevatorItem): boolean {
		if (!this.retryConfig.enabled) {
			return false;
		}

		const maxRetries = item.maxRetries ?? this.retryConfig.maxRetries;
		const retryCount = item.retryCount ?? 0;

		if (retryCount >= maxRetries) {
			return false;
		}

		// Check if we've waited long enough (exponential backoff)
		if (item.nextRetryAfter && new Date() < item.nextRetryAfter) {
			return false;
		}

		return true;
	}

	/**
	 * Mark an item for retry with updated retry tracking
	 * @param item - The item to prepare for retry
	 */
	private prepareForRetry(item: ElevatorItem): void {
		const retryCount = (item.retryCount ?? 0) + 1;
		const delay = this.calculateRetryDelay(retryCount);

		// Preserve original error on first failure
		if (!item.originalError && item.error) {
			item.originalError = item.error;
		}

		item.retryCount = retryCount;
		item.lastFailedAt = new Date();
		item.nextRetryAfter = new Date(Date.now() + delay);
		item.status = "pending";
		item.isRetry = true;
		item.completedAt = undefined;
		item.error = undefined;

		gitLogger.info(
			{
				branch: item.branch,
				retryCount,
				nextRetryAfter: item.nextRetryAfter,
				delay,
			},
			"Item prepared for retry",
		);
	}

	/**
	 * Process the next item in the queue
	 */
	async processNext(): Promise<ElevatorItem | null> {
		if (this.processing) {
			return null;
		}

		const item = this.queue.find((i) => i.status === "pending");
		if (!item) {
			return null;
		}

		this.processing = true;
		const originalBranch = getCurrentBranch();
		const cwd = process.cwd(); // Capture current working directory
		let branchPreserved = false;

		try {
			// Check if this branch is owned by a worktree
			const isWorktreeBranch = this.isWorktreeBranch(item.branch);

			if (isWorktreeBranch) {
				// CRITICAL FIX: For worktree branches, merge from the worktree location
				// This avoids the checkout conflict and preserves all work
				gitLogger.debug({ branch: item.branch }, "Detected worktree branch, merging from worktree");
				return await this.processWorktreeBranch(item, cwd);
			}

			// Legacy path: For non-worktree branches, use the original approach
			// Step 1: Checkout the branch
			gitLogger.debug({ branch: item.branch }, "Checking out branch");
			checkoutBranch(item.branch);

			// Step 2: Rebase onto main
			item.status = "rebasing";
			gitLogger.debug({ branch: item.branch, onto: this.mainBranch }, "Rebasing");
			const rebaseSuccess = rebase(this.mainBranch);

			if (!rebaseSuccess) {
				item.status = "conflict";
				item.error = "Rebase failed - manual resolution required";
				item.completedAt = new Date();
				branchPreserved = true; // Preserve branch for manual recovery
				return item;
			}

			// Step 3: Run tests (in the main repository where we checked out)
			item.status = "testing";
			gitLogger.debug({ branch: item.branch }, "Running tests");
			const testResult = await runTests(cwd);

			if (!testResult.success) {
				item.status = "test_failed";
				item.error = testResult.output;
				item.completedAt = new Date();
				branchPreserved = true; // Preserve branch for manual recovery
				return item;
			}

			// Step 4: Merge into main with optimal strategy (clean → ours → report)
			checkoutBranch(this.mainBranch);
			item.status = "merging";
			gitLogger.debug(
				{ branch: item.branch, into: this.mainBranch },
				"Merging with optimal strategy (clean → ours → report)",
			);

			const mergeResult = mergeWithFallback(item.branch, `Merge ${item.branch} via undercity`);

			if (!mergeResult.success) {
				item.status = "conflict";
				item.error = mergeResult.error || "Merge failed - manual resolution required";
				item.conflictFiles = mergeResult.conflictFiles;
				item.completedAt = new Date();
				branchPreserved = true; // Preserve branch for manual recovery
				gitLogger.warn(
					{ branch: item.branch, conflictFiles: mergeResult.conflictFiles },
					"Branch preserved for manual recovery - truly unresolvable conflicts",
				);
				return item;
			}

			// Record which strategy succeeded
			item.strategyUsed = mergeResult.strategyUsed;
			if (mergeResult.strategyUsed !== "default") {
				gitLogger.info(
					{ branch: item.branch, strategy: mergeResult.strategyUsed },
					"Merge succeeded with fallback strategy",
				);
			}

			// Step 5: Delete the branch (only on success)
			deleteBranch(item.branch);
			item.status = "complete";
			item.completedAt = new Date();

			// Remove from queue
			this.queue = this.queue.filter((i) => i !== item);

			gitLogger.info({ branch: item.branch, waypointId: item.waypointId }, "Merge complete");
			return item;
		} catch (error) {
			item.status = "conflict";
			item.error = error instanceof Error ? error.message : String(error);
			item.completedAt = new Date();
			branchPreserved = true; // Preserve branch for manual recovery
			gitLogger.warn({ branch: item.branch, error: item.error }, "Branch preserved for manual recovery");
			return item;
		} finally {
			// Return to original branch
			try {
				checkoutBranch(originalBranch);
			} catch {
				// Best effort
			}
			this.processing = false;
		}
	}

	/**
	 * Process all items in the queue sequentially.
	 *
	 * This method continues processing even when items fail, rather than
	 * stopping at the first failure. After each successful merge, it will
	 * retry any eligible failed items (conflicts may have resolved).
	 *
	 * @returns Array of processed items with their final statuses
	 */
	async processAll(): Promise<ElevatorItem[]> {
		const results: ElevatorItem[] = [];
		let hadSuccess = false;

		let item = await this.processNext();
		while (item) {
			results.push(item);

			if (item.status === "complete") {
				hadSuccess = true;
				gitLogger.info({ branch: item.branch }, "Merge succeeded");

				// After a successful merge, retry failed items
				// (conflicts may now be resolvable)
				if (this.retryConfig.enabled) {
					const retryResults = await this.retryFailed();
					if (retryResults.length > 0) {
						results.push(...retryResults);
						// Check if any retries succeeded
						hadSuccess = hadSuccess || retryResults.some((r) => r.status === "complete");
					}
				}
			} else {
				gitLogger.warn(
					{
						branch: item.branch,
						status: item.status,
						error: item.error,
						retryCount: item.retryCount,
						isRetry: item.isRetry,
					},
					"Merge failed, continuing with next item",
				);
			}

			// Continue processing remaining pending items
			item = await this.processNext();
		}

		return results;
	}

	/**
	 * Retry failed merge items that are eligible for retry.
	 *
	 * This is called automatically after successful merges in processAll(),
	 * but can also be called manually. Failed merges may succeed after
	 * other branches are merged (conflicts may resolve).
	 *
	 * Uses the mergeWithFallback() function for better conflict resolution.
	 *
	 * @returns Array of retry attempt results
	 */
	async retryFailed(): Promise<ElevatorItem[]> {
		const results: ElevatorItem[] = [];
		const failedItems = this.getFailed().filter((item) => this.canRetry(item));

		if (failedItems.length === 0) {
			return results;
		}

		gitLogger.info({ eligibleCount: failedItems.length }, "Retrying eligible failed items after successful merge");

		for (const item of failedItems) {
			// Prepare the item for retry
			this.prepareForRetry(item);

			gitLogger.info(
				{
					branch: item.branch,
					retryCount: item.retryCount,
					originalError: item.originalError,
				},
				"Retrying failed merge",
			);

			// Process this item
			const result = await this.processNext();
			if (result) {
				results.push(result);

				if (result.status === "complete") {
					gitLogger.info(
						{
							branch: result.branch,
							retryCount: result.retryCount,
						},
						"Retry succeeded - conflict resolved after other merges",
					);
				} else {
					gitLogger.warn(
						{
							branch: result.branch,
							status: result.status,
							retryCount: result.retryCount,
							maxRetries: result.maxRetries,
							error: result.error,
						},
						"Retry failed",
					);
				}
			}
		}

		return results;
	}

	/**
	 * Get items that failed (conflict or test failure)
	 */
	getFailed(): ElevatorItem[] {
		return this.queue.filter((i) => i.status === "conflict" || i.status === "test_failed");
	}

	/**
	 * Get items that are eligible for retry
	 */
	getRetryable(): ElevatorItem[] {
		return this.getFailed().filter((item) => this.canRetry(item));
	}

	/**
	 * Get items that have exhausted all retries
	 */
	getExhausted(): ElevatorItem[] {
		return this.getFailed().filter((item) => !this.canRetry(item));
	}

	/**
	 * Clear failed items from the queue
	 */
	clearFailed(): void {
		this.queue = this.queue.filter((i) => i.status !== "conflict" && i.status !== "test_failed");
	}

	/**
	 * Clear only exhausted items (those that have used all retries)
	 */
	clearExhausted(): void {
		const exhausted = this.getExhausted();
		this.queue = this.queue.filter((i) => !exhausted.includes(i));
	}

	/**
	 * Get a summary of queue status including retry information
	 */
	getQueueSummary(): {
		total: number;
		pending: number;
		failed: number;
		retryable: number;
		exhausted: number;
		complete: number;
	} {
		const pending = this.queue.filter((i) => i.status === "pending").length;
		const failed = this.getFailed().length;
		const retryable = this.getRetryable().length;
		const exhausted = this.getExhausted().length;

		return {
			total: this.queue.length,
			pending,
			failed,
			retryable,
			exhausted,
			complete: 0, // Complete items are removed from queue
		};
	}
}
