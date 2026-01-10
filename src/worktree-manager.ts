/**
 * Git Worktree Manager Module
 *
 * Manages isolated git worktrees for raid branches to enable parallel raids
 * while keeping the main repo always available on the main branch.
 *
 * Key Features:
 * - Creates isolated worktrees in .undercity/worktrees/<raid-id>/
 * - Enables parallel raids without branch switching in main repo
 * - Proper cleanup and error handling
 * - State tracking for active worktrees
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { gitLogger } from "./logger.js";
import type { WorktreeInfo } from "./types.js";

/**
 * Git worktree operation error
 */
export class WorktreeError extends Error {
	constructor(
		message: string,
		public readonly command: string,
		public readonly exitCode?: number,
	) {
		super(message);
		this.name = "WorktreeError";
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
		throw new WorktreeError(stderr || "Git command failed", command, execError.status);
	}
}

/**
 * Get the repository root directory
 */
function getRepoRoot(): string {
	try {
		return execGit(["rev-parse", "--show-toplevel"]);
	} catch (_error) {
		throw new WorktreeError("Not in a git repository", "git rev-parse --show-toplevel");
	}
}

/**
 * Get the default branch (usually 'main' or 'master')
 */
function getDefaultBranch(): string {
	try {
		// Try to get from remote HEAD
		const ref = execGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		return ref.replace("refs/remotes/origin/", "");
	} catch {
		// Fall back to checking if 'main' exists
		try {
			execGit(["rev-parse", "--verify", "main"]);
			return "main";
		} catch {
			return "master";
		}
	}
}

/**
 * Check if a worktree path exists
 */
function worktreePathExists(worktreePath: string): boolean {
	return existsSync(worktreePath);
}

/**
 * Fetch latest from origin to ensure we have up-to-date refs
 */
function fetchOrigin(): void {
	try {
		gitLogger.debug("Fetching latest from origin");
		execGit(["fetch", "origin"]);
	} catch (error) {
		// Log but don't fail - we can still work with local refs
		gitLogger.warn({ error: String(error) }, "Failed to fetch from origin, using local refs");
	}
}

/**
 * Manages git worktrees for raid isolation
 */
export class WorktreeManager {
	private repoRoot: string;
	private undercityDir: string;
	private worktreesDir: string;
	private mainBranch: string;

	constructor(stateDir?: string) {
		this.repoRoot = getRepoRoot();
		this.undercityDir = stateDir || join(this.repoRoot, ".undercity");
		this.worktreesDir = join(this.undercityDir, "worktrees");
		this.mainBranch = getDefaultBranch();

		// Ensure directories exist
		if (!existsSync(this.undercityDir)) {
			mkdirSync(this.undercityDir, { recursive: true });
		}
		if (!existsSync(this.worktreesDir)) {
			mkdirSync(this.worktreesDir, { recursive: true });
		}
	}

	/**
	 * Get the worktree directory path for a raid
	 */
	getWorktreePath(raidId: string): string {
		return join(this.worktreesDir, raidId);
	}

	/**
	 * Get the branch name for a raid's worktree
	 */
	getWorktreeBranchName(raidId: string): string {
		return `undercity/${raidId}/worktree`;
	}

	/**
	 * Create a new worktree for a raid
	 */
	createWorktree(raidId: string): WorktreeInfo {
		const worktreePath = this.getWorktreePath(raidId);
		const branchName = this.getWorktreeBranchName(raidId);

		gitLogger.info({ raidId, worktreePath, branchName }, "Creating raid worktree");

		// Check if worktree already exists
		if (worktreePathExists(worktreePath)) {
			throw new WorktreeError(`Worktree already exists for raid ${raidId} at ${worktreePath}`, "git worktree add");
		}

		// CRITICAL: Fetch latest from origin before creating worktree
		// This ensures we branch from the latest main, not a stale local copy
		fetchOrigin();
		const baseBranch = `origin/${this.mainBranch}`;

		try {
			// Create the worktree with a new branch from origin/main (latest)
			gitLogger.debug({ baseBranch }, "Creating worktree from latest origin");
			execGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch]);

			const worktreeInfo: WorktreeInfo = {
				raidId,
				path: worktreePath,
				branch: branchName,
				createdAt: new Date(),
				isActive: true,
			};

			gitLogger.info({ raidId, worktreePath, branchName }, "Worktree created successfully");
			return worktreeInfo;
		} catch (error) {
			if (error instanceof WorktreeError) {
				throw error;
			}
			throw new WorktreeError(`Failed to create worktree for raid ${raidId}: ${String(error)}`, "git worktree add");
		}
	}

	/**
	 * Remove a worktree for a raid
	 */
	removeWorktree(raidId: string, force = false): void {
		const worktreePath = this.getWorktreePath(raidId);
		const branchName = this.getWorktreeBranchName(raidId);

		gitLogger.info({ raidId, worktreePath, branchName, force }, "Removing raid worktree");

		try {
			// Remove the worktree
			const removeArgs = ["worktree", "remove"];
			if (force) {
				removeArgs.push("--force");
			}
			removeArgs.push(worktreePath);

			try {
				execGit(removeArgs);
			} catch (error) {
				// If worktree remove fails, try to clean up manually
				if (worktreePathExists(worktreePath)) {
					gitLogger.warn({ raidId, error: String(error) }, "Worktree remove failed, cleaning up manually");
					rmSync(worktreePath, { recursive: true, force: true });
				}
			}

			// Clean up the branch
			try {
				execGit(["branch", "-D", branchName]);
			} catch (error) {
				gitLogger.warn({ raidId, branchName, error: String(error) }, "Failed to delete worktree branch");
			}

			// Prune worktree references
			try {
				execGit(["worktree", "prune"]);
			} catch (error) {
				gitLogger.warn({ error: String(error) }, "Failed to prune worktree references");
			}

			gitLogger.info({ raidId, worktreePath, branchName }, "Worktree removed successfully");
		} catch (error) {
			const errorMsg = error instanceof WorktreeError ? error.message : String(error);
			gitLogger.error({ raidId, error: errorMsg }, "Failed to remove worktree");
			throw new WorktreeError(`Failed to remove worktree for raid ${raidId}: ${errorMsg}`, "git worktree remove");
		}
	}

	/**
	 * List all existing worktrees
	 */
	listWorktrees(): Array<{ path: string; branch: string; commit: string }> {
		try {
			const output = execGit(["worktree", "list", "--porcelain"]);
			if (!output.trim()) {
				return [];
			}

			const lines = output.split("\n");
			const worktrees: Array<{ path: string; branch: string; commit: string }> = [];

			let current = { path: "", branch: "", commit: "" };
			for (const line of lines) {
				if (line.startsWith("worktree ")) {
					current.path = line.substring("worktree ".length);
				} else if (line.startsWith("branch ")) {
					current.branch = line.substring("branch refs/heads/".length);
				} else if (line.startsWith("HEAD ")) {
					current.commit = line.substring("HEAD ".length);
				} else if (line === "") {
					// End of worktree block
					if (current.path) {
						worktrees.push({ ...current });
						current = { path: "", branch: "", commit: "" };
					}
				}
			}

			// Handle case where last worktree doesn't end with blank line
			if (current.path) {
				worktrees.push(current);
			}

			return worktrees;
		} catch (error) {
			gitLogger.warn({ error: String(error) }, "Failed to list worktrees");
			return [];
		}
	}

	/**
	 * Get active raid worktrees (those in our managed directory)
	 */
	getActiveRaidWorktrees(): WorktreeInfo[] {
		const allWorktrees = this.listWorktrees();
		const raidWorktrees: WorktreeInfo[] = [];

		for (const worktree of allWorktrees) {
			// Check if this worktree is in our managed directory
			if (worktree.path.startsWith(this.worktreesDir)) {
				const raidId = basename(worktree.path);

				// Verify it matches our naming convention
				if (worktree.branch.startsWith(`undercity/${raidId}/worktree`)) {
					raidWorktrees.push({
						raidId,
						path: worktree.path,
						branch: worktree.branch,
						createdAt: new Date(), // We don't track creation time in git, use current time
						isActive: true,
					});
				}
			}
		}

		return raidWorktrees;
	}

	/**
	 * Check if a worktree exists for a raid
	 */
	hasWorktree(raidId: string): boolean {
		const worktreePath = this.getWorktreePath(raidId);
		return worktreePathExists(worktreePath);
	}

	/**
	 * Get worktree info for a specific raid
	 */
	getWorktreeInfo(raidId: string): WorktreeInfo | null {
		if (!this.hasWorktree(raidId)) {
			return null;
		}

		const worktreePath = this.getWorktreePath(raidId);
		const branchName = this.getWorktreeBranchName(raidId);

		return {
			raidId,
			path: worktreePath,
			branch: branchName,
			createdAt: new Date(), // We don't track creation time, use current time
			isActive: true,
		};
	}

	/**
	 * Cleanup orphaned worktrees (worktrees that exist but no corresponding raid)
	 */
	cleanupOrphanedWorktrees(activeRaidIds: string[]): void {
		const activeSet = new Set(activeRaidIds);
		const raidWorktrees = this.getActiveRaidWorktrees();

		for (const worktree of raidWorktrees) {
			if (!activeSet.has(worktree.raidId)) {
				gitLogger.info({ raidId: worktree.raidId }, "Cleaning up orphaned worktree");
				try {
					this.removeWorktree(worktree.raidId, true);
				} catch (error) {
					gitLogger.error({ raidId: worktree.raidId, error: String(error) }, "Failed to cleanup orphaned worktree");
				}
			}
		}
	}

	/**
	 * Get the main repository path (for operations that need to run in main repo)
	 */
	getMainRepoPath(): string {
		return this.repoRoot;
	}

	/**
	 * Get the main branch name
	 */
	getMainBranch(): string {
		return this.mainBranch;
	}

	/**
	 * Emergency cleanup - remove all raid worktrees
	 */
	emergencyCleanup(): void {
		gitLogger.warn("Performing emergency cleanup of all raid worktrees");

		const raidWorktrees = this.getActiveRaidWorktrees();
		for (const worktree of raidWorktrees) {
			try {
				this.removeWorktree(worktree.raidId, true);
			} catch (error) {
				gitLogger.error(
					{ raidId: worktree.raidId, error: String(error) },
					"Failed to remove worktree during emergency cleanup",
				);
			}
		}

		// Clean up the entire worktrees directory if it's empty
		try {
			if (existsSync(this.worktreesDir)) {
				const contents = require("node:fs").readdirSync(this.worktreesDir);
				if (contents.length === 0) {
					rmSync(this.worktreesDir, { recursive: true });
				}
			}
		} catch (error) {
			gitLogger.error({ error: String(error) }, "Failed to cleanup worktrees directory");
		}
	}
}
