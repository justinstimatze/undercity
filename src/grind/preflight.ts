/**
 * Grind Preflight Module
 *
 * Pre-execution checks: usage limits, pattern priming, AST index, recovery detection.
 */

import * as output from "../output.js";
import type { PreflightResult } from "./types.js";

/**
 * Check Claude Max usage limits
 */
export async function checkUsageLimits(): Promise<{ ok: boolean; percent?: number; needsLogin?: boolean }> {
	try {
		const { fetchClaudeUsage } = await import("../claude-usage.js");
		const usage = await fetchClaudeUsage();

		if (usage?.success) {
			const maxPercent = Math.max(usage.fiveHourPercent, usage.weeklyPercent);
			return { ok: maxPercent < 95, percent: maxPercent };
		} else if (usage?.needsLogin) {
			return { ok: true, needsLogin: true };
		}
	} catch {
		// Usage check is optional
	}

	return { ok: true };
}

/**
 * Prime task-file patterns from git history if store is small
 */
export async function primePatterns(): Promise<{ primed: boolean; patternsAdded?: number; commitsProcessed?: number }> {
	try {
		const { getTaskFileStats, primeFromGitHistory } = await import("../task-file-patterns.js");
		const stats = getTaskFileStats();

		if (stats.uniqueKeywords < 10) {
			const primeResult = await primeFromGitHistory(100);
			if (primeResult.patternsAdded > 0) {
				return {
					primed: true,
					patternsAdded: primeResult.patternsAdded,
					commitsProcessed: primeResult.commitsProcessed,
				};
			}
		}
	} catch {
		// Non-critical - continue without priming
	}

	return { primed: false };
}

/**
 * Build or load AST index for context selection
 */
export async function prepareASTIndex(): Promise<{
	ready: boolean;
	fileCount?: number;
	symbolCount?: number;
	rebuilt?: boolean;
}> {
	try {
		const { getASTIndex } = await import("../ast-index.js");
		const index = getASTIndex();
		await index.load();
		const stats = index.getStats();

		if (stats.fileCount === 0) {
			await index.rebuildFull();
			await index.save();
			const newStats = index.getStats();
			return {
				ready: true,
				fileCount: newStats.fileCount,
				symbolCount: newStats.symbolCount,
				rebuilt: true,
			};
		}

		return {
			ready: true,
			fileCount: stats.fileCount,
			symbolCount: stats.symbolCount,
			rebuilt: false,
		};
	} catch {
		// Non-critical - context selection will fall back to git grep
		return { ready: false };
	}
}

/**
 * Check if task board is empty
 */
export async function checkTaskBoard(): Promise<{ empty: boolean; pendingCount: number; inProgressCount: number }> {
	try {
		const { getAllTasks } = await import("../task.js");
		const allTasks = getAllTasks();
		const pendingTasks = allTasks.filter((t) => t.status === "pending");
		const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");

		return {
			empty: pendingTasks.length === 0 && inProgressTasks.length === 0,
			pendingCount: pendingTasks.length,
			inProgressCount: inProgressTasks.length,
		};
	} catch {
		return { empty: true, pendingCount: 0, inProgressCount: 0 };
	}
}

/**
 * Check for interrupted batch that needs recovery
 */
export async function checkRecovery(orchestrator: {
	hasActiveRecovery: () => Promise<boolean>;
	getRecoveryInfo: () => Promise<unknown>;
}): Promise<{
	needed: boolean;
	info?: {
		batchId: string;
		startedAt: Date;
		tasksComplete: number;
		tasksFailed: number;
		tasksPending: number;
	};
}> {
	const hasRecovery = await orchestrator.hasActiveRecovery();

	if (hasRecovery) {
		const recoveryInfo = (await orchestrator.getRecoveryInfo()) as {
			batchId: string;
			startedAt: Date;
			tasksComplete: number;
			tasksFailed: number;
			tasksPending: number;
		};
		return { needed: true, info: recoveryInfo };
	}

	return { needed: false };
}

/**
 * Run pre-flight reconciliation to detect duplicate work
 */
export async function runPreflightReconciliation(): Promise<{
	duplicatesFound: number;
	tasksMarked: Array<{ taskId: string }>;
}> {
	const { reconcileTasks } = await import("../task.js");
	return reconcileTasks({ lookbackCommits: 50, dryRun: false });
}

/**
 * Verify baseline (main branch is green)
 */
export async function verifyBaseline(): Promise<{ passed: boolean; feedback: string; cached: boolean }> {
	const { verifyBaseline: verify } = await import("../verification.js");
	return verify();
}

/**
 * Run all pre-flight checks
 */
export async function runAllPreflightChecks(): Promise<PreflightResult> {
	// Run checks in parallel where possible
	const [usageResult, patternsResult, astResult, boardResult] = await Promise.all([
		checkUsageLimits(),
		primePatterns(),
		prepareASTIndex(),
		checkTaskBoard(),
	]);

	return {
		usageOk: usageResult.ok,
		usagePercent: usageResult.percent,
		patternsReady: patternsResult.primed || true,
		patternsAdded: patternsResult.patternsAdded,
		astIndexReady: astResult.ready,
		astFileCount: astResult.fileCount,
		boardEmpty: boardResult.empty,
		pendingCount: boardResult.pendingCount + boardResult.inProgressCount,
		recoveryNeeded: false, // Checked separately with orchestrator
	};
}

/**
 * Log pre-flight check results
 */
export function logPreflightResults(results: PreflightResult): void {
	// Usage
	if (results.usagePercent !== undefined) {
		if (results.usagePercent >= 95) {
			output.warning(`Claude Max usage at ${results.usagePercent.toFixed(0)}% - consider waiting for reset`);
		} else if (results.usagePercent >= 80) {
			output.info(`Claude Max usage: ${results.usagePercent.toFixed(0)}% of limit`);
		} else {
			output.debug(`Usage headroom OK: ${results.usagePercent.toFixed(0)}% used`);
		}
	} else {
		output.debug("Skipping usage check (run 'undercity usage --login' to enable)");
	}

	// Patterns
	if (results.patternsAdded && results.patternsAdded > 0) {
		output.info(`Primed ${results.patternsAdded} patterns from git history`);
	}

	// AST index
	if (results.astIndexReady && results.astFileCount) {
		output.debug(`AST index loaded: ${results.astFileCount} files`);
	} else {
		output.debug("AST index unavailable, will use git grep for context");
	}
}
