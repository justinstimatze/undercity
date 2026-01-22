/**
 * Orchestrator Rebase Helpers
 *
 * Extracted helper functions for rebase operations and conflict resolution.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as output from "../output.js";
import { execGitInDir } from "./git-utils.js";

/**
 * Configuration for rebase conflict resolution
 */
export interface RebaseConfig {
	/** Model to use for conflict resolution */
	conflictResolutionModel: string;
	/** Model to use for verification fix */
	verificationFixModel: string;
	/** Max turns for conflict resolution agent */
	conflictResolutionMaxTurns: number;
	/** Max turns for verification fix agent */
	verificationFixMaxTurns: number;
}

/**
 * Default rebase configuration
 */
export const DEFAULT_REBASE_CONFIG: RebaseConfig = {
	conflictResolutionModel: "claude-opus-4-5-20251101",
	verificationFixModel: "claude-sonnet-4-20250514",
	conflictResolutionMaxTurns: 10,
	verificationFixMaxTurns: 5,
};

/**
 * Safely abort a rebase operation
 *
 * @param worktreePath - Path to the worktree
 */
export function abortRebase(worktreePath: string): void {
	try {
		execGitInDir(["rebase", "--abort"], worktreePath);
	} catch {
		// Ignore abort errors
	}
}

/**
 * Check if a rebase is still in progress
 *
 * @param worktreePath - Path to the worktree
 * @returns true if rebase is in progress
 */
export function isRebaseInProgress(worktreePath: string): boolean {
	try {
		execGitInDir(["rev-parse", "--verify", "REBASE_HEAD"], worktreePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get list of conflicted files from git status
 *
 * @param worktreePath - Path to the worktree
 * @returns Array of conflicted file paths
 */
export function getConflictedFiles(worktreePath: string): string[] {
	const statusOutput = execGitInDir(["status", "--porcelain"], worktreePath);
	return statusOutput
		.split("\n")
		.filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DU") || line.startsWith("UD"))
		.map((line) => line.slice(3).trim());
}

/**
 * Read conflict details from files (limited to prevent token explosion)
 *
 * @param worktreePath - Path to the worktree
 * @param conflictedFiles - List of conflicted files
 * @param maxFiles - Maximum files to read (default: 3)
 * @param maxContentSize - Maximum content size per file (default: 3000)
 * @returns Array of formatted conflict details
 */
export function readConflictDetails(
	worktreePath: string,
	conflictedFiles: string[],
	maxFiles: number = 3,
	maxContentSize: number = 3000,
): string[] {
	const conflictDetails: string[] = [];

	for (const file of conflictedFiles.slice(0, maxFiles)) {
		try {
			const content = readFileSync(join(worktreePath, file), "utf-8");
			// Only include if it has conflict markers
			if (content.includes("<<<<<<<") && content.includes(">>>>>>>")) {
				conflictDetails.push(`\n--- ${file} ---\n${content.slice(0, maxContentSize)}`);
			}
		} catch {
			// File might not be readable, skip
		}
	}

	return conflictDetails;
}

/**
 * Build the prompt for conflict resolution agent
 *
 * @param conflictedFiles - List of conflicted files
 * @param conflictDetails - Formatted conflict details
 * @param worktreePath - Path to the worktree
 * @returns Formatted prompt string
 */
export function buildConflictResolutionPrompt(
	conflictedFiles: string[],
	conflictDetails: string[],
	worktreePath: string,
): string {
	return `REBASE CONFLICT - You need to resolve merge conflicts in these files:

Conflicted files: ${conflictedFiles.join(", ")}

${conflictDetails.length > 0 ? `Conflict details:${conflictDetails.join("\n")}` : ""}

INSTRUCTIONS:
1. Read each conflicted file
2. Understand both the incoming changes (HEAD) and the current changes
3. Edit the files to integrate both sets of changes, removing ALL conflict markers (<<<<<<<, =======, >>>>>>>)
4. After resolving all conflicts, run: git add <resolved-files>
5. Then run: git rebase --continue

Focus ONLY on resolving the conflicts. Integrate changes logically - do not just pick one side.

Working directory: ${worktreePath}`;
}

/**
 * Build the prompt for verification fix agent
 *
 * @param errorOutput - Error output from verification
 * @param worktreePath - Path to the worktree
 * @returns Formatted prompt string
 */
export function buildVerificationFixPrompt(errorOutput: string, worktreePath: string): string {
	return `VERIFICATION FAILED after rebasing onto main. Fix these errors:

${errorOutput}

Focus ONLY on fixing the specific errors shown above. Do not refactor or change anything else.
The errors are likely caused by changes in main that conflict with this branch's changes.

Working directory: ${worktreePath}`;
}

/**
 * Attempt to resolve rebase conflicts by spawning an agent
 *
 * @param taskId - Task identifier for logging
 * @param worktreePath - Path to the worktree
 * @param config - Rebase configuration (optional)
 * @returns true if conflicts were resolved and rebase continued successfully
 */
export async function attemptRebaseConflictResolution(
	taskId: string,
	worktreePath: string,
	config: RebaseConfig = DEFAULT_REBASE_CONFIG,
): Promise<boolean> {
	const conflictedFiles = getConflictedFiles(worktreePath);

	if (conflictedFiles.length === 0) {
		output.warning(`No conflicted files found for ${taskId}, rebase may have failed for another reason`);
		return false;
	}

	output.info(`Found ${conflictedFiles.length} conflicted file(s) for ${taskId}: ${conflictedFiles.join(", ")}`);

	const conflictDetails = readConflictDetails(worktreePath, conflictedFiles);
	const resolvePrompt = buildConflictResolutionPrompt(conflictedFiles, conflictDetails, worktreePath);

	output.info(`Spawning conflict resolution agent for ${taskId}...`);

	try {
		for await (const message of query({
			prompt: resolvePrompt,
			options: {
				model: config.conflictResolutionModel,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: config.conflictResolutionMaxTurns,
				settingSources: ["project"],
				cwd: worktreePath,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				output.info(`Conflict resolution agent completed for ${taskId}`);
			}
		}

		// Check if rebase is still in progress (failed to continue)
		if (isRebaseInProgress(worktreePath)) {
			output.warning(`Rebase still in progress for ${taskId}, agent may not have completed resolution`);
			return false;
		}

		return true;
	} catch (agentError) {
		output.warning(`Conflict resolution agent failed for ${taskId}: ${agentError}`);
		return false;
	}
}

/**
 * Attempt to fix verification errors after rebase by spawning a lightweight agent
 *
 * @param taskId - Task identifier for logging
 * @param worktreePath - Path to the worktree
 * @param errorOutput - Error output from verification
 * @param config - Rebase configuration (optional)
 */
export async function attemptMergeVerificationFix(
	taskId: string,
	worktreePath: string,
	errorOutput: string,
	config: RebaseConfig = DEFAULT_REBASE_CONFIG,
): Promise<void> {
	const fixPrompt = buildVerificationFixPrompt(errorOutput, worktreePath);

	output.info(`Spawning fix agent for ${taskId}...`);

	for await (const message of query({
		prompt: fixPrompt,
		options: {
			model: config.verificationFixModel,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: config.verificationFixMaxTurns,
			settingSources: ["project"],
			cwd: worktreePath,
		},
	})) {
		if (message.type === "result" && message.subtype === "success") {
			output.info(`Fix agent completed for ${taskId}`);
		}
	}
}

/**
 * Rebase worktree onto local main (FETCH_HEAD) with conflict resolution
 *
 * @param taskId - Task identifier for logging
 * @param worktreePath - Path to the worktree
 * @param config - Rebase configuration (optional)
 */
export async function rebaseOntoMain(
	taskId: string,
	worktreePath: string,
	config: RebaseConfig = DEFAULT_REBASE_CONFIG,
): Promise<void> {
	try {
		execGitInDir(["rebase", "FETCH_HEAD"], worktreePath);
	} catch (error) {
		const errorStr = String(error);

		// Check if this is a merge conflict that we can try to resolve
		if (errorStr.includes("conflict") || errorStr.includes("could not apply")) {
			output.warning(`Rebase conflict for ${taskId}, attempting to resolve...`);

			try {
				const resolved = await attemptRebaseConflictResolution(taskId, worktreePath, config);
				if (!resolved) {
					abortRebase(worktreePath);
					throw new Error(`Rebase failed for ${taskId}: Unable to resolve conflicts`);
				}
				output.success(`Resolved rebase conflict for ${taskId}`);
			} catch (resolveError) {
				abortRebase(worktreePath);
				throw new Error(`Rebase failed for ${taskId}: ${resolveError}`);
			}
		} else {
			abortRebase(worktreePath);
			throw new Error(`Rebase failed for ${taskId}: ${error}`);
		}
	}
}
