/**
 * Serial Merge Queue
 *
 * Processes merge items one at a time to avoid conflicts:
 * 1. Checkout the branch
 * 2. Rebase onto main
 * 3. Run tests
 * 4. Merge if tests pass
 * 5. Delete the branch
 *
 * Supports auto-conflict resolution using:
 * - AI-powered resolution: Uses Claude to intelligently merge conflicting changes
 * - Git merge strategies: "theirs", "ours", "default" as fallbacks
 *
 * Retry functionality:
 * - Failed merges are retried after successful merges complete
 * - Uses exponential backoff to prevent system overload
 * - Conflicts may resolve after other branches are merged
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	checkoutBranch,
	deleteBranch,
	execGit,
	getCurrentBranch,
	getDefaultBranch,
	type MergeStrategy,
	mergeWithFallback,
	pushToOrigin,
	rebase,
	runTests,
} from "./git.js";
import { gitLogger } from "./logger.js";
import { type MergeQueueConflict, type MergeQueueItem, type MergeQueueRetryConfig, MODEL_NAMES } from "./types.js";

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: MergeQueueRetryConfig = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

/**
 * Auto-detect completed tasks based on commit message matching
 * Marks tasks as complete if their keywords appear in the commit message
 *
 * @returns Number of tasks marked complete, or -1 if auto-detection failed
 */
async function autoDetectCompletedTasks(): Promise<number> {
	try {
		const { execSync } = await import("node:child_process");
		const commitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
		const commitMessage = execSync("git log -1 --format=%s", { encoding: "utf-8" }).trim();

		const { getAllTasks, markTaskComplete } = await import("./task.js");
		const pendingTasks = getAllTasks().filter((t) => t.status === "pending" || t.status === "in_progress");

		if (pendingTasks.length === 0) {
			gitLogger.debug("No pending tasks to auto-detect");
			return 0;
		}

		let markedCount = 0;
		for (const task of pendingTasks) {
			// Extract keywords from task objective (words longer than 3 chars)
			const keywords = task.objective
				.toLowerCase()
				.replace(/[[\]]/g, "")
				.split(/\s+/)
				.filter((word) => word.length > 3);

			if (keywords.length === 0) {
				continue;
			}

			// Check if commit message matches task
			const messageLower = commitMessage.toLowerCase();
			const matches = keywords.filter((k) => messageLower.includes(k)).length;
			const threshold = Math.max(2, Math.ceil(keywords.length * 0.5));

			if (matches >= threshold) {
				gitLogger.info(
					{ taskId: task.id, commitSha, matches, threshold, keywords: keywords.length },
					"Auto-marking task complete based on commit message match",
				);
				markTaskComplete(task.id);
				markedCount++;
			}
		}

		if (markedCount === 0) {
			gitLogger.debug(
				{ commitMessage, pendingTaskCount: pendingTasks.length },
				"Auto-detection ran but no tasks matched commit message",
			);
		}

		return markedCount;
	} catch (error) {
		gitLogger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Auto-detection failed - tasks must be marked complete manually",
		);
		return -1;
	}
}

// ============================================================================
// AI-Powered Conflict Resolution
// ============================================================================

/**
 * Get list of files with unresolved conflicts
 */
function getConflictedFiles(worktreePath: string): string[] {
	try {
		const output = execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
		return output
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Read file content with conflict markers
 */
function readConflictedFile(worktreePath: string, filePath: string): string | null {
	try {
		const fullPath = join(worktreePath, filePath);
		return readFileSync(fullPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Prompt for AI conflict resolution
 */
const CONFLICT_RESOLUTION_PROMPT = `You are resolving a git merge conflict. Analyze both versions and produce the FINAL merged content.

FILE: {filePath}

CONFLICTED CONTENT:
{content}

RULES:
1. Output ONLY the final resolved file content - no explanations, no markdown code blocks
2. Remove ALL conflict markers (<<<<<<, ======, >>>>>>)
3. Preserve both changes where they don't overlap
4. For overlapping changes, intelligently merge them or pick the more complete version
5. Maintain proper syntax and formatting
6. If unsure, prefer the incoming changes (after ======)

OUTPUT THE RESOLVED FILE CONTENT:`;

/**
 * Use AI to resolve a single conflict
 */
async function resolveConflictWithAI(
	_worktreePath: string,
	filePath: string,
	content: string,
): Promise<{ success: boolean; resolved?: string; error?: string }> {
	const prompt = CONFLICT_RESOLUTION_PROMPT.replace("{filePath}", filePath).replace("{content}", content);

	try {
		let result = "";
		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				maxTurns: 1,
				permissionMode: "bypassPermissions",
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		if (!result) {
			return { success: false, error: "Empty response from model" };
		}

		// Clean up any markdown code blocks the model might have added
		let resolved = result;
		if (resolved.startsWith("```")) {
			resolved = resolved.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
		}

		// Verify no conflict markers remain
		if (resolved.includes("<<<<<<<") || resolved.includes(">>>>>>>") || resolved.includes("=======")) {
			return { success: false, error: "Model output still contains conflict markers" };
		}

		return { success: true, resolved };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}

/**
 * Attempt to resolve all conflicts in a worktree using AI
 */
async function resolveConflictsWithAI(
	worktreePath: string,
): Promise<{ success: boolean; resolved: string[]; failed: string[] }> {
	const conflictedFiles = getConflictedFiles(worktreePath);

	if (conflictedFiles.length === 0) {
		return { success: true, resolved: [], failed: [] };
	}

	gitLogger.info({ files: conflictedFiles, count: conflictedFiles.length }, "Attempting AI conflict resolution");

	const resolved: string[] = [];
	const failed: string[] = [];

	for (const filePath of conflictedFiles) {
		const content = readConflictedFile(worktreePath, filePath);
		if (!content) {
			failed.push(filePath);
			continue;
		}

		const result = await resolveConflictWithAI(worktreePath, filePath, content);

		if (result.success && result.resolved) {
			try {
				// Write resolved content
				const fullPath = join(worktreePath, filePath);
				writeFileSync(fullPath, result.resolved, "utf-8");

				// Stage the resolved file
				execGit(["add", filePath], worktreePath);

				resolved.push(filePath);
				gitLogger.info({ filePath }, "AI resolved conflict");
			} catch (writeError) {
				gitLogger.warn({ filePath, error: String(writeError) }, "Failed to write resolved file");
				failed.push(filePath);
			}
		} else {
			gitLogger.warn({ filePath, error: result.error }, "AI conflict resolution failed");
			failed.push(filePath);
		}
	}

	const success = failed.length === 0;

	if (success) {
		gitLogger.info({ resolved: resolved.length }, "All conflicts resolved by AI");
	} else {
		gitLogger.warn({ resolved: resolved.length, failed: failed.length }, "Some conflicts could not be resolved");
	}

	return { success, resolved, failed };
}

// ============================================================================
// MergeQueue Class
// ============================================================================

export class MergeQueue {
	private queue: MergeQueueItem[] = [];
	private processing = false;
	private mainBranch: string;
	private mergeStrategy: MergeStrategy;
	private retryConfig: MergeQueueRetryConfig;
	private useAIResolution: boolean = true;

	/**
	 * Create a new MergeQueue
	 * @param mainBranch - The target branch for merges (defaults to main/master)
	 * @param mergeStrategy - Strategy for auto-resolving conflicts (defaults to "theirs" for automatic resolution)
	 * @param retryConfig - Configuration for retry behavior
	 */
	constructor(mainBranch?: string, mergeStrategy?: MergeStrategy, retryConfig?: Partial<MergeQueueRetryConfig>) {
		this.mainBranch = mainBranch || getDefaultBranch();
		this.mergeStrategy = mergeStrategy ?? "theirs";
		this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
	}

	/**
	 * Add a branch to the merge queue
	 * @param branch - Branch name to queue for merge
	 * @param stepId - Step ID associated with this branch
	 * @param agentId - Agent ID that worked on this branch
	 * @param modifiedFiles - Optional list of files modified by this branch for conflict detection
	 */
	add(branch: string, stepId: string, agentId: string, modifiedFiles?: string[]): MergeQueueItem {
		const item: MergeQueueItem = {
			branch,
			stepId,
			agentId,
			status: "pending",
			queuedAt: new Date(),
			retryCount: 0,
			maxRetries: this.retryConfig.maxRetries,
			isRetry: false,
			modifiedFiles,
		};
		this.queue.push(item);
		gitLogger.debug(
			{ branch, stepId, agentId, modifiedFilesCount: modifiedFiles?.length ?? 0 },
			"Added to merge queue",
		);
		return item;
	}

	/**
	 * Detect file conflicts between branches in the merge queue.
	 *
	 * This checks if any two pending branches modify the same files,
	 * which would likely cause merge conflicts. Call this before processing
	 * to flag potential issues early.
	 *
	 * @returns Array of detected conflicts between queued branches
	 */
	detectQueueConflicts(): MergeQueueConflict[] {
		const conflicts: MergeQueueConflict[] = [];
		const pendingItems = this.queue.filter((item) => item.status === "pending" && item.modifiedFiles?.length);

		// Compare each pair of pending items
		for (let i = 0; i < pendingItems.length; i++) {
			const itemA = pendingItems[i];
			const filesA = new Set(itemA.modifiedFiles ?? []);

			for (let j = i + 1; j < pendingItems.length; j++) {
				const itemB = pendingItems[j];
				const filesB = itemB.modifiedFiles ?? [];

				// Find overlapping files
				const overlappingFiles = filesB.filter((file) => filesA.has(file));

				if (overlappingFiles.length > 0) {
					conflicts.push({
						branch: itemA.branch,
						conflictsWith: itemB.branch,
						overlappingFiles,
						severity: overlappingFiles.length > 3 ? "error" : "warning",
					});

					gitLogger.warn(
						{
							branchA: itemA.branch,
							branchB: itemB.branch,
							overlappingFiles,
							count: overlappingFiles.length,
						},
						"Pre-merge conflict detected: branches modify same files",
					);
				}
			}
		}

		return conflicts;
	}

	/**
	 * Check if adding a branch with the given modified files would conflict
	 * with any existing branches in the queue.
	 *
	 * Use this before adding a branch to get early warning of potential conflicts.
	 *
	 * @param modifiedFiles - Files that the new branch will modify
	 * @param excludeBranch - Optional branch to exclude from conflict check
	 * @returns Array of conflicts that would occur if this branch is added
	 */
	checkConflictsBeforeAdd(modifiedFiles: string[], excludeBranch?: string): MergeQueueConflict[] {
		const conflicts: MergeQueueConflict[] = [];
		const newFiles = new Set(modifiedFiles);

		for (const item of this.queue) {
			// Skip completed items and the excluded branch
			if (item.status === "complete" || item.branch === excludeBranch) {
				continue;
			}

			// Skip items without tracked files
			if (!item.modifiedFiles?.length) {
				continue;
			}

			// Find overlapping files
			const overlappingFiles = item.modifiedFiles.filter((file) => newFiles.has(file));

			if (overlappingFiles.length > 0) {
				conflicts.push({
					branch: "(new)",
					conflictsWith: item.branch,
					overlappingFiles,
					severity: overlappingFiles.length > 3 ? "error" : "warning",
				});
			}
		}

		return conflicts;
	}

	/**
	 * Get conflicts for a specific branch in the queue
	 *
	 * @param branch - Branch to check for conflicts
	 * @returns Array of conflicts involving this branch
	 */
	getConflictsForBranch(branch: string): MergeQueueConflict[] {
		const allConflicts = this.detectQueueConflicts();
		return allConflicts.filter((c) => c.branch === branch || c.conflictsWith === branch);
	}

	/**
	 * Get the current queue
	 */
	getQueue(): MergeQueueItem[] {
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
	getRetryConfig(): MergeQueueRetryConfig {
		return { ...this.retryConfig };
	}

	/**
	 * Update retry configuration
	 */
	setRetryConfig(config: Partial<MergeQueueRetryConfig>): void {
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
	 * Rebase a branch in its worktree, with AI conflict resolution
	 */
	private async rebaseInWorktree(branch: string, worktreePath: string): Promise<{ success: boolean; error?: string }> {
		gitLogger.debug({ branch, worktreePath, onto: this.mainBranch }, "Rebasing in worktree");
		try {
			execGit(["rebase", this.mainBranch], worktreePath);
			return { success: true };
		} catch (_rebaseError) {
			// Rebase failed - check if it's due to conflicts
			const conflictedFiles = getConflictedFiles(worktreePath);

			if (conflictedFiles.length === 0 || !this.useAIResolution) {
				// No conflicts or AI resolution disabled - abort and fail
				try {
					execGit(["rebase", "--abort"], worktreePath);
				} catch {
					// Ignore abort errors
				}
				return { success: false, error: "Rebase failed - manual resolution required" };
			}

			// Try AI-powered conflict resolution
			gitLogger.info({ branch, conflictCount: conflictedFiles.length }, "Attempting AI conflict resolution");

			const aiResult = await resolveConflictsWithAI(worktreePath);

			if (!aiResult.success) {
				// AI resolution failed - abort and return error
				try {
					execGit(["rebase", "--abort"], worktreePath);
				} catch {
					// Ignore abort errors
				}
				return {
					success: false,
					error: `AI conflict resolution failed for: ${aiResult.failed.join(", ")}`,
				};
			}

			// AI resolved all conflicts - continue the rebase
			try {
				execGit(["rebase", "--continue"], worktreePath);
				gitLogger.info({ branch, resolved: aiResult.resolved }, "Rebase continued after AI resolution");
				return { success: true };
			} catch (_continueError) {
				// Continuing failed - there may be more conflicts in the next commit
				// Try resolving again (recursive)
				return this.rebaseInWorktree(branch, worktreePath);
			}
		}
	}

	/**
	 * Push merge to origin and log result
	 */
	private pushMergeToOrigin(): void {
		try {
			pushToOrigin(this.mainBranch);
			gitLogger.info({ branch: this.mainBranch }, "Pushed merge to origin");
		} catch (pushError) {
			gitLogger.error(
				{ branch: this.mainBranch, error: String(pushError) },
				"Failed to push to origin - work is on local main, push manually",
			);
		}
	}

	/**
	 * Clean up worktree and branch after successful merge
	 */
	private cleanupAfterMerge(branch: string, worktreePath: string): void {
		try {
			execGit(["worktree", "remove", worktreePath, "--force"]);
			gitLogger.debug({ branch, worktreePath }, "Removed worktree after successful merge");
		} catch (worktreeError) {
			gitLogger.warn({ branch, error: String(worktreeError) }, "Failed to remove worktree, but merge succeeded");
		}

		try {
			deleteBranch(branch);
		} catch (branchError) {
			gitLogger.warn({ branch, error: String(branchError) }, "Failed to delete branch after merge");
		}
	}

	/**
	 * Mark item as complete and remove from queue
	 */
	private async completeItem(item: MergeQueueItem): Promise<void> {
		item.status = "complete";
		item.completedAt = new Date();
		await autoDetectCompletedTasks();
		this.queue = this.queue.filter((i) => i !== item);
		gitLogger.info({ branch: item.branch, stepId: item.stepId }, "Merge complete");
	}

	/**
	 * Process a worktree branch safely without checkout conflicts
	 */
	private async processWorktreeBranch(item: MergeQueueItem, cwd: string): Promise<MergeQueueItem> {
		const worktreePath = this.getWorktreePath(item.branch);
		if (!worktreePath) {
			return this.handleMergeFailure(item, "Could not find worktree path for branch");
		}

		// Step 1: Rebase in the worktree (with AI conflict resolution)
		item.status = "rebasing";
		const rebaseResult = await this.rebaseInWorktree(item.branch, worktreePath);
		if (!rebaseResult.success) {
			return this.handleMergeFailure(item, rebaseResult.error!);
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

		// Step 3: Merge into main
		const originalBranch = getCurrentBranch();
		try {
			checkoutBranch(this.mainBranch);
			item.status = "merging";

			const mergeResult = mergeWithFallback(item.branch, `Merge ${item.branch} via undercity`);
			if (!mergeResult.success) {
				return this.handleMergeFailure(item, mergeResult.error || "Merge failed", mergeResult.conflictFiles);
			}

			item.strategyUsed = mergeResult.strategyUsed;
			if (mergeResult.strategyUsed !== "default") {
				gitLogger.info(
					{ branch: item.branch, strategy: mergeResult.strategyUsed },
					"Merge succeeded with fallback strategy",
				);
			}

			// Step 4: Push and cleanup
			item.status = "pushing";
			this.pushMergeToOrigin();
			this.cleanupAfterMerge(item.branch, worktreePath);
			await this.completeItem(item);
			return item;
		} catch (error) {
			return this.handleMergeFailure(item, error instanceof Error ? error.message : String(error));
		} finally {
			try {
				checkoutBranch(originalBranch);
			} catch {
				// Best effort
			}
		}
	}

	/**
	 * Check if an item is eligible for retry
	 * @param item - The merge queue item to check
	 * @returns true if the item can be retried
	 */
	private canRetry(item: MergeQueueItem): boolean {
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
	private prepareForRetry(item: MergeQueueItem): void {
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
	 * Attempt to rebase an item onto the main branch
	 */
	private async tryRebase(item: MergeQueueItem, cwd: string): Promise<{ success: boolean; error?: string }> {
		item.status = "rebasing";
		gitLogger.debug({ branch: item.branch, onto: this.mainBranch }, "Rebasing");
		const rebaseSuccess = rebase(this.mainBranch);

		if (!rebaseSuccess) {
			return { success: false, error: "Rebase failed - manual resolution required" };
		}

		// Run tests after successful rebase
		item.status = "testing";
		gitLogger.debug({ branch: item.branch }, "Running tests");
		const testResult = await runTests(cwd);

		if (!testResult.success) {
			return { success: false, error: testResult.output };
		}

		return { success: true };
	}

	/**
	 * Attempt to merge an item into the main branch
	 */
	private async tryMerge(
		item: MergeQueueItem,
	): Promise<{ success: boolean; error?: string; conflictFiles?: string[]; strategyUsed?: MergeStrategy }> {
		checkoutBranch(this.mainBranch);
		item.status = "merging";
		gitLogger.debug(
			{ branch: item.branch, into: this.mainBranch },
			"Merging with optimal strategy (clean → ours → report)",
		);

		const mergeResult = mergeWithFallback(item.branch, `Merge ${item.branch} via undercity`);

		if (!mergeResult.success) {
			return {
				success: false,
				error: mergeResult.error || "Merge failed - manual resolution required",
				conflictFiles: mergeResult.conflictFiles,
			};
		}

		// Record which strategy succeeded
		if (mergeResult.strategyUsed !== "default") {
			gitLogger.info(
				{ branch: item.branch, strategy: mergeResult.strategyUsed },
				"Merge succeeded with fallback strategy",
			);
		}

		return { success: true, strategyUsed: mergeResult.strategyUsed };
	}

	/**
	 * Handle failure by setting appropriate status and error information
	 */
	private handleMergeFailure(item: MergeQueueItem, error: string, conflictFiles?: string[]): MergeQueueItem {
		item.status = "conflict";
		item.error = error;
		item.conflictFiles = conflictFiles;
		item.completedAt = new Date();

		if (conflictFiles) {
			gitLogger.warn(
				{ branch: item.branch, conflictFiles },
				"Branch preserved for manual recovery - truly unresolvable conflicts",
			);
		} else {
			gitLogger.warn({ branch: item.branch, error: item.error }, "Branch preserved for manual recovery");
		}

		return item;
	}

	/**
	 * Log pre-merge conflicts for a branch (informational only, doesn't block)
	 */
	private logPreMergeConflicts(branch: string): void {
		const queueConflicts = this.getConflictsForBranch(branch);
		if (queueConflicts.length === 0) return;

		const hasErrorSeverity = queueConflicts.some((c) => c.severity === "error");
		gitLogger.warn(
			{
				branch,
				conflicts: queueConflicts.map((c) => ({ with: c.conflictsWith, files: c.overlappingFiles })),
				severity: hasErrorSeverity ? "error" : "warning",
			},
			"Pre-merge conflict flagged: branch modifies files touched by other queued branches",
		);

		if (hasErrorSeverity) {
			const allOverlappingFiles = [...new Set(queueConflicts.flatMap((c) => c.overlappingFiles))];
			gitLogger.info(
				{ branch, overlappingFiles: allOverlappingFiles },
				"Proceeding with merge despite file overlap - fallback strategies may resolve conflicts",
			);
		}
	}

	/**
	 * Process a non-worktree branch (legacy path)
	 */
	private async processLegacyBranch(item: MergeQueueItem, cwd: string): Promise<MergeQueueItem> {
		gitLogger.debug({ branch: item.branch }, "Checking out branch");
		checkoutBranch(item.branch);

		// Rebase and test
		const rebaseResult = await this.tryRebase(item, cwd);
		if (!rebaseResult.success) {
			return this.handleMergeFailure(item, rebaseResult.error!);
		}

		// Merge into main
		const mergeResult = await this.tryMerge(item);
		if (!mergeResult.success) {
			return this.handleMergeFailure(item, mergeResult.error!, mergeResult.conflictFiles);
		}

		// Success
		item.strategyUsed = mergeResult.strategyUsed;
		deleteBranch(item.branch);
		await this.completeItem(item);
		return item;
	}

	/**
	 * Process the next item in the queue
	 */
	async processNext(): Promise<MergeQueueItem | null> {
		if (this.processing) return null;

		const item = this.queue.find((i) => i.status === "pending");
		if (!item) return null;

		this.logPreMergeConflicts(item.branch);
		this.processing = true;

		const originalBranch = getCurrentBranch();
		const cwd = process.cwd();

		try {
			if (this.isWorktreeBranch(item.branch)) {
				gitLogger.debug({ branch: item.branch }, "Detected worktree branch, merging from worktree");
				return await this.processWorktreeBranch(item, cwd);
			}
			return await this.processLegacyBranch(item, cwd);
		} catch (error) {
			return this.handleMergeFailure(item, error instanceof Error ? error.message : String(error));
		} finally {
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
	async processAll(): Promise<MergeQueueItem[]> {
		const results: MergeQueueItem[] = [];
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
	async retryFailed(): Promise<MergeQueueItem[]> {
		const results: MergeQueueItem[] = [];
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
	getFailed(): MergeQueueItem[] {
		return this.queue.filter((i) => i.status === "conflict" || i.status === "test_failed");
	}

	/**
	 * Get items that are eligible for retry
	 */
	getRetryable(): MergeQueueItem[] {
		return this.getFailed().filter((item) => this.canRetry(item));
	}

	/**
	 * Get items that have exhausted all retries
	 */
	getExhausted(): MergeQueueItem[] {
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
