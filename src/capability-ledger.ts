/**
 * Capability Ledger Module
 *
 * Tracks keyword patterns from task objectives and their success rates per model tier.
 * Used to recommend models based on historical performance patterns.
 *
 * State stored in: .undercity/capability-ledger.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelChoice } from "./types.js";

const DEFAULT_STATE_DIR = ".undercity";
const LEDGER_FILE = "capability-ledger.json";

/**
 * Input for updating the ledger after task completion
 */
export interface TaskResult {
	/** The task objective/description */
	objective: string;
	/** Model that executed the task */
	model: ModelChoice;
	/** Whether the task succeeded */
	success: boolean;
	/** Whether the task was escalated to a higher tier */
	escalated: boolean;
	/** Total tokens used (input + output) */
	tokenCost?: number;
	/** Total duration in milliseconds */
	durationMs?: number;
	/** Number of attempts (retries + initial) */
	attempts?: number;
}

/**
 * Statistics for a keyword pattern per model
 */
export interface PatternModelStats {
	/** Total attempts with this pattern */
	attempts: number;
	/** Successful completions */
	successes: number;
	/** Tasks that required escalation */
	escalations: number;
	/** Total tokens used across all tasks */
	totalTokens: number;
	/** Total duration in ms across all tasks */
	totalDurationMs: number;
	/** Sum of attempt counts (for averaging) */
	totalRetries: number;
}

/**
 * Statistics for a keyword pattern across all models
 */
export interface PatternStats {
	/** The keyword pattern */
	pattern: string;
	/** Stats per model tier */
	byModel: Record<ModelChoice, PatternModelStats>;
	/** Last time this pattern was seen */
	lastSeen: Date;
}

/**
 * The full ledger state
 */
export interface CapabilityLedger {
	/** Pattern statistics keyed by pattern string */
	patterns: Record<string, PatternStats>;
	/** Total entries recorded */
	totalEntries: number;
	/** Version for future migrations */
	version: string;
	/** Last updated timestamp */
	lastUpdated: Date;
}

/**
 * Common action keywords to extract from objectives
 */
const ACTION_PATTERNS = [
	"add",
	"fix",
	"refactor",
	"update",
	"remove",
	"delete",
	"create",
	"implement",
	"modify",
	"change",
	"migrate",
	"upgrade",
	"optimize",
	"improve",
	"simplify",
	"extract",
	"rename",
	"move",
	"test",
	"document",
	"configure",
	"setup",
	"clean",
	"format",
	"lint",
	"type",
	"build",
	"deploy",
	"debug",
	"investigate",
];

/**
 * Extract keywords from an objective string
 */
function extractKeywords(objective: string): string[] {
	const words = objective.toLowerCase().split(/\s+/);
	const keywords: string[] = [];

	for (const word of words) {
		// Clean punctuation
		const cleaned = word.replace(/[^a-z]/g, "");
		if (cleaned && ACTION_PATTERNS.includes(cleaned)) {
			keywords.push(cleaned);
		}
	}

	// Deduplicate
	return [...new Set(keywords)];
}

/**
 * Create empty model stats
 */
function createEmptyModelStats(): PatternModelStats {
	return {
		attempts: 0,
		successes: 0,
		escalations: 0,
		totalTokens: 0,
		totalDurationMs: 0,
		totalRetries: 0,
	};
}

/**
 * Create empty pattern stats for a pattern
 */
function createEmptyPatternStats(pattern: string): PatternStats {
	return {
		pattern,
		byModel: {
			sonnet: createEmptyModelStats(),
			opus: createEmptyModelStats(),
		},
		lastSeen: new Date(),
	};
}

/**
 * Type guard to validate PatternModelStats structure
 *
 * Validates all required numeric fields are present and non-negative.
 * Optional fields (totalTokens, totalDurationMs, totalRetries) are validated if present,
 * allowing for backward compatibility with older ledger formats.
 *
 * @param value - The value to validate
 * @returns True if value is a valid PatternModelStats object
 * @example
 * const stats = { attempts: 5, successes: 4, escalations: 1, totalTokens: 1000, totalDurationMs: 5000, totalRetries: 6 };
 * if (isPatternModelStats(stats)) {
 *   console.log(`Success rate: ${stats.successes / stats.attempts}`);
 * }
 */
export function isPatternModelStats(value: unknown): value is PatternModelStats {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Validate required core fields
	if (
		typeof obj.attempts !== "number" ||
		obj.attempts < 0 ||
		typeof obj.successes !== "number" ||
		obj.successes < 0 ||
		typeof obj.escalations !== "number" ||
		obj.escalations < 0
	) {
		return false;
	}

	// Validate optional fields only if present (for backward compatibility)
	if (obj.totalTokens !== undefined && (typeof obj.totalTokens !== "number" || obj.totalTokens < 0)) {
		return false;
	}

	if (obj.totalDurationMs !== undefined && (typeof obj.totalDurationMs !== "number" || obj.totalDurationMs < 0)) {
		return false;
	}

	if (obj.totalRetries !== undefined && (typeof obj.totalRetries !== "number" || obj.totalRetries < 0)) {
		return false;
	}

	return true;
}

/**
 * Type guard to validate PatternStats structure
 *
 * Validates pattern string, model stats, and lastSeen date.
 *
 * @param value - The value to validate
 * @returns True if value is a valid PatternStats object
 * @example
 * const stats = {
 *   pattern: "fix",
 *   byModel: { sonnet: {...}, opus: {...} },
 *   lastSeen: new Date()
 * };
 * if (isPatternStats(stats)) {
 *   console.log(`Pattern: ${stats.pattern}`);
 * }
 */
export function isPatternStats(value: unknown): value is PatternStats {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Validate pattern is non-empty string
	if (typeof obj.pattern !== "string" || obj.pattern.length === 0) {
		return false;
	}

	// Validate byModel is an object with valid ModelChoice keys
	if (typeof obj.byModel !== "object" || obj.byModel === null) {
		return false;
	}

	const byModel = obj.byModel as Record<string, unknown>;

	// Check both sonnet and opus exist and are valid
	if (!isPatternModelStats(byModel.sonnet) || !isPatternModelStats(byModel.opus)) {
		return false;
	}

	// Validate lastSeen is a valid Date (can be Date object or ISO string)
	if (obj.lastSeen instanceof Date) {
		return !Number.isNaN(obj.lastSeen.getTime());
	}
	if (typeof obj.lastSeen === "string") {
		const date = new Date(obj.lastSeen);
		return !Number.isNaN(date.getTime());
	}

	return false;
}

/**
 * Type guard to validate CapabilityLedger structure
 *
 * Validates all ledger fields including nested pattern stats.
 *
 * @param value - The value to validate
 * @returns True if value is a valid CapabilityLedger object
 * @example
 * const ledger = loadLedgerData();
 * if (isCapabilityLedger(ledger)) {
 *   console.log(`Total entries: ${ledger.totalEntries}`);
 * }
 */
export function isCapabilityLedger(value: unknown): value is CapabilityLedger {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Validate patterns object
	if (typeof obj.patterns !== "object" || obj.patterns === null) {
		return false;
	}

	const patterns = obj.patterns as Record<string, unknown>;
	for (const key in patterns) {
		if (!isPatternStats(patterns[key])) {
			return false;
		}
	}

	// Validate totalEntries is non-negative number
	if (typeof obj.totalEntries !== "number" || obj.totalEntries < 0) {
		return false;
	}

	// Validate version is non-empty string
	if (typeof obj.version !== "string" || obj.version.length === 0) {
		return false;
	}

	// Validate lastUpdated is a valid Date (can be Date object or ISO string)
	if (obj.lastUpdated instanceof Date) {
		return !Number.isNaN(obj.lastUpdated.getTime());
	}
	if (typeof obj.lastUpdated === "string") {
		const date = new Date(obj.lastUpdated);
		return !Number.isNaN(date.getTime());
	}

	return false;
}

/**
 * Type guard to validate TaskResult structure
 *
 * Validates required fields and optional metric fields.
 *
 * @param value - The value to validate
 * @returns True if value is a valid TaskResult object
 * @example
 * const result = { objective: "fix bug", model: "sonnet", success: true, escalated: false };
 * if (isTaskResult(result)) {
 *   updateLedger(result);
 * }
 */
export function isTaskResult(value: unknown): value is TaskResult {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Validate required fields
	if (typeof obj.objective !== "string") {
		return false;
	}

	// Validate model is valid ModelChoice
	if (obj.model !== "sonnet" && obj.model !== "opus") {
		return false;
	}

	if (typeof obj.success !== "boolean") {
		return false;
	}

	if (typeof obj.escalated !== "boolean") {
		return false;
	}

	// Validate optional fields if present
	if (obj.tokenCost !== undefined && (typeof obj.tokenCost !== "number" || obj.tokenCost < 0)) {
		return false;
	}

	if (obj.durationMs !== undefined && (typeof obj.durationMs !== "number" || obj.durationMs < 0)) {
		return false;
	}

	if (obj.attempts !== undefined && (typeof obj.attempts !== "number" || obj.attempts < 0)) {
		return false;
	}

	return true;
}

/**
 * Type guard to validate ModelCostMetrics structure
 *
 * Validates all numeric metric fields with appropriate ranges.
 *
 * @param value - The value to validate
 * @returns True if value is a valid ModelCostMetrics object
 * @example
 * const metrics = {
 *   successRate: 0.85,
 *   escalationRate: 0.15,
 *   attempts: 10,
 *   avgTokens: 1200,
 *   avgDurationMs: 5000,
 *   avgRetries: 1.2,
 *   expectedValue: 0.5
 * };
 * if (isModelCostMetrics(metrics)) {
 *   console.log(`Expected value: ${metrics.expectedValue}`);
 * }
 */
export function isModelCostMetrics(value: unknown): value is ModelCostMetrics {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	return (
		typeof obj.successRate === "number" &&
		obj.successRate >= 0 &&
		obj.successRate <= 1 &&
		typeof obj.escalationRate === "number" &&
		obj.escalationRate >= 0 &&
		obj.escalationRate <= 1 &&
		typeof obj.attempts === "number" &&
		obj.attempts >= 0 &&
		typeof obj.avgTokens === "number" &&
		obj.avgTokens >= 0 &&
		typeof obj.avgDurationMs === "number" &&
		obj.avgDurationMs >= 0 &&
		typeof obj.avgRetries === "number" &&
		obj.avgRetries >= 0 &&
		typeof obj.expectedValue === "number" &&
		obj.expectedValue >= 0
	);
}

/**
 * Type guard to validate ModelRecommendation structure
 *
 * Validates recommendation fields including optional pattern rates and cost metrics.
 *
 * @param value - The value to validate
 * @returns True if value is a valid ModelRecommendation object
 * @example
 * const rec = getRecommendedModel("fix bug");
 * if (isModelRecommendation(rec)) {
 *   console.log(`Recommended: ${rec.model} (${rec.confidence * 100}% confidence)`);
 * }
 */
export function isModelRecommendation(value: unknown): value is ModelRecommendation {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Validate required fields
	if (obj.model !== "sonnet" && obj.model !== "opus") {
		return false;
	}

	if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
		return false;
	}

	if (typeof obj.reason !== "string" || obj.reason.length === 0) {
		return false;
	}

	// Validate optional patternRates if present
	if (obj.patternRates !== undefined) {
		if (typeof obj.patternRates !== "object" || obj.patternRates === null) {
			return false;
		}

		const rates = obj.patternRates as Record<string, unknown>;
		for (const model of ["sonnet", "opus"]) {
			const modelRate = rates[model];
			if (typeof modelRate !== "object" || modelRate === null) {
				return false;
			}

			const rate = modelRate as Record<string, unknown>;
			if (
				typeof rate.successRate !== "number" ||
				rate.successRate < 0 ||
				rate.successRate > 1 ||
				typeof rate.escalationRate !== "number" ||
				rate.escalationRate < 0 ||
				rate.escalationRate > 1 ||
				typeof rate.attempts !== "number" ||
				rate.attempts < 0
			) {
				return false;
			}
		}
	}

	// Validate optional costMetrics if present
	if (obj.costMetrics !== undefined) {
		if (typeof obj.costMetrics !== "object" || obj.costMetrics === null) {
			return false;
		}

		const metrics = obj.costMetrics as Record<string, unknown>;
		for (const model of ["sonnet", "opus"]) {
			if (metrics[model] !== undefined && !isModelCostMetrics(metrics[model])) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Get the ledger file path
 */
function getLedgerPath(stateDir: string = DEFAULT_STATE_DIR): string {
	return join(stateDir, LEDGER_FILE);
}

/**
 * Load the capability ledger from disk
 *
 * @param stateDir - Directory for state files (default: .undercity)
 * @returns The capability ledger
 * @throws {TypeError} If stateDir is not a string
 */
export function loadLedger(stateDir: string = DEFAULT_STATE_DIR): CapabilityLedger {
	// Validate stateDir parameter
	if (typeof stateDir !== "string") {
		throw new TypeError(`Invalid stateDir parameter: expected string, got ${typeof stateDir}`);
	}

	const path = getLedgerPath(stateDir);

	if (!existsSync(path)) {
		return {
			patterns: {},
			totalEntries: 0,
			version: "1.0",
			lastUpdated: new Date(),
		};
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		// Validate the parsed data before returning
		if (!isCapabilityLedger(parsed)) {
			return {
				patterns: {},
				totalEntries: 0,
				version: "1.0",
				lastUpdated: new Date(),
			};
		}

		return parsed;
	} catch {
		return {
			patterns: {},
			totalEntries: 0,
			version: "1.0",
			lastUpdated: new Date(),
		};
	}
}

/**
 * Save the capability ledger to disk
 *
 * @param ledger - The ledger to save
 * @param stateDir - Directory for state files (default: .undercity)
 * @throws {TypeError} If ledger is not a valid CapabilityLedger or stateDir is not a string
 */
function saveLedger(ledger: CapabilityLedger, stateDir: string = DEFAULT_STATE_DIR): void {
	// Validate ledger parameter
	if (!isCapabilityLedger(ledger)) {
		throw new TypeError("Invalid ledger parameter: must be a valid CapabilityLedger object");
	}

	// Validate stateDir parameter
	if (typeof stateDir !== "string") {
		throw new TypeError(`Invalid stateDir parameter: expected string, got ${typeof stateDir}`);
	}

	const path = getLedgerPath(stateDir);
	const tempPath = `${path}.tmp`;
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	ledger.lastUpdated = new Date();

	try {
		writeFileSync(tempPath, JSON.stringify(ledger, null, 2), {
			encoding: "utf-8",
			flag: "w",
		});
		renameSync(tempPath, path);
	} catch (error) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		throw error;
	}
}

/**
 * Update the ledger with a task result
 *
 * Extracts keywords from the objective and updates success rates per model.
 *
 * @param taskResult - The task result to record
 * @param stateDir - Directory for state files (default: .undercity)
 * @throws {TypeError} If taskResult is not a valid TaskResult or stateDir is not a string
 */
export function updateLedger(taskResult: TaskResult, stateDir: string = DEFAULT_STATE_DIR): void {
	// Validate taskResult parameter
	if (!isTaskResult(taskResult)) {
		throw new TypeError(
			"Invalid taskResult parameter: must be a valid TaskResult object with objective, model, success, and escalated fields",
		);
	}

	// Validate stateDir parameter
	if (typeof stateDir !== "string") {
		throw new TypeError(`Invalid stateDir parameter: expected string, got ${typeof stateDir}`);
	}

	const ledger = loadLedger(stateDir);
	const keywords = extractKeywords(taskResult.objective);

	// Update stats for each keyword found
	for (const keyword of keywords) {
		if (!ledger.patterns[keyword]) {
			ledger.patterns[keyword] = createEmptyPatternStats(keyword);
		}

		const patternStats = ledger.patterns[keyword];
		const modelStats = patternStats.byModel[taskResult.model];

		// Ensure new fields exist (migration for old ledgers)
		modelStats.totalTokens ??= 0;
		modelStats.totalDurationMs ??= 0;
		modelStats.totalRetries ??= 0;

		modelStats.attempts++;
		if (taskResult.success) {
			modelStats.successes++;
		}
		if (taskResult.escalated) {
			modelStats.escalations++;
		}

		// Record cost metrics
		if (taskResult.tokenCost !== undefined) {
			modelStats.totalTokens += taskResult.tokenCost;
		}
		if (taskResult.durationMs !== undefined) {
			modelStats.totalDurationMs += taskResult.durationMs;
		}
		if (taskResult.attempts !== undefined) {
			modelStats.totalRetries += taskResult.attempts;
		}

		patternStats.lastSeen = new Date();
	}

	ledger.totalEntries++;
	saveLedger(ledger, stateDir);
}

/**
 * Calculate success rate for a pattern on a specific model
 */
function getSuccessRate(stats: PatternModelStats): number {
	if (stats.attempts === 0) return 0;
	return stats.successes / stats.attempts;
}

/**
 * Calculate escalation rate for a pattern on a specific model
 */
function getEscalationRate(stats: PatternModelStats): number {
	if (stats.attempts === 0) return 0;
	return stats.escalations / stats.attempts;
}

/**
 * Cost metrics for a model
 */
export interface ModelCostMetrics {
	successRate: number;
	escalationRate: number;
	attempts: number;
	avgTokens: number;
	avgDurationMs: number;
	avgRetries: number;
	/** Expected value score (higher = better ROI) */
	expectedValue: number;
}

/**
 * Recommendation result from getRecommendedModel
 */
export interface ModelRecommendation {
	/** Recommended model */
	model: ModelChoice;
	/** Confidence in the recommendation (0-1) */
	confidence: number;
	/** Reasoning for the recommendation */
	reason: string;
	/** Success rates by model for the matched patterns */
	patternRates?: Record<ModelChoice, { successRate: number; escalationRate: number; attempts: number }>;
	/** Cost metrics by model (when available) */
	costMetrics?: Record<ModelChoice, ModelCostMetrics>;
}

/**
 * Get recommended model based on historical pattern performance
 *
 * Analyzes keywords in the objective against historical success rates.
 * Higher escalation rates for a model suggest using a higher tier.
 *
 * @param objective - The task objective to analyze
 * @param stateDir - Directory for state files (default: .undercity)
 * @returns Model recommendation with confidence and reasoning
 * @throws {TypeError} If objective is not a non-empty string or stateDir is not a string
 */
export function getRecommendedModel(objective: string, stateDir: string = DEFAULT_STATE_DIR): ModelRecommendation {
	// Validate objective parameter
	if (typeof objective !== "string") {
		throw new TypeError(`Invalid objective parameter: expected string, got ${typeof objective}`);
	}

	// Validate stateDir parameter
	if (typeof stateDir !== "string") {
		throw new TypeError(`Invalid stateDir parameter: expected string, got ${typeof stateDir}`);
	}

	const ledger = loadLedger(stateDir);
	const keywords = extractKeywords(objective);

	// Default recommendation when no data
	if (keywords.length === 0 || ledger.totalEntries < 5) {
		return {
			model: "sonnet",
			confidence: 0.3,
			reason: "Insufficient data - defaulting to sonnet",
		};
	}

	// Aggregate stats across all matching patterns
	const aggregateStats: Record<
		ModelChoice,
		{
			successes: number;
			attempts: number;
			escalations: number;
			totalTokens: number;
			totalDurationMs: number;
			totalRetries: number;
		}
	> = {
		sonnet: { successes: 0, attempts: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
		opus: { successes: 0, attempts: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
	};

	let matchedPatterns = 0;

	for (const keyword of keywords) {
		const patternStats = ledger.patterns[keyword];
		if (!patternStats) continue;

		matchedPatterns++;
		for (const model of ["sonnet", "opus"] as ModelChoice[]) {
			const modelStats = patternStats.byModel[model];
			aggregateStats[model].successes += modelStats.successes;
			aggregateStats[model].attempts += modelStats.attempts;
			aggregateStats[model].escalations += modelStats.escalations;
			aggregateStats[model].totalTokens += modelStats.totalTokens ?? 0;
			aggregateStats[model].totalDurationMs += modelStats.totalDurationMs ?? 0;
			aggregateStats[model].totalRetries += modelStats.totalRetries ?? 0;
		}
	}

	if (matchedPatterns === 0) {
		return {
			model: "sonnet",
			confidence: 0.3,
			reason: "No matching patterns found - defaulting to sonnet",
		};
	}

	// Calculate rates per model
	const patternRates: Record<ModelChoice, { successRate: number; escalationRate: number; attempts: number }> = {
		sonnet: {
			successRate: getSuccessRate(aggregateStats.sonnet),
			escalationRate: getEscalationRate(aggregateStats.sonnet),
			attempts: aggregateStats.sonnet.attempts,
		},
		opus: {
			successRate: getSuccessRate(aggregateStats.opus),
			escalationRate: getEscalationRate(aggregateStats.opus),
			attempts: aggregateStats.opus.attempts,
		},
	};

	// Relative cost multipliers (sonnet = 1, opus = 10)
	const COST_MULTIPLIER: Record<ModelChoice, number> = {
		sonnet: 1,
		opus: 10,
	};

	// Calculate cost metrics and expected value per model
	const costMetrics: Record<ModelChoice, ModelCostMetrics> = {} as Record<ModelChoice, ModelCostMetrics>;
	for (const model of ["sonnet", "opus"] as ModelChoice[]) {
		const stats = aggregateStats[model];
		const successRate = getSuccessRate(stats);
		const escalationRate = getEscalationRate(stats);
		const avgTokens = stats.attempts > 0 ? stats.totalTokens / stats.attempts : 0;
		const avgDurationMs = stats.attempts > 0 ? stats.totalDurationMs / stats.attempts : 0;
		const avgRetries = stats.attempts > 0 ? stats.totalRetries / stats.attempts : 1;

		// Expected value = success probability / (cost × avg retries)
		// Higher = better ROI (more likely to succeed per dollar spent)
		const costFactor = COST_MULTIPLIER[model] * Math.max(1, avgRetries);
		const expectedValue = stats.attempts >= 3 ? successRate / costFactor : 0;

		costMetrics[model] = {
			successRate,
			escalationRate,
			attempts: stats.attempts,
			avgTokens,
			avgDurationMs,
			avgRetries,
			expectedValue,
		};
	}

	// Find best model by expected value (with minimum data threshold)
	let bestModel: ModelChoice = "sonnet";
	let bestValue = -1;
	let usedExpectedValue = false;

	for (const model of ["sonnet", "opus"] as ModelChoice[]) {
		const metrics = costMetrics[model];
		// Require minimum 3 attempts and 60% success rate
		if (metrics.attempts >= 3 && metrics.successRate >= 0.6 && metrics.expectedValue > bestValue) {
			bestValue = metrics.expectedValue;
			bestModel = model;
			usedExpectedValue = true;
		}
	}

	// Fallback to original logic if no model has enough data for expected value
	let model: ModelChoice;
	let reason: string;
	let confidence: number;

	if (usedExpectedValue) {
		model = bestModel;
		const metrics = costMetrics[model];
		reason = `Best ROI: ${model} (${(metrics.successRate * 100).toFixed(0)}% success, ${metrics.avgRetries.toFixed(1)} avg retries)`;
		confidence = Math.min(0.9, metrics.successRate);
	} else {
		// Fallback logic
		const sonnetViable =
			patternRates.sonnet.attempts >= 3 &&
			patternRates.sonnet.successRate >= 0.8 &&
			patternRates.sonnet.escalationRate < 0.2;

		const sonnetEscalationHigh = patternRates.sonnet.attempts >= 3 && patternRates.sonnet.escalationRate >= 0.3;

		if (sonnetViable && !sonnetEscalationHigh) {
			model = "sonnet";
			reason = `Sonnet succeeds ${(patternRates.sonnet.successRate * 100).toFixed(0)}% for similar patterns`;
			confidence = Math.min(0.9, patternRates.sonnet.successRate);
		} else if (sonnetEscalationHigh) {
			model = "opus";
			reason = "High escalation rate from sonnet for similar patterns";
			confidence = 0.7;
		} else if (patternRates.opus.attempts > 0 && patternRates.opus.successRate > 0.5) {
			model = "opus";
			reason = `Similar patterns typically require opus (${(patternRates.opus.successRate * 100).toFixed(0)}% success)`;
			confidence = Math.min(0.85, patternRates.opus.successRate);
		} else {
			model = "sonnet";
			reason = "Insufficient conclusive data - defaulting to sonnet";
			confidence = 0.4;
		}
	}

	return {
		model,
		confidence,
		reason,
		patternRates,
		costMetrics,
	};
}

/**
 * Get ledger statistics for reporting
 *
 * @param stateDir - Directory for state files (default: .undercity)
 * @returns Statistics about the ledger
 * @throws {TypeError} If stateDir is not a string
 */
export function getLedgerStats(stateDir: string = DEFAULT_STATE_DIR): {
	totalEntries: number;
	patternCount: number;
	topPatterns: Array<{ pattern: string; attempts: number }>;
	modelDistribution: Record<ModelChoice, number>;
} {
	// Validate stateDir parameter
	if (typeof stateDir !== "string") {
		throw new TypeError(`Invalid stateDir parameter: expected string, got ${typeof stateDir}`);
	}

	const ledger = loadLedger(stateDir);

	const patternList = Object.values(ledger.patterns);
	const modelDistribution: Record<ModelChoice, number> = {
		sonnet: 0,
		opus: 0,
	};

	// Calculate total attempts per model across all patterns
	for (const pattern of patternList) {
		for (const model of ["sonnet", "opus"] as ModelChoice[]) {
			modelDistribution[model] += pattern.byModel[model].attempts;
		}
	}

	// Get top patterns by total attempts
	const topPatterns = patternList
		.map((p) => ({
			pattern: p.pattern,
			attempts: p.byModel.sonnet.attempts + p.byModel.opus.attempts,
		}))
		.sort((a, b) => b.attempts - a.attempts)
		.slice(0, 10);

	return {
		totalEntries: ledger.totalEntries,
		patternCount: patternList.length,
		topPatterns,
		modelDistribution,
	};
}
