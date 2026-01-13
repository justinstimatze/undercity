/**
 * Self-Tuning Model Router
 *
 * Learns optimal model routing thresholds from historical task metrics.
 * Persists learned thresholds to .undercity/routing-profile.json.
 *
 * Key insight: different codebases and task types have different success
 * patterns. This module observes actual outcomes and adjusts routing
 * accordingly, reducing token waste on over-provisioned tasks and
 * improving success rates on under-provisioned ones.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComplexityLevel } from "./complexity.js";
import type { ModelTier } from "./feedback-metrics.js";
import { analyzeMetrics, loadMetrics } from "./feedback-metrics.js";
import { sessionLogger } from "./logger.js";

const PROFILE_FILE = ".undercity/routing-profile.json";

/**
 * Routing threshold for a model tier at a complexity level
 */
export interface RoutingThreshold {
	/** Minimum success rate required to use this tier (0-1) */
	minSuccessRate: number;
	/** Minimum samples needed before using learned threshold */
	minSamples: number;
	/** Whether to skip this tier (always escalate past it) */
	skip: boolean;
}

/**
 * Learned routing profile for a project
 */
export interface RoutingProfile {
	/** Schema version for migrations */
	version: number;
	/** When profile was last updated */
	updatedAt: string;
	/** Number of tasks used to compute this profile */
	taskCount: number;
	/** Thresholds by model and complexity: e.g., "haiku:simple" -> threshold */
	thresholds: Record<string, RoutingThreshold>;
	/** Overall model tier success rates (observed) */
	modelSuccessRates: Record<ModelTier, number>;
	/** Recommendations generated from last analysis */
	recommendations: string[];
}

/**
 * Default thresholds (used before enough data is collected)
 */
const DEFAULT_THRESHOLDS: Record<ModelTier, RoutingThreshold> = {
	haiku: { minSuccessRate: 0.7, minSamples: 3, skip: false },
	sonnet: { minSuccessRate: 0.6, minSamples: 3, skip: false },
	opus: { minSuccessRate: 0.0, minSamples: 0, skip: false }, // Always succeed or fail
};

/**
 * Complexity levels where haiku should never be used (default)
 * These can be overridden by learned profile if haiku succeeds consistently
 */
const HAIKU_BLOCKED_COMPLEXITY: ComplexityLevel[] = ["complex", "critical"];

/**
 * Load routing profile from disk
 */
export function loadRoutingProfile(basePath: string = process.cwd()): RoutingProfile | null {
	const profilePath = join(basePath, PROFILE_FILE);

	try {
		if (!existsSync(profilePath)) {
			return null;
		}
		const content = readFileSync(profilePath, "utf-8");
		return JSON.parse(content) as RoutingProfile;
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to load routing profile");
		return null;
	}
}

/**
 * Save routing profile to disk
 */
export function saveRoutingProfile(profile: RoutingProfile, basePath: string = process.cwd()): void {
	const profilePath = join(basePath, PROFILE_FILE);

	try {
		writeFileSync(profilePath, JSON.stringify(profile, null, 2));
		sessionLogger.debug({ profilePath, taskCount: profile.taskCount }, "Saved routing profile");
	} catch (error) {
		sessionLogger.error({ error: String(error) }, "Failed to save routing profile");
	}
}

/**
 * Get threshold for a specific model+complexity combination
 */
export function getThreshold(
	profile: RoutingProfile | null,
	model: ModelTier,
	complexity: ComplexityLevel,
): RoutingThreshold {
	if (!profile) {
		return DEFAULT_THRESHOLDS[model];
	}

	const key = `${model}:${complexity}`;
	const specific = profile.thresholds[key];

	if (specific) {
		return specific;
	}

	// Fall back to model-level default with slight adjustment for complexity
	const modelDefault = DEFAULT_THRESHOLDS[model];
	return modelDefault;
}

/**
 * Check if a model should be skipped for a complexity level
 */
export function shouldSkipModel(
	profile: RoutingProfile | null,
	model: ModelTier,
	complexity: ComplexityLevel,
): boolean {
	// Always allow opus
	if (model === "opus") {
		return false;
	}

	// Check learned profile
	const threshold = getThreshold(profile, model, complexity);
	if (threshold.skip) {
		return true;
	}

	// Default blocking for haiku on complex tasks
	if (model === "haiku" && HAIKU_BLOCKED_COMPLEXITY.includes(complexity)) {
		return !profile; // Block by default, but allow if profile says otherwise
	}

	return false;
}

/**
 * Compute optimal thresholds from historical metrics
 */
export function computeOptimalThresholds(basePath: string = process.cwd()): RoutingProfile {
	const records = loadMetrics({ path: join(basePath, ".undercity/metrics.jsonl") });
	const analysis = analyzeMetrics(records);

	const thresholds: Record<string, RoutingThreshold> = {};

	// Compute thresholds for each model+complexity combination
	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		for (const complexity of ["trivial", "simple", "standard", "complex", "critical"] as ComplexityLevel[]) {
			const key = `${model}:${complexity}`;
			const combo = analysis.byModelAndComplexity[key];

			if (!combo || combo.total < 3) {
				// Not enough data - use defaults
				thresholds[key] = { ...DEFAULT_THRESHOLDS[model] };
				continue;
			}

			// Determine if this tier should be skipped
			// Skip if success rate is very low AND we have enough samples
			const shouldSkip = combo.rate < 0.4 && combo.total >= 5;

			// Adjust minimum success rate based on observed performance
			// If this tier consistently succeeds, we can lower the threshold
			// If it consistently fails, raise the threshold (or skip it)
			let minSuccessRate = DEFAULT_THRESHOLDS[model].minSuccessRate;

			if (combo.rate > 0.9 && combo.total >= 5) {
				// Excellent performance - lower threshold to allow more tasks
				minSuccessRate = Math.max(0.5, minSuccessRate - 0.1);
			} else if (combo.rate < 0.5 && combo.total >= 5) {
				// Poor performance - raise threshold
				minSuccessRate = Math.min(0.9, minSuccessRate + 0.1);
			}

			thresholds[key] = {
				minSuccessRate,
				minSamples: Math.min(combo.total, 10), // Use available samples, cap at 10
				skip: shouldSkip,
			};
		}
	}

	// Extract model-level success rates
	const modelSuccessRates: Record<ModelTier, number> = {
		haiku: analysis.byModel.haiku.rate,
		sonnet: analysis.byModel.sonnet.rate,
		opus: analysis.byModel.opus.rate,
	};

	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		taskCount: analysis.totalTasks,
		thresholds,
		modelSuccessRates,
		recommendations: analysis.recommendations,
	};
}

/**
 * Update routing profile after task completion
 *
 * Call this after each task completes to potentially update learned thresholds.
 * Only updates if enough new data has accumulated.
 */
export function maybeUpdateProfile(basePath: string = process.cwd(), minNewTasks: number = 5): boolean {
	const currentProfile = loadRoutingProfile(basePath);
	const records = loadMetrics({ path: join(basePath, ".undercity/metrics.jsonl") });

	const newTaskCount = records.length;
	const oldTaskCount = currentProfile?.taskCount ?? 0;

	// Only update if we have enough new tasks
	if (newTaskCount - oldTaskCount < minNewTasks) {
		sessionLogger.debug({ newTaskCount, oldTaskCount, minNewTasks }, "Not enough new tasks to update routing profile");
		return false;
	}

	// Compute new profile
	const newProfile = computeOptimalThresholds(basePath);

	// Log significant changes
	if (currentProfile) {
		logProfileChanges(currentProfile, newProfile);
	}

	// Save updated profile
	saveRoutingProfile(newProfile, basePath);

	sessionLogger.info(
		{
			taskCount: newProfile.taskCount,
			recommendations: newProfile.recommendations.length,
		},
		"Updated routing profile from accumulated metrics",
	);

	return true;
}

/**
 * Log significant changes between old and new profiles
 */
function logProfileChanges(oldProfile: RoutingProfile, newProfile: RoutingProfile): void {
	const changes: string[] = [];

	// Check for threshold changes
	for (const [key, newThreshold] of Object.entries(newProfile.thresholds)) {
		const oldThreshold = oldProfile.thresholds[key];

		if (!oldThreshold) {
			changes.push(`New threshold for ${key}`);
			continue;
		}

		if (oldThreshold.skip !== newThreshold.skip) {
			changes.push(`${key}: skip changed ${oldThreshold.skip} -> ${newThreshold.skip}`);
		}

		const rateDiff = Math.abs(oldThreshold.minSuccessRate - newThreshold.minSuccessRate);
		if (rateDiff > 0.05) {
			changes.push(
				`${key}: minSuccessRate ${oldThreshold.minSuccessRate.toFixed(2)} -> ${newThreshold.minSuccessRate.toFixed(2)}`,
			);
		}
	}

	// Check for model success rate changes
	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		const oldRate = oldProfile.modelSuccessRates[model];
		const newRate = newProfile.modelSuccessRates[model];

		if (Math.abs(oldRate - newRate) > 0.1) {
			changes.push(`${model} success rate: ${(oldRate * 100).toFixed(0)}% -> ${(newRate * 100).toFixed(0)}%`);
		}
	}

	if (changes.length > 0) {
		sessionLogger.info({ changes }, "Routing profile changes detected");
	}
}

/**
 * Get the recommended starting model for a task
 *
 * Uses learned profile if available, otherwise falls back to defaults.
 */
export function getRecommendedModel(complexity: ComplexityLevel, basePath: string = process.cwd()): ModelTier {
	const profile = loadRoutingProfile(basePath);

	// Start with default recommendation based on complexity
	const defaultModels: Record<ComplexityLevel, ModelTier> = {
		trivial: "haiku",
		simple: "sonnet",
		standard: "sonnet",
		complex: "opus",
		critical: "opus",
	};

	let recommended = defaultModels[complexity];

	// Check if we should skip to a higher tier
	if (shouldSkipModel(profile, recommended, complexity)) {
		recommended = recommended === "haiku" ? "sonnet" : "opus";

		// Check again if we should skip sonnet
		if (recommended === "sonnet" && shouldSkipModel(profile, recommended, complexity)) {
			recommended = "opus";
		}
	}

	// Check learned success rates - if recommended tier has low success, escalate
	if (profile) {
		const threshold = getThreshold(profile, recommended, complexity);
		const comboKey = `${recommended}:${complexity}`;
		const combo = profile.thresholds[comboKey];

		if (combo && combo.minSamples > 0) {
			const actualRate = profile.modelSuccessRates[recommended];
			if (actualRate < threshold.minSuccessRate) {
				// Escalate due to low success rate
				const escalated = recommended === "haiku" ? "sonnet" : "opus";
				sessionLogger.debug(
					{
						original: recommended,
						escalated,
						actualRate,
						threshold: threshold.minSuccessRate,
					},
					"Escalating model due to learned low success rate",
				);
				return escalated;
			}
		}
	}

	return recommended;
}

/**
 * Generate a human-readable summary of the routing profile
 */
export function formatProfileSummary(profile: RoutingProfile): string {
	const lines: string[] = [];

	lines.push("Routing Profile Summary");
	lines.push("=".repeat(40));
	lines.push(`Tasks analyzed: ${profile.taskCount}`);
	lines.push(`Last updated: ${profile.updatedAt}`);
	lines.push("");

	lines.push("Model Success Rates:");
	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		const rate = profile.modelSuccessRates[model];
		lines.push(`  ${model}: ${(rate * 100).toFixed(0)}%`);
	}
	lines.push("");

	// Find any skipped combinations
	const skipped: string[] = [];
	for (const [key, threshold] of Object.entries(profile.thresholds)) {
		if (threshold.skip) {
			skipped.push(key);
		}
	}

	if (skipped.length > 0) {
		lines.push("Skipped (low success rate):");
		for (const key of skipped) {
			lines.push(`  ${key}`);
		}
		lines.push("");
	}

	if (profile.recommendations.length > 0) {
		lines.push("Recommendations:");
		for (const rec of profile.recommendations) {
			lines.push(`  - ${rec}`);
		}
	}

	return lines.join("\n");
}
