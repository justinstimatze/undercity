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
function getMainWorktreePath(): string {
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

	// Update token counts
	if (result.inputTokens) {
		metrics.tokens.input += result.inputTokens;
		metrics.tokens.total += result.inputTokens;
	}
	if (result.outputTokens) {
		metrics.tokens.output += result.outputTokens;
		metrics.tokens.total += result.outputTokens;
	}
	if (result.cacheReadTokens) {
		metrics.tokens.cacheRead += result.cacheReadTokens;
	}
	if (result.cacheCreationTokens) {
		metrics.tokens.cacheCreation += result.cacheCreationTokens;
	}

	// Update cost
	if (result.costUsd) {
		metrics.cost.total += result.costUsd;
	}

	// Update timing
	if (result.durationMs) {
		metrics.timing.totalDurationMs += result.durationMs;
	}
	if (result.apiDurationMs) {
		metrics.timing.totalApiMs += result.apiDurationMs;
	}
	if (result.turns) {
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
				metrics.byModel[modelKey].input += usage.inputTokens || 0;
				metrics.byModel[modelKey].output += usage.outputTokens || 0;
				metrics.byModel[modelKey].cost += usage.costUSD || 0;
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
