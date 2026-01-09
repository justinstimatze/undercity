/**
 * Loadout Manager
 *
 * High-level interface for managing loadout configurations and utilizing the scoring system.
 * Provides utilities for loadout selection, performance tracking, and recommendations.
 */

import { persistenceLogger } from "./logger.js";
import {
	calculateLoadoutScore,
	DEFAULT_LOADOUTS,
	generateLoadoutRecommendations,
	getBestLoadoutForQuest,
	recordLoadoutPerformance,
	updateLoadoutScores,
} from "./loadout-scoring.js";
import type { Persistence } from "./persistence.js";
import type { Quest } from "./quest.js";
import type {
	EfficiencyMetrics,
	LoadoutConfiguration,
	LoadoutPerformance,
	LoadoutRecommendation,
	LoadoutScore,
	QuestType,
	Raid,
} from "./types.js";

/**
 * Loadout Manager - orchestrates loadout configurations and performance tracking
 */
export class LoadoutManager {
	private persistence: Persistence;

	constructor(persistence: Persistence) {
		this.persistence = persistence;
		this.initializeDefaultLoadouts();
	}

	/**
	 * Initialize default loadouts if none exist
	 */
	private initializeDefaultLoadouts(): void {
		const existing = this.persistence.getLoadoutConfigurations();
		if (existing.length === 0) {
			persistenceLogger.info("Initializing default loadout configurations");
			for (const defaultLoadout of DEFAULT_LOADOUTS) {
				this.persistence.saveLoadoutConfiguration(defaultLoadout);
			}
		}
	}

	// ============== Loadout Configuration Management ==============

	/**
	 * Get all loadout configurations
	 */
	getAllLoadouts(): LoadoutConfiguration[] {
		return this.persistence.getLoadoutConfigurations();
	}

	/**
	 * Get a loadout configuration by ID
	 */
	getLoadout(id: string): LoadoutConfiguration | undefined {
		return this.getAllLoadouts().find(l => l.id === id);
	}

	/**
	 * Save or update a loadout configuration
	 */
	saveLoadout(config: LoadoutConfiguration): void {
		this.persistence.saveLoadoutConfiguration(config);
		persistenceLogger.info({ loadoutId: config.id, name: config.name }, "Saved loadout configuration");
	}

	/**
	 * Remove a loadout configuration
	 */
	removeLoadout(id: string): boolean {
		const existing = this.getLoadout(id);
		if (!existing) return false;

		this.persistence.removeLoadoutConfiguration(id);
		persistenceLogger.info({ loadoutId: id }, "Removed loadout configuration");
		return true;
	}

	/**
	 * Clone a loadout with a new ID and name
	 */
	cloneLoadout(sourceId: string, newName: string): LoadoutConfiguration | null {
		const source = this.getLoadout(sourceId);
		if (!source) return null;

		const cloned: LoadoutConfiguration = {
			...source,
			id: `${source.id}-clone-${Date.now().toString(36)}`,
			name: newName,
			description: `Clone of ${source.name}`,
			lastUpdated: new Date(),
		};

		this.saveLoadout(cloned);
		return cloned;
	}

	// ============== Performance Tracking ==============

	/**
	 * Record performance for a completed quest
	 */
	recordQuestPerformance(
		loadoutConfig: LoadoutConfiguration,
		quest: Quest,
		raid: Raid,
		metrics: EfficiencyMetrics,
		agentMetrics?: Record<string, { tokensUsed: number; timeSpent: number; taskSuccess: boolean }>
	): LoadoutPerformance {
		const performance = recordLoadoutPerformance(loadoutConfig, quest, raid, metrics, agentMetrics);
		this.persistence.addLoadoutPerformance(performance);

		// Update scores after recording performance
		this.updateAllLoadoutScores();

		persistenceLogger.info({
			questId: quest.id,
			loadoutId: loadoutConfig.id,
			questType: performance.questType,
			success: metrics.success
		}, "Recorded quest performance for loadout");

		return performance;
	}

	/**
	 * Get all performance data for a loadout
	 */
	getLoadoutPerformance(configId: string): LoadoutPerformance[] {
		return this.persistence.getLoadoutPerformancesForConfig(configId);
	}

	/**
	 * Get performance data for a specific quest type
	 */
	getQuestTypePerformance(questType: QuestType): LoadoutPerformance[] {
		return this.persistence.getLoadoutPerformancesForQuestType(questType);
	}

	// ============== Scoring System ==============

	/**
	 * Update scores for all loadouts based on current performance data
	 */
	updateAllLoadoutScores(): void {
		const allPerformances = this.persistence.getLoadoutPerformances();
		const existingScores = this.persistence.getLoadoutScores();
		const updatedScores = updateLoadoutScores(allPerformances, existingScores);

		for (const score of updatedScores) {
			this.persistence.saveLoadoutScore(score);
		}

		persistenceLogger.debug({ updatedCount: updatedScores.length }, "Updated loadout scores");
	}

	/**
	 * Get the score for a specific loadout
	 */
	getLoadoutScore(configId: string): LoadoutScore | undefined {
		return this.persistence.getLoadoutScore(configId);
	}

	/**
	 * Get all loadout scores
	 */
	getAllLoadoutScores(): LoadoutScore[] {
		return this.persistence.getLoadoutScores();
	}

	/**
	 * Get loadout rankings (sorted by overall score)
	 */
	getLoadoutRankings(): Array<{ loadout: LoadoutConfiguration; score: LoadoutScore }> {
		const loadouts = this.getAllLoadouts();
		const scores = this.getAllLoadoutScores();

		const rankings = loadouts.map(loadout => ({
			loadout,
			score: scores.find(s => s.loadoutConfigId === loadout.id) || {
				loadoutConfigId: loadout.id,
				overallScore: 0,
				performanceByQuestType: {} as Record<QuestType, {
					score: number;
					sampleCount: number;
					avgTimeToComplete: number;
					avgCost: number;
					avgQuality: number;
					successRate: number;
				}>,
				recentPerformance: [],
				lastUpdated: new Date(),
			}
		}));

		// Sort by overall score descending
		rankings.sort((a, b) => b.score.overallScore - a.score.overallScore);

		return rankings;
	}

	// ============== Recommendation System ==============

	/**
	 * Get the best loadout for a specific quest
	 */
	getBestLoadoutForQuest(quest: Quest): LoadoutConfiguration {
		const loadouts = this.getAllLoadouts();
		const scores = this.getAllLoadoutScores();

		const bestLoadout = getBestLoadoutForQuest(quest, loadouts, scores);
		if (bestLoadout) {
			persistenceLogger.info({
				questId: quest.id,
				selectedLoadout: bestLoadout.id
			}, "Selected best loadout for quest");
			return bestLoadout;
		}

		// Fallback to balanced performer
		const fallback = loadouts.find(l => l.id === "balanced-performer") || loadouts[0];
		persistenceLogger.warn({
			questId: quest.id,
			fallbackLoadout: fallback.id
		}, "No optimal loadout found, using fallback");
		return fallback;
	}

	/**
	 * Generate recommendations for a specific quest type
	 */
	getQuestTypeRecommendation(questType: QuestType): LoadoutRecommendation | null {
		const loadouts = this.getAllLoadouts();
		const scores = this.getAllLoadoutScores();

		const recommendation = generateLoadoutRecommendations(questType, loadouts, scores);
		if (recommendation) {
			this.persistence.saveLoadoutRecommendation(recommendation);
			persistenceLogger.info({ questType, confidence: recommendation.confidence }, "Generated loadout recommendation");
		}

		return recommendation;
	}

	/**
	 * Get all current recommendations
	 */
	getAllRecommendations(): LoadoutRecommendation[] {
		return this.persistence.getLoadoutRecommendations();
	}

	/**
	 * Update all recommendations based on current performance data
	 */
	updateAllRecommendations(): void {
		const questTypes: QuestType[] = ["debug", "feature", "refactor", "documentation", "test", "performance", "security", "research"];

		for (const questType of questTypes) {
			this.getQuestTypeRecommendation(questType);
		}

		persistenceLogger.info("Updated all quest type recommendations");
	}

	// ============== Analytics and Reporting ==============

	/**
	 * Get comprehensive analytics about loadout performance
	 */
	getAnalytics(): {
		totalLoadouts: number;
		totalPerformanceRecords: number;
		topPerformer: { loadout: LoadoutConfiguration; score: number } | null;
		questTypeBreakdown: Record<string, number>;
		averageSuccessRate: number;
		costEfficiencyLeader: { loadout: LoadoutConfiguration; avgCost: number } | null;
		speedLeader: { loadout: LoadoutConfiguration; avgTime: number } | null;
	} {
		const loadouts = this.getAllLoadouts();
		const scores = this.getAllLoadoutScores();
		const performances = this.persistence.getLoadoutPerformances();

		// Top performer by overall score
		const topPerformer = scores.length > 0
			? scores.reduce((best, score) => score.overallScore > best.overallScore ? score : best)
			: null;

		const topPerformerData = topPerformer
			? {
				loadout: loadouts.find(l => l.id === topPerformer.loadoutConfigId)!,
				score: topPerformer.overallScore
			  }
			: null;

		// Quest type breakdown
		const questTypeBreakdown: Record<string, number> = {};
		for (const perf of performances) {
			questTypeBreakdown[perf.questType] = (questTypeBreakdown[perf.questType] || 0) + 1;
		}

		// Average success rate
		const successfulQuests = performances.filter(p => p.metrics.success).length;
		const averageSuccessRate = performances.length > 0 ? (successfulQuests / performances.length) * 100 : 0;

		// Cost efficiency leader (lowest average cost)
		let costEfficiencyLeader: { loadout: LoadoutConfiguration; avgCost: number } | null = null;
		let bestAvgCost = Number.POSITIVE_INFINITY;

		for (const score of scores) {
			const avgCost = Object.values(score.performanceByQuestType).reduce((sum, data) => sum + data.avgCost, 0) /
							Object.keys(score.performanceByQuestType).length;

			if (avgCost < bestAvgCost) {
				bestAvgCost = avgCost;
				const loadout = loadouts.find(l => l.id === score.loadoutConfigId);
				if (loadout) {
					costEfficiencyLeader = { loadout, avgCost };
				}
			}
		}

		// Speed leader (fastest average time)
		let speedLeader: { loadout: LoadoutConfiguration; avgTime: number } | null = null;
		let bestAvgTime = Number.POSITIVE_INFINITY;

		for (const score of scores) {
			const avgTime = Object.values(score.performanceByQuestType).reduce((sum, data) => sum + data.avgTimeToComplete, 0) /
						   Object.keys(score.performanceByQuestType).length;

			if (avgTime < bestAvgTime) {
				bestAvgTime = avgTime;
				const loadout = loadouts.find(l => l.id === score.loadoutConfigId);
				if (loadout) {
					speedLeader = { loadout, avgTime };
				}
			}
		}

		return {
			totalLoadouts: loadouts.length,
			totalPerformanceRecords: performances.length,
			topPerformer: topPerformerData,
			questTypeBreakdown,
			averageSuccessRate,
			costEfficiencyLeader,
			speedLeader,
		};
	}

	/**
	 * Clean up old performance data (optional maintenance)
	 */
	cleanupOldData(retentionDays: number = 90): void {
		this.persistence.cleanupOldPerformanceData(retentionDays);
		this.updateAllLoadoutScores(); // Recalculate after cleanup
		persistenceLogger.info({ retentionDays }, "Cleaned up old performance data");
	}

	/**
	 * Export loadout configuration for backup/sharing
	 */
	exportLoadout(configId: string): string | null {
		const config = this.getLoadout(configId);
		const score = this.getLoadoutScore(configId);
		const performances = this.getLoadoutPerformance(configId);

		if (!config) return null;

		const exportData = {
			configuration: config,
			score,
			recentPerformances: performances.slice(-10), // Last 10 performances
			exportedAt: new Date(),
		};

		return JSON.stringify(exportData, null, 2);
	}

	/**
	 * Import loadout configuration from exported data
	 */
	importLoadout(exportedData: string): LoadoutConfiguration | null {
		try {
			const data = JSON.parse(exportedData);
			const config = data.configuration as LoadoutConfiguration;

			// Generate new ID to avoid conflicts
			config.id = `imported-${Date.now().toString(36)}`;
			config.lastUpdated = new Date();

			this.saveLoadout(config);
			persistenceLogger.info({ loadoutId: config.id, name: config.name }, "Imported loadout configuration");

			return config;
		} catch (error) {
			persistenceLogger.error({ error }, "Failed to import loadout configuration");
			return null;
		}
	}
}