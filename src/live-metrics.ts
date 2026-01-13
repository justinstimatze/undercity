/**
 * Live Metrics
 *
 * Maintains a running total of SDK metrics in a JSON file
 * that the dashboard can easily read.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Get the main git worktree path (not a linked worktree).
 * This ensures metrics always write to the main repo's .undercity/
 */
export function getMainWorktreePath(): string {
	try {
		// Get main worktree from git
		const result = execSync("git worktree list --porcelain 2>/dev/null | head -1 | cut -d' ' -f2", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (result && existsSync(result)) {
			return result;
		}
	} catch {
		// Fall back to cwd if git command fails
	}
	return process.cwd();
}

export interface LiveMetrics {
	/** Last update timestamp */
	updatedAt: number;
	/** Session start timestamp */
	sessionStartedAt: number;
	/** Total tokens */
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheCreation: number;
		total: number;
	};
	/** Cost in USD */
	cost: {
		total: number;
	};
	/** Per-model breakdown */
	byModel: {
		opus: { input: number; output: number; cost: number };
		sonnet: { input: number; output: number; cost: number };
		haiku: { input: number; output: number; cost: number };
	};
	/** Query stats */
	queries: {
		total: number;
		successful: number;
		failed: number;
		rateLimited: number;
	};
	/** Timing */
	timing: {
		totalApiMs: number;
		totalDurationMs: number;
		turns: number;
	};
	/** Grind progress - tracks current grind run */
	grind?: {
		/** Number of tasks completed in current grind run */
		completed: number;
		/** Total tasks to process (from -n flag or task board) */
		total: number;
		/** Whether -n flag was used (fixed count) or using task board */
		mode: "fixed" | "board";
		/** When this grind session started */
		startedAt: number;
	};
}

// Use main worktree so metrics aggregate from all worktrees
const METRICS_DIR = join(getMainWorktreePath(), ".undercity");
const METRICS_FILE = join(METRICS_DIR, "live-metrics.json");

function createEmptyMetrics(): LiveMetrics {
	const now = Date.now();
	return {
		updatedAt: now,
		sessionStartedAt: now,
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheCreation: 0,
			total: 0,
		},
		cost: {
			total: 0,
		},
		byModel: {
			opus: { input: 0, output: 0, cost: 0 },
			sonnet: { input: 0, output: 0, cost: 0 },
			haiku: { input: 0, output: 0, cost: 0 },
		},
		queries: {
			total: 0,
			successful: 0,
			failed: 0,
			rateLimited: 0,
		},
		timing: {
			totalApiMs: 0,
			totalDurationMs: 0,
			turns: 0,
		},
	};
}

/**
 * Load current metrics from disk
 */
export function loadLiveMetrics(): LiveMetrics {
	try {
		if (!existsSync(METRICS_FILE)) {
			return createEmptyMetrics();
		}
		const content = readFileSync(METRICS_FILE, "utf-8");
		return JSON.parse(content) as LiveMetrics;
	} catch {
		return createEmptyMetrics();
	}
}

/**
 * Save metrics to disk
 */
export function saveLiveMetrics(metrics: LiveMetrics): void {
	try {
		mkdirSync(METRICS_DIR, { recursive: true });
		metrics.updatedAt = Date.now();

		const tempPath = `${METRICS_FILE}.tmp`;

		// Write to temporary file first
		writeFileSync(tempPath, JSON.stringify(metrics, null, 2), {
			encoding: "utf-8",
			flag: "w",
		});

		// Atomically rename temporary file to target file
		// This ensures the file is never in a partially written state
		renameSync(tempPath, METRICS_FILE);
	} catch (err) {
		// Clean up temporary file if it exists
		const tempPath = `${METRICS_FILE}.tmp`;
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		console.error("Failed to save live metrics:", err);
	}
}

/**
 * Reset metrics for a new session
 */
export function resetLiveMetrics(): LiveMetrics {
	const metrics = createEmptyMetrics();
	saveLiveMetrics(metrics);
	return metrics;
}

/**
 * Record a completed query result
 */
export function recordQueryResult(result: {
	success: boolean;
	rateLimited?: boolean;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
	durationMs?: number;
	apiDurationMs?: number;
	turns?: number;
	model?: "opus" | "sonnet" | "haiku";
	modelUsage?: Record<
		string,
		{
			inputTokens?: number;
			outputTokens?: number;
			costUSD?: number;
		}
	>;
}): void {
	const metrics = loadLiveMetrics();

	// Update query counts
	metrics.queries.total++;
	if (result.success) {
		metrics.queries.successful++;
	} else {
		metrics.queries.failed++;
	}
	if (result.rateLimited) {
		metrics.queries.rateLimited++;
	}

	// Update token counts - only from raw values if modelUsage not provided
	// (modelUsage updates totals later to avoid double-counting)
	if (!result.modelUsage) {
		if (result.inputTokens != null) {
			metrics.tokens.input += result.inputTokens;
			metrics.tokens.total += result.inputTokens;
		}
		if (result.outputTokens != null) {
			metrics.tokens.output += result.outputTokens;
			metrics.tokens.total += result.outputTokens;
		}
	}
	if (result.cacheReadTokens != null) {
		metrics.tokens.cacheRead += result.cacheReadTokens;
	}
	if (result.cacheCreationTokens != null) {
		metrics.tokens.cacheCreation += result.cacheCreationTokens;
	}

	// Update cost (use != null to handle 0 values correctly)
	if (result.costUsd != null) {
		metrics.cost.total += result.costUsd;
	}

	// Update timing (use != null to handle 0 values correctly)
	if (result.durationMs != null) {
		metrics.timing.totalDurationMs += result.durationMs;
	}
	if (result.apiDurationMs != null) {
		metrics.timing.totalApiMs += result.apiDurationMs;
	}
	if (result.turns != null) {
		metrics.timing.turns += result.turns;
	}

	// Update per-model stats
	if (result.modelUsage) {
		for (const [model, usage] of Object.entries(result.modelUsage)) {
			const modelKey = model.includes("opus")
				? "opus"
				: model.includes("sonnet")
					? "sonnet"
					: model.includes("haiku")
						? "haiku"
						: null;

			if (modelKey && metrics.byModel[modelKey]) {
				const inputToks = usage.inputTokens || 0;
				const outputToks = usage.outputTokens || 0;
				metrics.byModel[modelKey].input += inputToks;
				metrics.byModel[modelKey].output += outputToks;
				metrics.byModel[modelKey].cost += usage.costUSD || 0;
				// Also add to top-level totals
				metrics.tokens.input += inputToks;
				metrics.tokens.output += outputToks;
				metrics.tokens.total += inputToks + outputToks;
			}
		}
	} else if (result.model && metrics.byModel[result.model]) {
		// Fallback to single model if modelUsage not provided
		metrics.byModel[result.model].input += result.inputTokens || 0;
		metrics.byModel[result.model].output += result.outputTokens || 0;
		metrics.byModel[result.model].cost += result.costUsd || 0;
	}

	saveLiveMetrics(metrics);
}

/**
 * Get metrics formatted for display
 */
export function getMetricsDisplay(): {
	tokens: string;
	cost: string;
	queries: string;
	burnRate: string;
} {
	const metrics = loadLiveMetrics();
	const sessionDurationMs = Date.now() - metrics.sessionStartedAt;
	const sessionMinutes = sessionDurationMs / 60000;

	// Calculate burn rate (tokens per minute)
	const burnRate = sessionMinutes > 0 ? Math.round(metrics.tokens.total / sessionMinutes) : 0;

	return {
		tokens: `${(metrics.tokens.total / 1000).toFixed(1)}k`,
		cost: `$${metrics.cost.total.toFixed(3)}`,
		queries: `${metrics.queries.successful}/${metrics.queries.total}`,
		burnRate: `${burnRate}/min`,
	};
}

/**
 * Start tracking a new grind session
 * @param total Total tasks to process (from -n flag or task board count)
 * @param mode "fixed" if -n flag used, "board" if processing task board
 */
export function startGrindProgress(total: number, mode: "fixed" | "board"): void {
	const metrics = loadLiveMetrics();
	metrics.grind = {
		completed: 0,
		total,
		mode,
		startedAt: Date.now(),
	};
	saveLiveMetrics(metrics);
}

/**
 * Update grind progress after a task completes
 */
export function updateGrindProgress(completed: number, total?: number): void {
	const metrics = loadLiveMetrics();
	if (metrics.grind) {
		metrics.grind.completed = completed;
		if (total !== undefined) {
			metrics.grind.total = total;
		}
	} else {
		// Initialize if not started (shouldn't happen but be safe)
		metrics.grind = {
			completed,
			total: total ?? completed,
			mode: "board",
			startedAt: Date.now(),
		};
	}
	saveLiveMetrics(metrics);
}

/**
 * Clear grind progress when session ends
 */
export function clearGrindProgress(): void {
	const metrics = loadLiveMetrics();
	metrics.grind = undefined;
	saveLiveMetrics(metrics);
}
