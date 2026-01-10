/**
 * Loadout Scoring System
 *
 * Tracks and rates different loadout configurations based on efficiency metrics.
 * Helps determine which loadouts work best for which quest types.
 */

import { persistenceLogger } from "./logger.js";
import type { Quest } from "./quest.js";
import type {
	EfficiencyMetrics,
	LoadoutConfiguration,
	LoadoutPerformance,
	LoadoutRecommendation,
	LoadoutScore,
	ModelChoice,
	QuestType,
	Raid,
} from "./types.js";

/**
 * Default loadout configurations for different scenarios
 */
export const DEFAULT_LOADOUTS: LoadoutConfiguration[] = [
	{
		id: "speed-demon",
		name: "Speed Demon",
		description: "Fastest execution with Haiku for all non-critical raiders",
		maxSquadSize: 3,
		enabledAgentTypes: ["flute", "quester", "sheriff"],
		modelChoices: {
			flute: "haiku",
			logistics: "haiku",
			quester: "haiku",
			sheriff: "sonnet",
		},
		contextSize: "small",
		parallelismLevel: "maximum",
		autoApprove: true,
		lastUpdated: new Date(),
	},
	{
		id: "balanced-performer",
		name: "Balanced Performer",
		description: "Good balance of speed, quality, and cost",
		maxSquadSize: 4,
		enabledAgentTypes: ["flute", "logistics", "quester", "sheriff"],
		modelChoices: {
			flute: "haiku",
			logistics: "sonnet",
			quester: "sonnet",
			sheriff: "sonnet",
		},
		contextSize: "medium",
		parallelismLevel: "limited",
		autoApprove: false,
		lastUpdated: new Date(),
	},
	{
		id: "quality-focused",
		name: "Quality Focused",
		description: "Maximum quality with Opus for critical review",
		maxSquadSize: 4,
		enabledAgentTypes: ["flute", "logistics", "quester", "sheriff"],
		modelChoices: {
			flute: "haiku",
			logistics: "sonnet",
			quester: "sonnet",
			sheriff: "opus",
		},
		contextSize: "large",
		parallelismLevel: "sequential",
		autoApprove: false,
		lastUpdated: new Date(),
	},
	{
		id: "debug-specialist",
		name: "Debug Specialist",
		description: "Optimized for bug hunting and problem investigation",
		maxSquadSize: 3,
		enabledAgentTypes: ["flute", "quester", "sheriff"],
		modelChoices: {
			flute: "sonnet",
			logistics: "sonnet",
			quester: "sonnet",
			sheriff: "opus",
		},
		contextSize: "large",
		parallelismLevel: "limited",
		autoApprove: false,
		lastUpdated: new Date(),
	},
	{
		id: "research-mode",
		name: "Research Mode",
		description: "Thorough analysis and exploration of complex codebases",
		maxSquadSize: 2,
		enabledAgentTypes: ["flute", "logistics"],
		modelChoices: {
			flute: "sonnet",
			logistics: "opus",
			quester: "sonnet",
			sheriff: "opus",
		},
		contextSize: "large",
		parallelismLevel: "sequential",
		autoApprove: false,
		lastUpdated: new Date(),
	},
];

/**
 * Generate a unique ID for loadout performance tracking
 */
export function generatePerformanceId(): string {
	return `perf-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

/**
 * Generate a unique ID for loadout configurations
 */
export function generateLoadoutId(): string {
	return `loadout-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

/**
 * Classify a quest objective into a quest type using heuristics
 */
export function classifyQuestType(questObjective: string): QuestType {
	const objective = questObjective.toLowerCase();

	// More specific patterns first to avoid conflicts

	// Test patterns (check before feature patterns that might include "add")
	if (
		objective.includes("unit test") ||
		objective.includes("integration test") ||
		objective.includes("test coverage") ||
		objective.includes("write tests") ||
		(objective.includes("test") && !objective.includes("test drive")) ||
		objective.includes("coverage") ||
		(objective.includes("spec") && !objective.includes("specification"))
	) {
		return "test";
	}

	// Documentation patterns (check before feature patterns)
	if (
		objective.includes("document") ||
		objective.includes("docs") ||
		objective.includes("readme") ||
		objective.includes("comment") ||
		objective.includes("explain") ||
		objective.includes("write docs") ||
		objective.includes("add comments")
	) {
		return "documentation";
	}

	// Security patterns (check before debug patterns that might include "fix")
	if (
		objective.includes("security") ||
		objective.includes("vulnerability") ||
		objective.includes("permission") ||
		objective.includes("secure") ||
		(objective.includes("auth") &&
			!objective.includes("authentication") &&
			!objective.includes("authorize") &&
			!objective.includes("author")) ||
		objective.includes("encrypt") ||
		objective.includes("ssl") ||
		objective.includes("https")
	) {
		return "security";
	}

	// Research patterns (check before performance patterns)
	if (
		objective.includes("research") ||
		objective.includes("investigate") ||
		objective.includes("analyze") ||
		objective.includes("study") ||
		objective.includes("explore") ||
		objective.includes("survey") ||
		(objective.includes("understand") && !objective.includes("user"))
	) {
		return "research";
	}

	// Performance patterns
	if (
		objective.includes("optimize") ||
		objective.includes("performance") ||
		objective.includes("speed") ||
		objective.includes("memory") ||
		objective.includes("efficiency") ||
		objective.includes("bottleneck") ||
		objective.includes("cache") ||
		objective.includes("fast")
	) {
		return "performance";
	}

	// Debug patterns
	if (
		objective.includes("bug") ||
		objective.includes("error") ||
		objective.includes("crash") ||
		objective.includes("issue") ||
		objective.includes("debug") ||
		(objective.includes("fix") && !objective.includes("fixing feature")) ||
		objective.includes("broken") ||
		objective.includes("failing")
	) {
		return "debug";
	}

	// Refactor patterns
	if (
		objective.includes("refactor") ||
		objective.includes("restructure") ||
		objective.includes("reorganize") ||
		objective.includes("clean up") ||
		objective.includes("improve structure") ||
		objective.includes("simplify") ||
		objective.includes("modernize")
	) {
		return "refactor";
	}

	// Feature patterns (most general, checked last)
	if (
		objective.includes("add") ||
		objective.includes("implement") ||
		objective.includes("create") ||
		objective.includes("build") ||
		objective.includes("new feature") ||
		objective.includes("feature") ||
		objective.includes("develop") ||
		objective.includes("introduce")
	) {
		return "feature";
	}

	// Default to feature if unclear
	return "feature";
}

/**
 * Estimate quest complexity based on objective text
 */
export function estimateQuestComplexity(questObjective: string): number {
	const objective = questObjective.toLowerCase();
	let complexity = 5; // Base complexity

	// Increase complexity for certain keywords
	if (objective.includes("refactor") || objective.includes("restructure")) complexity += 2;
	if (objective.includes("security") || objective.includes("performance")) complexity += 2;
	if (objective.includes("integration") || objective.includes("database")) complexity += 1;
	if (objective.includes("api") || objective.includes("architecture")) complexity += 1;
	if (objective.includes("multiple") || objective.includes("several")) complexity += 1;

	// Decrease complexity for simple tasks
	if (objective.includes("simple") || objective.includes("small")) complexity -= 1;
	if (objective.includes("typo") || objective.includes("comment")) complexity -= 2;
	if (objective.includes("one line") || objective.includes("quick")) complexity -= 2;

	// Estimate based on length (longer descriptions often indicate complexity)
	if (objective.length > 100) complexity += 1;
	if (objective.length > 200) complexity += 1;

	return Math.max(1, Math.min(10, complexity));
}

/**
 * Calculate model costs per 1M tokens (approximate pricing in cents)
 */
const MODEL_COSTS = {
	haiku: { input: 25, output: 125 }, // $0.25 input, $1.25 output per 1M tokens
	sonnet: { input: 300, output: 1500 }, // $3 input, $15 output per 1M tokens
	opus: { input: 1500, output: 7500 }, // $15 input, $75 output per 1M tokens
};

/**
 * Estimate cost for a loadout configuration
 */
export function estimateCost(tokensUsed: number, modelChoice: ModelChoice, isInput: boolean = true): number {
	const costs = MODEL_COSTS[modelChoice];
	const rate = isInput ? costs.input : costs.output;
	return (tokensUsed / 1000000) * rate; // Convert to cost in cents
}

/**
 * Calculate a composite score for loadout performance
 */
export function calculateCompositeScore(metrics: EfficiencyMetrics): number {
	// Normalize metrics to 0-100 scale
	const timeScore = Math.max(0, 100 - Math.min(100, metrics.timeToComplete / 60000)); // 60 seconds = 0 points
	const costScore = Math.max(0, 100 - Math.min(100, metrics.costInCents * 10)); // $0.10 = 0 points
	const qualityScore = metrics.qualityScore; // Already 0-100
	const retryScore = Math.max(0, 100 - metrics.retryCount * 25); // Each retry = -25 points
	const successScore = metrics.success ? 100 : 0;

	// Weighted composite score
	const weights = {
		time: 0.2,
		cost: 0.15,
		quality: 0.35,
		retry: 0.15,
		success: 0.15,
	};

	return (
		timeScore * weights.time +
		costScore * weights.cost +
		qualityScore * weights.quality +
		retryScore * weights.retry +
		successScore * weights.success
	);
}

/**
 * Record performance data for a loadout on a quest
 */
export function recordLoadoutPerformance(
	loadoutConfig: LoadoutConfiguration,
	quest: Quest,
	raid: Raid,
	metrics: EfficiencyMetrics,
	agentMetrics?: Record<string, { tokensUsed: number; timeSpent: number; taskSuccess: boolean }>,
): LoadoutPerformance {
	const questType = classifyQuestType(quest.objective);
	const complexity = estimateQuestComplexity(quest.objective);

	const performance: LoadoutPerformance = {
		id: generatePerformanceId(),
		loadoutConfigId: loadoutConfig.id,
		questId: quest.id,
		questType,
		questComplexity: complexity,
		raidId: raid.id,
		metrics,
		timestamp: new Date(),
		questObjective: quest.objective,
		agentMetrics,
	};

	persistenceLogger.info(
		{
			loadoutId: loadoutConfig.id,
			questType,
			score: calculateCompositeScore(metrics),
		},
		"Recorded loadout performance",
	);

	return performance;
}

/**
 * Calculate aggregated score for a loadout across all performances
 */
export function calculateLoadoutScore(loadoutConfigId: string, performances: LoadoutPerformance[]): LoadoutScore {
	const loadoutPerformances = performances.filter((p) => p.loadoutConfigId === loadoutConfigId);

	if (loadoutPerformances.length === 0) {
		return {
			loadoutConfigId,
			overallScore: 0,
			performanceByQuestType: {} as Record<QuestType, any>,
			recentPerformance: [],
			lastUpdated: new Date(),
		};
	}

	// Calculate overall score
	const overallScore =
		loadoutPerformances.reduce((sum, p) => sum + calculateCompositeScore(p.metrics), 0) / loadoutPerformances.length;

	// Group by quest type
	const byQuestType: Record<QuestType, LoadoutPerformance[]> = {} as Record<QuestType, LoadoutPerformance[]>;
	for (const perf of loadoutPerformances) {
		if (!byQuestType[perf.questType]) byQuestType[perf.questType] = [];
		byQuestType[perf.questType].push(perf);
	}

	// Calculate per quest type stats
	const performanceByQuestType = Object.entries(byQuestType).reduce(
		(acc, [questType, perfs]) => {
			const scores = perfs.map((p) => calculateCompositeScore(p.metrics));
			const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
			const avgTime = perfs.reduce((s, p) => s + p.metrics.timeToComplete, 0) / perfs.length;
			const avgCost = perfs.reduce((s, p) => s + p.metrics.costInCents, 0) / perfs.length;
			const avgQuality = perfs.reduce((s, p) => s + p.metrics.qualityScore, 0) / perfs.length;
			const successRate = (perfs.filter((p) => p.metrics.success).length / perfs.length) * 100;

			acc[questType as QuestType] = {
				score: avgScore,
				sampleCount: perfs.length,
				avgTimeToComplete: avgTime,
				avgCost: avgCost,
				avgQuality: avgQuality,
				successRate,
			};
			return acc;
		},
		{} as Record<QuestType, any>,
	);

	// Get recent performances (last 10)
	const recentPerformance = loadoutPerformances
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
		.slice(0, 10);

	return {
		loadoutConfigId,
		overallScore,
		performanceByQuestType,
		recentPerformance,
		lastUpdated: new Date(),
	};
}

/**
 * Generate loadout recommendations for a quest type
 */
export function generateLoadoutRecommendations(
	questType: QuestType,
	loadoutConfigs: LoadoutConfiguration[],
	loadoutScores: LoadoutScore[],
): LoadoutRecommendation | null {
	// Find loadouts that have performance data for this quest type
	const relevantLoadouts = loadoutScores
		.filter((score) => score.performanceByQuestType[questType]?.sampleCount > 0)
		.map((score) => ({
			loadout: loadoutConfigs.find((l) => l.id === score.loadoutConfigId)!,
			performance: score.performanceByQuestType[questType],
		}))
		.filter((item) => item.loadout); // Filter out any missing loadouts

	if (relevantLoadouts.length === 0) {
		return null;
	}

	// Sort by score, with sample count as tiebreaker
	relevantLoadouts.sort((a, b) => {
		const scoreA = a.performance.score + Math.log(a.performance.sampleCount) * 5; // Bonus for more samples
		const scoreB = b.performance.score + Math.log(b.performance.sampleCount) * 5;
		return scoreB - scoreA;
	});

	const best = relevantLoadouts[0];
	const alternatives = relevantLoadouts.slice(1, 4); // Top 3 alternatives

	// Calculate confidence based on sample size and score spread
	const sampleCount = best.performance.sampleCount;
	const scoreSpread =
		relevantLoadouts.length > 1 ? Math.abs(best.performance.score - relevantLoadouts[1].performance.score) : 100;
	const confidence = Math.min(100, Math.log(sampleCount + 1) * 20 + scoreSpread * 0.5);

	// Generate reasoning
	const reasoning =
		`Recommended for ${questType} based on ${sampleCount} samples with ${best.performance.score.toFixed(1)} average score. ` +
		`Success rate: ${best.performance.successRate.toFixed(1)}%, avg cost: $${(best.performance.avgCost / 100).toFixed(3)}, ` +
		`avg time: ${Math.round(best.performance.avgTimeToComplete / 1000)}s.`;

	return {
		questType,
		recommendedLoadout: best.loadout,
		confidence,
		alternativeLoadouts: alternatives.map((alt) => ({
			loadout: alt.loadout,
			score: alt.performance.score,
			reasoning: `Score: ${alt.performance.score.toFixed(1)} (${alt.performance.sampleCount} samples)`,
		})),
		reasoning,
		lastUpdated: new Date(),
	};
}

/**
 * Get the best loadout for a quest based on historical performance
 */
export function getBestLoadoutForQuest(
	quest: Quest,
	loadoutConfigs: LoadoutConfiguration[],
	loadoutScores: LoadoutScore[],
): LoadoutConfiguration | null {
	const questType = classifyQuestType(quest.objective);
	const recommendation = generateLoadoutRecommendations(questType, loadoutConfigs, loadoutScores);

	if (recommendation && recommendation.confidence > 50) {
		return recommendation.recommendedLoadout;
	}

	// Fallback to a suitable default based on quest type
	return getDefaultLoadoutForQuestType(questType, loadoutConfigs);
}

/**
 * Get a suitable default loadout for a quest type
 */
export function getDefaultLoadoutForQuestType(
	questType: QuestType,
	loadoutConfigs: LoadoutConfiguration[],
): LoadoutConfiguration {
	// Try to find default loadouts by ID
	let defaultId: string;

	switch (questType) {
		case "debug":
			defaultId = "debug-specialist";
			break;
		case "research":
			defaultId = "research-mode";
			break;
		case "performance":
		case "security":
			defaultId = "quality-focused";
			break;
		case "documentation":
		case "test":
			defaultId = "speed-demon";
			break;
		default:
			defaultId = "balanced-performer";
	}

	const defaultLoadout = loadoutConfigs.find((l) => l.id === defaultId);
	if (defaultLoadout) {
		return defaultLoadout;
	}

	// Fallback to first available or create a basic one
	return loadoutConfigs[0] || DEFAULT_LOADOUTS.find((l) => l.id === "balanced-performer")!;
}

/**
 * Update loadout scores based on new performance data
 */
export function updateLoadoutScores(
	performances: LoadoutPerformance[],
	existingScores: LoadoutScore[],
): LoadoutScore[] {
	const loadoutIds = [...new Set(performances.map((p) => p.loadoutConfigId))];
	const updatedScores: LoadoutScore[] = [];

	for (const loadoutId of loadoutIds) {
		const score = calculateLoadoutScore(loadoutId, performances);
		updatedScores.push(score);
	}

	// Keep existing scores for loadouts not updated
	for (const existingScore of existingScores) {
		if (!loadoutIds.includes(existingScore.loadoutConfigId)) {
			updatedScores.push(existingScore);
		}
	}

	return updatedScores;
}
