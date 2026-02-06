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

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ValidationError, WorktreeError } from "./errors.js";
import { gitLogger } from "./logger.js";
import { nameFromId } from "./names.js";
import type { Message, WorktreeInfo } from "./types.js";

// Re-export error classes for backward compatibility
export { AppError, DatabaseError, TimeoutError, ValidationError, WorktreeError } from "./errors.js";

/**
 * Execute a git command and return stdout
 */
function execGit(args: string[], cwd?: string): string {
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
				throw new WorktreeError("Not a valid directory", "root-validation", 1);
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
			worktreesDir?: string; // Optional override for worktrees directory
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

		// Determine worktrees directory from (in priority order):
		// 1. options.worktreesDir - explicit override
		// 2. UNDERCITY_WORKTREES_DIR env var
		// 3. Default: ~/.cache/undercity-worktrees (disk-backed, survives reboot)
		//
		// IMPORTANT: Avoid paths with parent .claude/ directories - the SDK walks
		// up the tree and loads those rules, causing 10-15s latency per turn.
		// ~/.cache/ and /tmp are safe locations.
		const repoHash = Buffer.from(this.repoRoot).toString("base64url").slice(0, 12);
		const envWorktreesDir = process.env.UNDERCITY_WORKTREES_DIR;
		const defaultWorktreesDir = join(homedir(), ".cache", "undercity-worktrees", repoHash);

		if (options.worktreesDir) {
			this.worktreesDir = isAbsolute(options.worktreesDir)
				? join(options.worktreesDir, repoHash)
				: join(resolve(options.worktreesDir), repoHash);
		} else if (envWorktreesDir) {
			this.worktreesDir = isAbsolute(envWorktreesDir)
				? join(envWorktreesDir, repoHash)
				: join(resolve(envWorktreesDir), repoHash);
		} else {
			this.worktreesDir = defaultWorktreesDir;
		}

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
				() => execGit(["rev-parse", "--is-inside-work-tree"], this.repoRoot),
				() => execGit(["rev-parse", "--git-dir"], this.repoRoot),
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
	 * Format: undercity/{friendly-name}/{sessionId}
	 * e.g., undercity/swift-fox/task-abc123
	 */
	getWorktreeBranchName(sessionId: string): string {
		const friendlyName = nameFromId(sessionId);
		return `undercity/${friendlyName}/${sessionId}`;
	}

	/**
	 * Get the friendly worker name for a session
	 */
	getWorkerName(sessionId: string): string {
		return nameFromId(sessionId);
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
			// Enable worktreeConfig extension if not already enabled
			// This allows worktree-specific config without affecting main repo
			try {
				execGit(["config", "extensions.worktreeConfig", "true"], this.repoRoot);
			} catch {
				// Ignore if already enabled
			}

			// Create the worktree with a new branch from local main HEAD
			gitLogger.debug({ baseBranch }, "Creating worktree from local main HEAD");
			execGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch], this.repoRoot);

			// Install dependencies in the worktree so verification can run
			gitLogger.info({ sessionId, worktreePath }, "Installing dependencies in worktree");
			try {
				execFileSync("pnpm", ["install", "--frozen-lockfile"], {
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

			// Copy gitignored directories that agents may need to edit
			// .undercity/ contains state files like experiments.json that tasks may modify
			gitLogger.info({ sessionId }, "Copying gitignored directories to worktree");
			try {
				const undercitySource = `${this.repoRoot}/.undercity`;
				const undercityDest = `${worktreePath}/.undercity`;
				// Only copy if source exists and dest doesn't
				if (existsSync(undercitySource) && !existsSync(undercityDest)) {
					execFileSync("cp", ["-r", undercitySource, undercityDest], {
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
					gitLogger.debug({ sessionId }, "Copied .undercity/ to worktree");
				}
			} catch (copyError) {
				gitLogger.warn(
					{ sessionId, error: String(copyError) },
					"Failed to copy .undercity/ to worktree - agents may edit wrong files",
				);
			}

			// Explicitly copy AST index if it exists (ensures it's available for context selection)
			try {
				const astIndexSource = join(this.repoRoot, ".undercity", "ast-index.json");
				const astIndexDest = join(worktreePath, ".undercity", "ast-index.json");
				if (existsSync(astIndexSource)) {
					// Ensure dest directory exists
					const destDir = join(worktreePath, ".undercity");
					if (!existsSync(destDir)) {
						mkdirSync(destDir, { recursive: true });
					}
					copyFileSync(astIndexSource, astIndexDest);
					gitLogger.debug({ sessionId }, "Copied AST index to worktree");
				}
			} catch (astCopyError) {
				gitLogger.warn(
					{ sessionId, error: String(astCopyError) },
					"Failed to copy AST index to worktree - context selection may be slower",
				);
			}

			// Symlink .husky so pre-commit hooks work in worktree
			try {
				const huskySource = `${this.repoRoot}/.husky`;
				const huskyDest = `${worktreePath}/.husky`;
				if (existsSync(huskySource) && !existsSync(huskyDest)) {
					execFileSync("ln", ["-s", huskySource, huskyDest], {
						cwd: worktreePath,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
					gitLogger.debug({ sessionId }, "Symlinked .husky/ to worktree");
				}
			} catch (symlinkError) {
				gitLogger.warn(
					{ sessionId, error: String(symlinkError) },
					"Failed to symlink .husky/ - pre-commit hooks may not work in worktree",
				);
			}

			// Block direct pushes from worktree - orchestrator controls all pushes after verification
			// Use --worktree flag to set config only for this worktree (not shared with main repo)
			gitLogger.info({ sessionId }, "Blocking direct pushes from worktree");
			try {
				execGit(["config", "--worktree", "remote.origin.pushurl", "PUSH_BLOCKED_USE_ORCHESTRATOR"], worktreePath);
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
			// Remove the worktree (worktree-specific config is automatically cleaned up)
			const removeArgs = ["worktree", "remove"];
			if (force) {
				removeArgs.push("--force");
			}
			removeArgs.push(worktreePath);

			try {
				execGit(removeArgs, this.repoRoot);
			} catch (error) {
				// If worktree remove fails, try to clean up manually
				if (worktreePathExists(worktreePath)) {
					gitLogger.warn({ sessionId, error: String(error) }, "Worktree remove failed, cleaning up manually");
					rmSync(worktreePath, { recursive: true, force: true });
				}
			}

			// Clean up the branch
			try {
				execGit(["branch", "-D", branchName], this.repoRoot);
			} catch (error) {
				gitLogger.warn({ sessionId, branchName, error: String(error) }, "Failed to delete worktree branch");
			}

			// Prune worktree references
			try {
				execGit(["worktree", "prune"], this.repoRoot);
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
			const output = execGit(["worktree", "list", "--porcelain"], this.repoRoot);
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
				// Format: undercity/{friendly-name}/{sessionId}
				if (worktree.branch.startsWith("undercity/") && worktree.branch.endsWith(`/${sessionId}`)) {
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

	/**
	 * Send a message to a specific worktree
	 *
	 * Writes a message JSON file to the target worktree's .undercity/messages/ directory.
	 * Messages are best-effort delivery only - no acknowledgment mechanism is provided.
	 * The caller is responsible for message cleanup (no automatic TTL).
	 *
	 * @param targetSessionId - The session ID of the target worktree
	 * @param type - Message type for routing/handling (e.g., 'config_update', 'task_cancel')
	 * @param payload - Message payload (any JSON-serializable data)
	 * @returns true if message was written successfully, false otherwise
	 * @throws {ValidationError} If targetSessionId is empty or invalid
	 * @throws {WorktreeError} If message directory creation fails
	 *
	 * @example
	 * ```typescript
	 * const manager = new WorktreeManager();
	 * const success = manager.sendMessage('task-abc123', 'config_update', {
	 *   timeout: 30000,
	 *   retries: 3
	 * });
	 * if (success) {
	 *   console.log('Message delivered');
	 * }
	 * ```
	 */
	sendMessage(targetSessionId: string, type: string, payload: unknown): boolean {
		// Validate inputs
		if (!targetSessionId || typeof targetSessionId !== "string" || targetSessionId.trim() === "") {
			throw new ValidationError("Target session ID must be a non-empty string", "targetSessionId");
		}

		if (!type || typeof type !== "string" || type.trim() === "") {
			throw new ValidationError("Message type must be a non-empty string", "type");
		}

		// Check if target worktree exists
		const worktreePath = this.getWorktreePath(targetSessionId);
		if (!this.hasWorktree(targetSessionId)) {
			gitLogger.warn({ targetSessionId, worktreePath }, "Target worktree does not exist, skipping message delivery");
			return false;
		}

		// Generate unique message ID (timestamp + random suffix)
		const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		const message: Message = {
			id: messageId,
			from: "orchestrator",
			to: targetSessionId,
			type,
			payload,
			timestamp: new Date(),
		};

		// Ensure .undercity/messages/ directory exists
		const messagesDir = join(worktreePath, ".undercity", "messages");
		try {
			if (!existsSync(messagesDir)) {
				mkdirSync(messagesDir, { recursive: true });
			}
		} catch (error) {
			throw new WorktreeError(`Failed to create messages directory: ${String(error)}`, "mkdir");
		}

		// Write message file
		const messagePath = join(messagesDir, `${messageId}.json`);
		try {
			writeFileSync(messagePath, JSON.stringify(message, null, 2), { encoding: "utf-8" });
			gitLogger.info({ targetSessionId, messageId, type, messagePath }, "Message sent to worktree");
			return true;
		} catch (error) {
			gitLogger.error({ targetSessionId, messageId, type, error: String(error) }, "Failed to write message file");
			return false;
		}
	}

	/**
	 * Broadcast a message to all active worktrees
	 *
	 * Sends the same message to all currently active worktrees by calling sendMessage
	 * for each worktree. This is a convenience method for orchestrator-wide announcements.
	 *
	 * @param type - Message type for routing/handling (e.g., 'shutdown', 'config_update')
	 * @param payload - Message payload (any JSON-serializable data)
	 * @returns Number of worktrees that successfully received the message
	 * @throws {ValidationError} If type is empty or invalid
	 *
	 * @example
	 * ```typescript
	 * const manager = new WorktreeManager();
	 * const delivered = manager.broadcastMessage('shutdown', {
	 *   reason: 'System maintenance',
	 *   gracePeriodMs: 5000
	 * });
	 * console.log(`Message delivered to ${delivered} worktrees`);
	 * ```
	 */
	broadcastMessage(type: string, payload: unknown): number {
		// Validate inputs
		if (!type || typeof type !== "string" || type.trim() === "") {
			throw new ValidationError("Message type must be a non-empty string", "type");
		}

		const activeWorktrees = this.getActiveSessionWorktrees();

		if (activeWorktrees.length === 0) {
			gitLogger.info({ type }, "No active worktrees to broadcast to");
			return 0;
		}

		let successCount = 0;
		for (const worktree of activeWorktrees) {
			const success = this.sendMessage(worktree.sessionId, type, payload);
			if (success) {
				successCount++;
			}
		}

		gitLogger.info(
			{ type, totalWorktrees: activeWorktrees.length, successCount },
			"Broadcast message sent to all active worktrees",
		);

		return successCount;
	}
}
