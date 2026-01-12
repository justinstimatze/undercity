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
	};
}

/**
 * Create empty pattern stats for a pattern
 */
function createEmptyPatternStats(pattern: string): PatternStats {
	return {
		pattern,
		byModel: {
			haiku: createEmptyModelStats(),
			sonnet: createEmptyModelStats(),
			opus: createEmptyModelStats(),
		},
		lastSeen: new Date(),
	};
}

/**
 * Get the ledger file path
 */
function getLedgerPath(stateDir: string = DEFAULT_STATE_DIR): string {
	return join(stateDir, LEDGER_FILE);
}

/**
 * Load the capability ledger from disk
 */
export function loadLedger(stateDir: string = DEFAULT_STATE_DIR): CapabilityLedger {
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
		return JSON.parse(content) as CapabilityLedger;
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
 */
function saveLedger(ledger: CapabilityLedger, stateDir: string = DEFAULT_STATE_DIR): void {
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
 */
export function updateLedger(taskResult: TaskResult, stateDir: string = DEFAULT_STATE_DIR): void {
	const ledger = loadLedger(stateDir);
	const keywords = extractKeywords(taskResult.objective);

	// Update stats for each keyword found
	for (const keyword of keywords) {
		if (!ledger.patterns[keyword]) {
			ledger.patterns[keyword] = createEmptyPatternStats(keyword);
		}

		const patternStats = ledger.patterns[keyword];
		const modelStats = patternStats.byModel[taskResult.model];

		modelStats.attempts++;
		if (taskResult.success) {
			modelStats.successes++;
		}
		if (taskResult.escalated) {
			modelStats.escalations++;
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
 */
export function getRecommendedModel(objective: string, stateDir: string = DEFAULT_STATE_DIR): ModelRecommendation {
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
	const aggregateStats: Record<ModelChoice, { successes: number; attempts: number; escalations: number }> = {
		haiku: { successes: 0, attempts: 0, escalations: 0 },
		sonnet: { successes: 0, attempts: 0, escalations: 0 },
		opus: { successes: 0, attempts: 0, escalations: 0 },
	};

	let matchedPatterns = 0;

	for (const keyword of keywords) {
		const patternStats = ledger.patterns[keyword];
		if (!patternStats) continue;

		matchedPatterns++;
		for (const model of ["haiku", "sonnet", "opus"] as ModelChoice[]) {
			const modelStats = patternStats.byModel[model];
			aggregateStats[model].successes += modelStats.successes;
			aggregateStats[model].attempts += modelStats.attempts;
			aggregateStats[model].escalations += modelStats.escalations;
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
		haiku: {
			successRate: getSuccessRate(aggregateStats.haiku),
			escalationRate: getEscalationRate(aggregateStats.haiku),
			attempts: aggregateStats.haiku.attempts,
		},
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

	// Decision logic:
	// 1. If haiku has high success rate (>80%) and low escalation (<20%), use haiku
	// 2. If sonnet has high success rate (>80%) and low escalation (<20%), use sonnet
	// 3. Otherwise, recommend opus

	const haikuViable =
		patternRates.haiku.attempts >= 3 &&
		patternRates.haiku.successRate >= 0.8 &&
		patternRates.haiku.escalationRate < 0.2;

	const sonnetViable =
		patternRates.sonnet.attempts >= 3 &&
		patternRates.sonnet.successRate >= 0.8 &&
		patternRates.sonnet.escalationRate < 0.2;

	// Check for high escalation from lower tiers (suggests task is harder than model tier)
	const haikuEscalationHigh = patternRates.haiku.attempts >= 3 && patternRates.haiku.escalationRate >= 0.3;
	const sonnetEscalationHigh = patternRates.sonnet.attempts >= 3 && patternRates.sonnet.escalationRate >= 0.3;

	// Determine recommendation
	let model: ModelChoice;
	let reason: string;
	let confidence: number;

	if (haikuViable && !haikuEscalationHigh) {
		model = "haiku";
		reason = `Haiku succeeds ${(patternRates.haiku.successRate * 100).toFixed(0)}% for similar patterns`;
		confidence = Math.min(0.9, patternRates.haiku.successRate);
	} else if (sonnetViable && !sonnetEscalationHigh) {
		model = "sonnet";
		reason = `Sonnet succeeds ${(patternRates.sonnet.successRate * 100).toFixed(0)}% for similar patterns`;
		confidence = Math.min(0.9, patternRates.sonnet.successRate);
	} else if (haikuEscalationHigh || sonnetEscalationHigh) {
		model = "opus";
		reason = "High escalation rate from lower tiers for similar patterns";
		confidence = 0.7;
	} else if (patternRates.opus.attempts > 0 && patternRates.opus.successRate > 0.5) {
		model = "opus";
		reason = `Similar patterns typically require opus (${(patternRates.opus.successRate * 100).toFixed(0)}% success)`;
		confidence = Math.min(0.85, patternRates.opus.successRate);
	} else {
		// Default to sonnet when data is inconclusive
		model = "sonnet";
		reason = "Insufficient conclusive data - defaulting to sonnet";
		confidence = 0.4;
	}

	return {
		model,
		confidence,
		reason,
		patternRates,
	};
}

/**
 * Get ledger statistics for reporting
 */
export function getLedgerStats(stateDir: string = DEFAULT_STATE_DIR): {
	totalEntries: number;
	patternCount: number;
	topPatterns: Array<{ pattern: string; attempts: number }>;
	modelDistribution: Record<ModelChoice, number>;
} {
	const ledger = loadLedger(stateDir);

	const patternList = Object.values(ledger.patterns);
	const modelDistribution: Record<ModelChoice, number> = {
		haiku: 0,
		sonnet: 0,
		opus: 0,
	};

	// Calculate total attempts per model across all patterns
	for (const pattern of patternList) {
		for (const model of ["haiku", "sonnet", "opus"] as ModelChoice[]) {
			modelDistribution[model] += pattern.byModel[model].attempts;
		}
	}

	// Get top patterns by total attempts
	const topPatterns = patternList
		.map((p) => ({
			pattern: p.pattern,
			attempts: p.byModel.haiku.attempts + p.byModel.sonnet.attempts + p.byModel.opus.attempts,
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
