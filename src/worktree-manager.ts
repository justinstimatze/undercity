/**
 * Git Worktree Manager Module
 *
 * Manages isolated git worktrees for session branches to enable parallel sessions
 * while keeping the main repo always available on the main branch.
 *
 * Key Features:
 * - Creates isolated worktrees in .undercity/worktrees/<session-id>/
 * - Enables parallel sessions without branch switching in main repo
 * - Proper cleanup and error handling
 * - State tracking for active worktrees
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
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
 * Get the repository root directory with enhanced fallback
 * Supports:
 * 1. Git repositories
 * 2. Explicitly configured roots
 * 3. Fallback to current directory or parent directories
 */
function getRepoRoot(explicitRoot?: string): string {
	// If explicit root is provided, validate it's a directory
	if (explicitRoot) {
		const absoluteRoot = resolve(explicitRoot);
		try {
			if (!statSync(absoluteRoot).isDirectory()) {
				throw new Error("Not a valid directory");
			}
			return absoluteRoot;
		} catch (_dirError) {
			throw new WorktreeError(`Invalid repository root: ${explicitRoot}`, "root-validation", 1);
		}
	}

	// Try git repository detection
	try {
		return execGit(["rev-parse", "--show-toplevel"]);
	} catch (_gitError) {
		// If not a git repo, find first valid parent directory
		let currentDir = process.cwd();
		while (currentDir !== "/") {
			try {
				const files = statSync(currentDir);
				if (files.isDirectory()) {
					return currentDir;
				}
			} catch {
				/* ignore */
			}
			currentDir = resolve(currentDir, "..");
		}

		// Fallback to current directory if all else fails
		return process.cwd();
	}
}

/**
 * Get the default branch (usually 'main' or 'master')
 * Handles both git and non-git repositories
 */
function getDefaultBranch(repoRoot?: string): string {
	try {
		// Try to get from remote HEAD
		const ref = execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
		return ref.replace("refs/remotes/origin/", "");
	} catch {
		// Check common branch names
		const branches = ["main", "master", "develop", "trunk"];
		for (const branch of branches) {
			try {
				execGit(["rev-parse", "--verify", branch], repoRoot);
				return branch;
			} catch {
				/* continue */
			}
		}

		// Non-git or unsupported repo, return a conservative default
		return "main";
	}
}

/**
 * Check if a worktree path exists
 */
function worktreePathExists(worktreePath: string): boolean {
	return existsSync(worktreePath);
}

/**
 * Manages git worktrees for session isolation
 */
export class WorktreeManager {
	private repoRoot: string;
	private undercityDir: string;
	private worktreesDir: string;
	private mainBranch: string;

	constructor(
		options: {
			stateDir?: string;
			repoRoot?: string; // Optional explicit repo root
			defaultBranch?: string; // Optional override for default branch
		} = {},
	) {
		// Determine repo root, with multiple fallback strategies
		try {
			this.repoRoot = getRepoRoot(options.repoRoot);
		} catch (error) {
			gitLogger.warn(
				{
					error: String(error),
					explicitRoot: options.repoRoot,
				},
				"Could not determine repository root, falling back to current directory",
			);
			this.repoRoot = process.cwd();
		}

		// Determine undercity directory
		this.undercityDir = options.stateDir
			? isAbsolute(options.stateDir)
				? resolve(options.stateDir)
				: resolve(this.repoRoot, options.stateDir)
			: join(this.repoRoot, ".undercity");

		this.worktreesDir = join(this.undercityDir, "worktrees");

		// Get main branch with multiple fallback strategies
		try {
			this.mainBranch = options.defaultBranch || getDefaultBranch(this.repoRoot);
		} catch (error) {
			gitLogger.warn({ error: String(error) }, "Could not determine default branch, using 'main'");
			this.mainBranch = "main";
		}

		// Ensure directories exist with proper error handling
		try {
			if (!existsSync(this.undercityDir)) {
				mkdirSync(this.undercityDir, { recursive: true });
			}
			if (!existsSync(this.worktreesDir)) {
				mkdirSync(this.worktreesDir, { recursive: true });
			}
		} catch (error) {
			gitLogger.error(
				{
					error: String(error),
					undercityDir: this.undercityDir,
					worktreesDir: this.worktreesDir,
				},
				"Failed to create Undercity directories",
			);
			throw new WorktreeError(`Could not create Undercity directories: ${String(error)}`, "directory-creation");
		}

		gitLogger.debug(
			{
				repoRoot: this.repoRoot,
				undercityDir: this.undercityDir,
				mainBranch: this.mainBranch,
				isGitRepo: this.isGitRepo(),
			},
			"Worktree manager initialized",
		);
	}

	/**
	 * Check if the repository is a valid git repository
	 * Supports both full git repositories and sparse checkouts
	 */
	isGitRepo(): boolean {
		try {
			// Check multiple ways to detect git repo
			const checks = [
				() => execGit(["rev-parse", "--is-inside-work-tree"]),
				() => execGit(["rev-parse", "--git-dir"]),
				() => statSync(join(this.repoRoot, ".git")).isDirectory(),
			];

			for (const check of checks) {
				try {
					check();
					return true;
				} catch {
					/* continue */
				}
			}

			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Get the worktree directory path for a session
	 */
	getWorktreePath(sessionId: string): string {
		return join(this.worktreesDir, sessionId);
	}

	/**
	 * Get the branch name for a session's worktree
	 */
	getWorktreeBranchName(sessionId: string): string {
		return `undercity/${sessionId}/worktree`;
	}

	/**
	 * Create a new worktree for a session
	 */
	createWorktree(sessionId: string): WorktreeInfo {
		const worktreePath = this.getWorktreePath(sessionId);
		const branchName = this.getWorktreeBranchName(sessionId);

		gitLogger.info({ sessionId, worktreePath, branchName }, "Creating session worktree");

		// Check if worktree already exists
		if (worktreePathExists(worktreePath)) {
			throw new WorktreeError(
				`Worktree already exists for session ${sessionId} at ${worktreePath}`,
				"git worktree add",
			);
		}

		// Branch from local main HEAD (not origin/main)
		// This ensures worktrees see all local commits, including unpushed work
		const baseBranch = this.mainBranch;

		try {
			// Create the worktree with a new branch from local main HEAD
			gitLogger.debug({ baseBranch }, "Creating worktree from local main HEAD");
			execGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch]);

			// Install dependencies in the worktree so verification can run
			gitLogger.info({ sessionId, worktreePath }, "Installing dependencies in worktree");
			try {
				execSync("pnpm install --frozen-lockfile", {
					cwd: worktreePath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				gitLogger.info({ sessionId }, "Dependencies installed successfully");
			} catch (installError) {
				gitLogger.warn(
					{ sessionId, error: String(installError) },
					"Failed to install dependencies in worktree - verification may fail",
				);
				// Don't throw - let the task continue and fail at verification stage with clearer error
			}

			// Block direct pushes from worktree - orchestrator controls all pushes after verification
			// Setting push URL to a blocked path ensures any git push attempt fails with a clear error
			gitLogger.info({ sessionId }, "Blocking direct pushes from worktree");
			try {
				execSync('git remote set-url --push origin "PUSH_BLOCKED_USE_ORCHESTRATOR"', {
					cwd: worktreePath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (blockError) {
				gitLogger.warn(
					{ sessionId, error: String(blockError) },
					"Failed to block pushes in worktree - agents may bypass verification",
				);
			}

			const worktreeInfo: WorktreeInfo = {
				sessionId,
				path: worktreePath,
				branch: branchName,
				createdAt: new Date(),
				isActive: true,
			};

			gitLogger.info({ sessionId, worktreePath, branchName }, "Worktree created successfully");
			return worktreeInfo;
		} catch (error) {
			if (error instanceof WorktreeError) {
				throw error;
			}
			throw new WorktreeError(
				`Failed to create worktree for session ${sessionId}: ${String(error)}`,
				"git worktree add",
			);
		}
	}

	/**
	 * Remove a worktree for a session
	 */
	removeWorktree(sessionId: string, force = false): void {
		const worktreePath = this.getWorktreePath(sessionId);
		const branchName = this.getWorktreeBranchName(sessionId);

		gitLogger.info({ sessionId, worktreePath, branchName, force }, "Removing session worktree");

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
					gitLogger.warn({ sessionId, error: String(error) }, "Worktree remove failed, cleaning up manually");
					rmSync(worktreePath, { recursive: true, force: true });
				}
			}

			// Clean up the branch
			try {
				execGit(["branch", "-D", branchName]);
			} catch (error) {
				gitLogger.warn({ sessionId, branchName, error: String(error) }, "Failed to delete worktree branch");
			}

			// Prune worktree references
			try {
				execGit(["worktree", "prune"]);
			} catch (error) {
				gitLogger.warn({ error: String(error) }, "Failed to prune worktree references");
			}

			gitLogger.info({ sessionId, worktreePath, branchName }, "Worktree removed successfully");
		} catch (error) {
			const errorMsg = error instanceof WorktreeError ? error.message : String(error);
			gitLogger.error({ sessionId, error: errorMsg }, "Failed to remove worktree");
			throw new WorktreeError(`Failed to remove worktree for session ${sessionId}: ${errorMsg}`, "git worktree remove");
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
	 * Get active session worktrees (those in our managed directory)
	 */
	getActiveSessionWorktrees(): WorktreeInfo[] {
		const allWorktrees = this.listWorktrees();
		const sessionWorktrees: WorktreeInfo[] = [];

		for (const worktree of allWorktrees) {
			// Check if this worktree is in our managed directory
			if (worktree.path.startsWith(this.worktreesDir)) {
				const sessionId = basename(worktree.path);

				// Verify it matches our naming convention
				if (worktree.branch.startsWith(`undercity/${sessionId}/worktree`)) {
					sessionWorktrees.push({
						sessionId,
						path: worktree.path,
						branch: worktree.branch,
						createdAt: new Date(), // We don't track creation time in git, use current time
						isActive: true,
					});
				}
			}
		}

		return sessionWorktrees;
	}

	/**
	 * Check if a worktree exists for a session
	 */
	hasWorktree(sessionId: string): boolean {
		const worktreePath = this.getWorktreePath(sessionId);
		return worktreePathExists(worktreePath);
	}

	/**
	 * Get worktree info for a specific session
	 */
	getWorktreeInfo(sessionId: string): WorktreeInfo | null {
		if (!this.hasWorktree(sessionId)) {
			return null;
		}

		const worktreePath = this.getWorktreePath(sessionId);
		const branchName = this.getWorktreeBranchName(sessionId);

		return {
			sessionId,
			path: worktreePath,
			branch: branchName,
			createdAt: new Date(), // We don't track creation time, use current time
			isActive: true,
		};
	}

	/**
	 * Cleanup orphaned worktrees (worktrees that exist but no corresponding session)
	 */
	cleanupOrphanedWorktrees(activeSessionIds: string[]): void {
		const activeSet = new Set(activeSessionIds);
		const sessionWorktrees = this.getActiveSessionWorktrees();

		for (const worktree of sessionWorktrees) {
			if (!activeSet.has(worktree.sessionId)) {
				gitLogger.info({ sessionId: worktree.sessionId }, "Cleaning up orphaned worktree");
				try {
					this.removeWorktree(worktree.sessionId, true);
				} catch (error) {
					gitLogger.error(
						{ sessionId: worktree.sessionId, error: String(error) },
						"Failed to cleanup orphaned worktree",
					);
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
	 * Emergency cleanup - remove all session worktrees
	 */
	emergencyCleanup(): void {
		gitLogger.warn("Performing emergency cleanup of all session worktrees");

		const sessionWorktrees = this.getActiveSessionWorktrees();
		for (const worktree of sessionWorktrees) {
			try {
				this.removeWorktree(worktree.sessionId, true);
			} catch (error) {
				gitLogger.error(
					{ sessionId: worktree.sessionId, error: String(error) },
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
