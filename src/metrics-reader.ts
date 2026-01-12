/**
 * Metrics Reader Module
 *
 * Reads and analyzes grind event logs for metrics and analytics.
 * Provides functionality to extract success/failure counts by model and complexity.
 */

import { existsSync, readFileSync } from "node:fs";
import type { GrindEvent } from "./grind-events.js";

/**
 * Grind metrics aggregated from event log
 */
export interface GrindMetrics {
	/** Total successful task completions */
	successCount: number;
	/** Total failed task completions */
	failCount: number;
	/** Metrics broken down by model */
	byModel: {
		haiku: { success: number; fail: number };
		sonnet: { success: number; fail: number };
		opus: { success: number; fail: number };
	};
	/** Metrics broken down by complexity level (simplified grouping) */
	byComplexity: {
		simple: { success: number; fail: number };
		medium: { success: number; fail: number };
		complex: { success: number; fail: number };
	};
}

/**
 * Simplified complexity bucket type for metrics grouping
 */
type SimplifiedComplexity = "simple" | "medium" | "complex";

/**
 * Mapping of complexity levels to simplified buckets
 * - simple: trivial, simple tasks
 * - medium: standard tasks
 * - complex: complex, critical tasks
 */
const COMPLEXITY_MAPPING: Record<string, SimplifiedComplexity> = {
	trivial: "simple",
	simple: "simple",
	standard: "medium",
	medium: "medium",
	complex: "complex",
	critical: "complex",
};

/**
 * Load and analyze grind metrics from event log
 *
 * @param path - Path to grind events JSONL file
 * @returns Aggregated metrics by model and complexity
 */
export function loadGrindMetrics(path = ".undercity/grind-events.jsonl"): GrindMetrics {
	const metrics: GrindMetrics = {
		successCount: 0,
		failCount: 0,
		byModel: {
			haiku: { success: 0, fail: 0 },
			sonnet: { success: 0, fail: 0 },
			opus: { success: 0, fail: 0 },
		},
		byComplexity: {
			simple: { success: 0, fail: 0 },
			medium: { success: 0, fail: 0 },
			complex: { success: 0, fail: 0 },
		},
	};

	// Return empty metrics if file doesn't exist
	if (!existsSync(path)) {
		return metrics;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const event = JSON.parse(line) as GrindEvent;

				// Only process task completion events
				if (event.type !== "task_complete" && event.type !== "task_failed") {
					continue;
				}

				const isSuccess = event.type === "task_complete";
				const data = event.data || {};

				// Extract model from event data - try multiple possible field names
				const model =
					(data.model as string) ||
					(data.finalModel as string) ||
					(data.startingModel as string) ||
					(data.recommendedModel as string) ||
					"sonnet"; // Default to sonnet if not specified

				const normalizedModel = model.toLowerCase();

				// Extract complexity from event data - try multiple possible field names
				const complexity =
					(data.complexity as string) ||
					(data.complexityLevel as string) ||
					(data.recommendedModel === "haiku" ? "simple" : "standard"); // Fallback based on model

				const normalizedComplexity = complexity?.toLowerCase() || "standard";

				// Update counters
				if (isSuccess) {
					metrics.successCount++;
				} else {
					metrics.failCount++;
				}

				// Update model-specific counters
				if (normalizedModel === "haiku") {
					if (isSuccess) {
						metrics.byModel.haiku.success++;
					} else {
						metrics.byModel.haiku.fail++;
					}
				} else if (normalizedModel === "sonnet") {
					if (isSuccess) {
						metrics.byModel.sonnet.success++;
					} else {
						metrics.byModel.sonnet.fail++;
					}
				} else if (normalizedModel === "opus") {
					if (isSuccess) {
						metrics.byModel.opus.success++;
					} else {
						metrics.byModel.opus.fail++;
					}
				}

				// Update complexity-specific counters
				const mappedComplexity = COMPLEXITY_MAPPING[normalizedComplexity] || "medium";
				if (isSuccess) {
					metrics.byComplexity[mappedComplexity].success++;
				} else {
					metrics.byComplexity[mappedComplexity].fail++;
				}
			} catch {
				// Skip malformed lines - continue is unnecessary at end of loop
			}
		}
	} catch {
		// Return empty metrics if file can't be read
		return metrics;
	}

	return metrics;
}
