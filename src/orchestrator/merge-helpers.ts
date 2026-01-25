/**
 * Orchestrator Merge Helpers
 *
 * Extracted helper functions for merge operations to reduce
 * complexity in the main Orchestrator class.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as output from "../output.js";
import { execGitInDir, validateCwd, validateGitRef } from "./git-utils.js";

/**
 * Validate that a worktree path exists and is a directory
 */
export function validateWorktreePath(taskId: string, worktreePath: string): void {
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
		if ((statError as Error).message?.includes("Worktree path")) {
			throw statError;
		}
		throw new Error(`Cannot stat worktree path for ${taskId}: ${worktreePath} - ${statError}`);
	}
}

/**
 * Clean unstaged changes in a worktree
 * Resets uncommitted changes and removes untracked files (build artifacts)
 */
export function cleanWorktreeDirectory(taskId: string, worktreePath: string): void {
	try {
		const status = execGitInDir(["status", "--porcelain"], worktreePath);
		if (status.trim()) {
			output.debug(`Cleaning unstaged changes in worktree for ${taskId}`);
			// Reset any unstaged changes (keeps committed work)
			execGitInDir(["checkout", "--", "."], worktreePath);
			// Clean any untracked files (build artifacts, etc.)
			execGitInDir(["clean", "-fd"], worktreePath);
		}
	} catch (cleanError) {
		// If git status fails, the worktree is likely corrupted or deleted
		const errorStr = String(cleanError);
		if (errorStr.includes("not a work tree") || errorStr.includes("must be run in a work tree")) {
			throw new Error(
				`Worktree for ${taskId} was deleted or corrupted before merge could complete. ` +
					`This may be a race condition - try running with lower parallelism.`,
			);
		}
		output.warning(`Failed to clean worktree for ${taskId}: ${cleanError}`);
	}
}

/**
 * Fetch latest main branch into worktree
 */
export function fetchMainIntoWorktree(
	taskId: string,
	worktreePath: string,
	mainRepo: string,
	mainBranch: string,
): void {
	// Validate both mainRepo (path) and mainBranch (ref) to prevent injection
	// Using returned values makes sanitization explicit for static analysis
	const sanitizedRepo = validateCwd(mainRepo);
	const sanitizedBranch = validateGitRef(mainBranch);
	try {
		// execGitInDir uses execFileSync which doesn't invoke a shell,
		// so arguments are passed directly without shell interpretation.
		// The "--" separator tells git that everything after it is a positional
		// argument, not an option. This prevents --upload-pack injection attacks.
		execGitInDir(["fetch", "--", sanitizedRepo, sanitizedBranch], worktreePath);
	} catch (fetchError) {
		throw new Error(`Git fetch from main repo failed for ${taskId}: ${fetchError}`);
	}
}

/**
 * Run verification after rebase with fix attempts
 */
export async function runPostRebaseVerification(
	taskId: string,
	worktreePath: string,
	attemptFix: (taskId: string, worktreePath: string, errorOutput: string) => Promise<void>,
): Promise<void> {
	const maxMergeFixAttempts = 2;
	let lastVerifyError: unknown = null;

	for (let attempt = 0; attempt <= maxMergeFixAttempts; attempt++) {
		try {
			output.progress(`Running verification for ${taskId}${attempt > 0 ? ` (fix attempt ${attempt})` : ""}...`);
			execSync("pnpm typecheck", {
				cwd: worktreePath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			// Set UNDERCITY_VERIFICATION to skip integration tests during merge verification
			execSync("pnpm test --run", {
				cwd: worktreePath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, UNDERCITY_VERIFICATION: "true" },
			});
			// Verification passed
			lastVerifyError = null;
			break;
		} catch (verifyError) {
			lastVerifyError = verifyError;

			// If we have more attempts, try to fix
			if (attempt < maxMergeFixAttempts) {
				output.warning(`Verification failed for ${taskId}, attempting fix (${attempt + 1}/${maxMergeFixAttempts})...`);

				try {
					await attemptFix(taskId, worktreePath, String(verifyError));
				} catch (fixError) {
					output.warning(`Fix attempt failed for ${taskId}: ${fixError}`);
				}
			}
		}
	}

	if (lastVerifyError) {
		throw new Error(`Verification failed for ${taskId} after ${maxMergeFixAttempts} fix attempts: ${lastVerifyError}`);
	}
}

/**
 * Merge worktree changes into local main via fast-forward
 * Handles stashing of uncommitted changes in main repo
 */
export function mergeIntoLocalMain(taskId: string, worktreePath: string, mainRepo: string, mainBranch: string): void {
	// Validate mainBranch to prevent command-line option injection
	const sanitizedBranch = validateGitRef(mainBranch);
	let didStash = false;
	try {
		// Get the current commit SHA before detaching
		const commitSha = execGitInDir(["rev-parse", "HEAD"], worktreePath).trim();

		// Detach HEAD in worktree to release the branch lock
		execGitInDir(["checkout", "--detach"], worktreePath);

		// Check if main repo has uncommitted changes that would block merge
		// Exclude .undercity/ files since they're managed by the orchestrator
		const mainStatus = execGitInDir(["status", "--porcelain"], mainRepo);
		const nonUndercityChanges = mainStatus
			.split("\n")
			.filter((line: string) => line.trim() && !line.includes(".undercity/"))
			.join("\n");

		if (nonUndercityChanges.trim()) {
			output.warning(`Main repo has uncommitted changes, stashing before merge for ${taskId}`);
			try {
				execGitInDir(["stash", "push", "-m", `Auto-stash before merging ${taskId}`], mainRepo);
				didStash = true;
			} catch (stashError) {
				throw new Error(`Cannot merge: main repo has uncommitted changes and stash failed: ${stashError}`);
			}
		}

		// Checkout main and fast-forward merge the worktree branch
		// sanitizedBranch is already validated by validateGitRef() above
		execGitInDir(["checkout", sanitizedBranch], mainRepo);
		execGitInDir(["merge", "--ff-only", commitSha], mainRepo);

		output.debug(`Merged ${taskId} into local main (${commitSha.slice(0, 7)})`);

		// Restore stashed changes after successful merge
		if (didStash) {
			try {
				execGitInDir(["stash", "pop"], mainRepo);
				output.debug(`Restored stashed changes after merge for ${taskId}`);
			} catch (popError) {
				output.warning(`Could not auto-restore stashed changes after ${taskId} merge: ${popError}`);
				output.info(`Run 'git stash pop' manually to restore your changes`);
			}
		}
	} catch (mergeError) {
		// If merge failed and we stashed, try to restore the stash
		if (didStash) {
			try {
				execGitInDir(["stash", "pop"], mainRepo);
			} catch {
				// Silent failure - stash is still available
			}
		}
		throw new Error(`Merge into local main failed for ${taskId}: ${mergeError}`);
	}
}
