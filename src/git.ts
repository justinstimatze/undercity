/**
 * Git Operations Module
 *
 * Core git utilities for branch management, merging, and codebase fingerprinting.
 * MergeQueue has been extracted to merge-queue.ts for better separation of concerns.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gitLogger } from "./logger.js";
import type { CodebaseFingerprint } from "./types.js";

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
export function execGit(args: string[], cwd?: string): string {
	const command = `git ${args.join(" ")}`;
	try {
		const result = execFileSync("git", args, {
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
 * Check if repo is incorrectly marked as bare and fix it.
 * This can happen due to race conditions during worktree operations.
 * Returns true if fix was applied.
 */
export function checkAndFixBareRepo(cwd?: string): boolean {
	try {
		const isBare = execGit(["config", "--get", "core.bare"], cwd);
		if (isBare === "true") {
			gitLogger.warn({ cwd }, "Repository incorrectly marked as bare, fixing...");
			execGit(["config", "core.bare", "false"], cwd);
			gitLogger.info({ cwd }, "Fixed bare repository setting");
			return true;
		}
	} catch {
		// core.bare not set or other error, that's fine
	}
	return false;
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
		execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
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
		execFileSync("git", args, {
			encoding: "utf-8",
			stdio: "inherit",
		});
	} catch (error) {
		throw new GitError(`Failed to clone repository: ${String(error)}`, `git ${args.join(" ")}`);
	}
}

/**
 * Get repository URL for a given path
 * @param path Directory path of the git repository
 * @returns Repository remote URL, or null if not available
 */
export function getRepositoryUrl(path: string): string | null {
	try {
		const url = execFileSync("git", ["-C", path, "config", "--get", "remote.origin.url"], {
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
 * Generate a branch name for a session step
 */
export function generateBranchName(sessionId: string, stepId: string): string {
	const timestamp = Date.now().toString(36);
	return `undercity/${sessionId}/${stepId}-${timestamp}`;
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
