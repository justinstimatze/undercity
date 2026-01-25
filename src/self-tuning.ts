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
	sonnet: { minSuccessRate: 0.6, minSamples: 3, skip: false },
	opus: { minSuccessRate: 0.0, minSamples: 0, skip: false }, // Always succeed or fail
};

/**
 * Complexity levels where haiku should never be used (default)
 * These can be overridden by learned profile if haiku succeeds consistently
 */
const _HAIKU_BLOCKED_COMPLEXITY: ComplexityLevel[] = ["complex", "critical"];

/**
 * Configuration constants for confidence-based threshold tuning
 * These control how minSamples and minSuccessRate adapt based on data confidence
 */

/** Minimum samples threshold below which we apply conservative tuning */
const CONFIDENCE_LOW_THRESHOLD = 3;

/** Minimum samples threshold above which we apply aggressive tuning */
const CONFIDENCE_HIGH_THRESHOLD = 10;

/** MinSamples to require for low-confidence estimates (small sample size) */
const MIN_SAMPLES_LOW = 5;

/** MinSamples to require for high-confidence estimates (large sample size) */
const MIN_SAMPLES_HIGH = 20;

/** Sample size at which confidence interval becomes very reliable (scaling max) */
const _SAMPLE_SIZE_CONSERVATIVE = 5;

/** Sample size at which we can be aggressive with thresholds (scaling max) */
const _SAMPLE_SIZE_AGGRESSIVE = 15;

/** Success rate threshold below which a tier should be skipped (low performance) */
const SKIP_SUCCESS_RATE_THRESHOLD = 0.4;

/** Minimum samples before considering skipping a tier based on low success rate */
const SKIP_MIN_SAMPLES = 5;

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

	return false;
}

/**
 * Compute the Wilson score interval width for a binomial proportion.
 *
 * The Wilson score interval provides a confidence interval for success rate estimates
 * from small sample sizes. It works well even when success rate is near 0% or 100%.
 *
 * A wider interval indicates less confidence in the observed rate (more uncertainty).
 * A narrower interval indicates more confidence (less uncertainty).
 *
 * This is used to adapt minSuccessRate: when confidence is low (wide interval),
 * we use a more conservative threshold. When confidence is high (narrow interval),
 * we can be more aggressive.
 *
 * @param successful Number of successful outcomes
 * @param total Total number of outcomes
 * @returns Width of Wilson score interval (0-1). Higher = less confident.
 */
function computeBinomialConfidence(successful: number, total: number): number {
	if (total === 0) {
		return 1; // Maximum uncertainty when no data
	}

	// Edge cases: all success or all failure (uncertainty depends on sample size)
	if (successful === 0 || successful === total) {
		// For extreme cases, confidence decreases with smaller sample size
		// Return a value that scales inversely with sample size
		return Math.min(1, 1 / Math.sqrt(total));
	}

	const p = successful / total;
	const z = 1.96; // 95% confidence level (standard choice)

	// Wilson score interval formula
	const denominator = 1 + (z * z) / total;
	const _pHat = (p + (z * z) / (2 * total)) / denominator;
	const variance = ((p * (1 - p)) / total + (z * z) / (4 * total * total)) / (denominator * denominator);

	const marginOfError = z * Math.sqrt(variance);

	// Return the width of the confidence interval (which is 2 * marginOfError)
	// Capped at 1 to stay within [0, 1] bounds
	return Math.min(1, 2 * marginOfError);
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

			// Determine if this tier should be skipped based on performance.
			// Skip only if success rate is very low AND we have enough samples to be confident.
			// Using configurable thresholds: SKIP_SUCCESS_RATE_THRESHOLD and SKIP_MIN_SAMPLES
			const shouldSkip = combo.rate < SKIP_SUCCESS_RATE_THRESHOLD && combo.total >= SKIP_MIN_SAMPLES;

			// Compute minSuccessRate using confidence-based approach.
			// Instead of fixed +/-0.1 adjustments, we use binomial confidence intervals
			// to adapt thresholds based on how confident we are in the observed success rate.
			//
			// Key insight: small sample sizes have wide confidence intervals (high uncertainty),
			// so we use more conservative thresholds. Large sample sizes have narrow intervals
			// (high confidence), allowing more aggressive thresholds.
			//
			// For example:
			// - If we see 2/3 successes (67%), the 95% confidence interval is very wide.
			//   We don't know if true rate is 20% or 90%, so we use a conservative threshold.
			// - If we see 67/100 successes, the 95% confidence interval is much narrower.
			//   We're confident the true rate is around 67%, so we can use an aggressive threshold.

			const baseThreshold = DEFAULT_THRESHOLDS[model].minSuccessRate;

			// Compute confidence interval width using Wilson score interval (robust for small samples)
			const confidenceWidth = computeBinomialConfidence(combo.successful, combo.total);

			// Adapt minSuccessRate based on confidence:
			// - High confidence (narrow interval) -> more aggressive (lower threshold)
			// - Low confidence (wide interval) -> more conservative (higher threshold)
			//
			// We use the confidence interval width to modulate the adjustment.
			// The adjustment is proportional to confidence: high confidence allows lower rate,
			// low confidence forces higher rate.
			let minSuccessRate = baseThreshold;

			if (combo.rate > 0.85) {
				// Good performance observed
				// How much to lower the threshold depends on how confident we are
				const adjustment = confidenceWidth * 0.15; // Scale adjustment by confidence
				minSuccessRate = Math.max(0.5, baseThreshold - adjustment);
			} else if (combo.rate < 0.55) {
				// Poor performance observed
				// How much to raise the threshold depends on how confident we are
				const adjustment = confidenceWidth * 0.15; // Scale adjustment by confidence
				minSuccessRate = Math.min(0.9, baseThreshold + adjustment);
			}

			// Compute adaptive minSamples based on sample size.
			// Rationale: small sample sizes provide less reliable estimates and need more
			// confirmation before using learned thresholds. As sample size grows, estimates
			// become more reliable and we can reduce the required confirmation count.
			//
			// Scaling: linear interpolation between MIN_SAMPLES_LOW and MIN_SAMPLES_HIGH
			// based on where combo.total falls within the confidence threshold range.
			let minSamples = MIN_SAMPLES_LOW;

			if (combo.total < CONFIDENCE_LOW_THRESHOLD) {
				// Very small sample - use conservative minimum
				minSamples = MIN_SAMPLES_LOW;
			} else if (combo.total >= CONFIDENCE_HIGH_THRESHOLD) {
				// Large sample - can use aggressive minimum
				minSamples = MIN_SAMPLES_HIGH;
			} else {
				// Medium sample - scale linearly between low and high
				const range = CONFIDENCE_HIGH_THRESHOLD - CONFIDENCE_LOW_THRESHOLD;
				const position = combo.total - CONFIDENCE_LOW_THRESHOLD;
				const fraction = position / range;
				minSamples = Math.round(MIN_SAMPLES_LOW + (MIN_SAMPLES_HIGH - MIN_SAMPLES_LOW) * fraction);
			}

			thresholds[key] = {
				minSuccessRate,
				minSamples,
				skip: shouldSkip,
			};
		}
	}

	// Extract model-level success rates
	const modelSuccessRates: Record<ModelTier, number> = {
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
	// Note: We skip haiku entirely - sonnet requires less steering and has
	// higher first-attempt success rates, making it cheaper overall.
	const defaultModels: Record<ComplexityLevel, ModelTier> = {
		trivial: "sonnet",
		simple: "sonnet",
		standard: "sonnet",
		complex: "sonnet",
		critical: "opus",
	};

	let recommended = defaultModels[complexity];

	// Check if we should skip to a higher tier
	if (shouldSkipModel(profile, recommended, complexity)) {
		// Escalate to opus
		recommended = "opus";
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
				const escalated = "opus";
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
