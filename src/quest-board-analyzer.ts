/**
 * Quest Board Analyzer Module
 *
 * High-level analysis of the quest board to find optimal quest combinations,
 * provide insights, and support the quest matchmaking system.
 */

import type { Quest } from "./quest.js";
import { getAllQuests, getReadyQuestsForBatch, getQuestBoardAnalytics } from "./quest.js";
import { QuestAnalyzer } from "./quest-analyzer.js";
import { QuestScheduler, type QuestSet, type CompatibilityResult, type QuestDependency } from "./quest-scheduler.js";
import { FileTracker } from "./file-tracker.js";

export interface QuestBoardInsights {
	totalQuests: number;
	pendingQuests: number;
	readyForParallelization: number;
	averageComplexity: "low" | "medium" | "high";
	topConflictingPackages: string[];
	parallelizationOpportunities: ParallelizationOpportunity[];
	recommendations: string[];
}

export interface ParallelizationOpportunity {
	questSet: QuestSet;
	description: string;
	benefit: "high" | "medium" | "low";
	estimatedTimesSaving: number; // Percentage time savings vs sequential
}

export interface CompatibilityMatrix {
	quests: Quest[];
	matrix: CompatibilityResult[][];
	summary: {
		totalPairs: number;
		compatiblePairs: number;
		conflictingPairs: number;
		averageCompatibilityScore: number;
	};
}

export class QuestBoardAnalyzer {
	private analyzer: QuestAnalyzer;
	private scheduler: QuestScheduler;
	private fileTracker: FileTracker;

	constructor() {
		this.analyzer = new QuestAnalyzer();
		this.fileTracker = new FileTracker();
		this.scheduler = new QuestScheduler(this.analyzer, this.fileTracker);
	}

	/**
	 * Analyze the current quest board for parallelization insights
	 */
	async analyzeQuestBoard(): Promise<QuestBoardInsights> {
		const allQuests = getAllQuests();
		const pendingQuests = allQuests.filter(q => q.status === "pending");

		// Get basic analytics
		const analytics = getQuestBoardAnalytics();

		// Analyze quest complexities
		const complexities: string[] = [];
		for (const quest of pendingQuests) {
			const analysis = await this.analyzer.analyzeQuest(quest);
			complexities.push(analysis.complexity);
		}

		const averageComplexity = this.calculateAverageComplexity(complexities);

		// Find parallelization opportunities
		const opportunities = await this.findParallelizationOpportunities(pendingQuests);

		// Generate recommendations
		const recommendations = this.generateRecommendations(pendingQuests, opportunities, analytics);

		return {
			totalQuests: allQuests.length,
			pendingQuests: pendingQuests.length,
			readyForParallelization: opportunities.reduce((sum, opp) => sum + opp.questSet.quests.length, 0),
			averageComplexity,
			topConflictingPackages: analytics.topConflictingPackages,
			parallelizationOpportunities: opportunities,
			recommendations,
		};
	}

	/**
	 * Find all possible parallelization opportunities in pending quests
	 */
	async findParallelizationOpportunities(pendingQuests: Quest[]): Promise<ParallelizationOpportunity[]> {
		if (pendingQuests.length < 2) return [];

		// Find compatible quest sets
		const questSets = await this.scheduler.findParallelizableSets(pendingQuests);

		// Filter and rank opportunities
		const opportunities: ParallelizationOpportunity[] = [];

		for (const questSet of questSets) {
			if (questSet.quests.length < 2) continue; // Skip single-quest sets

			const timesSaving = this.estimateTimeSavings(questSet);
			const benefit = this.categorizeBenefit(questSet, timesSaving);
			const description = this.generateOpportunityDescription(questSet);

			opportunities.push({
				questSet,
				description,
				benefit,
				estimatedTimesSaving: timesSaving,
			});
		}

		// Sort by benefit and time savings
		opportunities.sort((a, b) => {
			const benefitScore = { high: 3, medium: 2, low: 1 };
			const aBenefit = benefitScore[a.benefit];
			const bBenefit = benefitScore[b.benefit];

			if (aBenefit !== bBenefit) {
				return bBenefit - aBenefit; // Higher benefit first
			}
			return b.estimatedTimesSaving - a.estimatedTimesSaving; // Higher savings first
		});

		return opportunities.slice(0, 5); // Return top 5 opportunities
	}

	/**
	 * Generate a compatibility matrix showing which quests can run together
	 */
	async generateCompatibilityMatrix(quests?: Quest[]): Promise<CompatibilityMatrix> {
		const questsToAnalyze = quests ?? getReadyQuestsForBatch(10);

		if (questsToAnalyze.length === 0) {
			return {
				quests: [],
				matrix: [],
				summary: {
					totalPairs: 0,
					compatiblePairs: 0,
					conflictingPairs: 0,
					averageCompatibilityScore: 0,
				},
			};
		}

		// Ensure all quests are analyzed
		const analyzedQuests = await this.ensureQuestAnalysis(questsToAnalyze);

		// Build compatibility matrix
		const matrix: CompatibilityResult[][] = [];
		let totalCompatibility = 0;
		let compatiblePairs = 0;
		let conflictingPairs = 0;
		let totalPairs = 0;

		for (let i = 0; i < analyzedQuests.length; i++) {
			const row: CompatibilityResult[] = [];

			for (let j = 0; j < analyzedQuests.length; j++) {
				if (i === j) {
					// Quest is always compatible with itself
					row.push({
						quest1Id: analyzedQuests[i].id,
						quest2Id: analyzedQuests[j].id,
						compatible: true,
						conflicts: [],
						compatibilityScore: 1.0,
					});
				} else {
					const compatibility = await this.checkQuestCompatibility(
						analyzedQuests[i],
						analyzedQuests[j]
					);
					row.push(compatibility);

					// Update statistics (only count each pair once)
					if (i < j) {
						totalCompatibility += compatibility.compatibilityScore;
						totalPairs++;

						if (compatibility.compatible) {
							compatiblePairs++;
						} else {
							conflictingPairs++;
						}
					}
				}
			}
			matrix.push(row);
		}

		const averageCompatibilityScore = totalPairs > 0 ? totalCompatibility / totalPairs : 0;

		return {
			quests: analyzedQuests,
			matrix,
			summary: {
				totalPairs,
				compatiblePairs,
				conflictingPairs,
				averageCompatibilityScore,
			},
		};
	}

	/**
	 * Get insights about specific quest compatibility
	 */
	async analyzeQuestCompatibility(quest1Id: string, quest2Id: string): Promise<{
		compatible: boolean;
		conflicts: Array<{
			type: string;
			description: string;
			severity: string;
		}>;
		recommendedAction: string;
	}> {
		const allQuests = getAllQuests();
		const quest1 = allQuests.find(q => q.id === quest1Id);
		const quest2 = allQuests.find(q => q.id === quest2Id);

		if (!quest1 || !quest2) {
			return {
				compatible: false,
				conflicts: [{ type: "not_found", description: "One or both quests not found", severity: "blocking" }],
				recommendedAction: "Verify quest IDs are correct",
			};
		}

		const compatibility = await this.checkQuestCompatibility(quest1, quest2);

		const conflicts = compatibility.conflicts.map((conflict: QuestDependency) => ({
			type: conflict.type,
			description: this.getConflictDescription(conflict),
			severity: conflict.severity,
		}));

		let recommendedAction = "";
		if (compatibility.compatible) {
			recommendedAction = "These quests can run in parallel safely";
		} else {
			const blockingConflicts = conflicts.filter((c: any) => c.severity === "blocking");
			if (blockingConflicts.length > 0) {
				recommendedAction = "Run sequentially due to blocking conflicts";
			} else {
				recommendedAction = "Consider running in parallel with monitoring";
			}
		}

		return {
			compatible: compatibility.compatible,
			conflicts,
			recommendedAction,
		};
	}

	/**
	 * Provide optimization suggestions for the quest board
	 */
	async getOptimizationSuggestions(): Promise<string[]> {
		const insights = await this.analyzeQuestBoard();
		const suggestions: string[] = [];

		// Quest organization suggestions
		if (insights.pendingQuests > 10) {
			suggestions.push("Consider organizing quests by package/feature to improve parallelization");
		}

		// Parallel execution suggestions
		if (insights.parallelizationOpportunities.length === 0 && insights.pendingQuests > 1) {
			suggestions.push("Add package hints to quests to improve conflict detection");
			suggestions.push("Break down large quests into smaller, more focused tasks");
		}

		// Risk management suggestions
		const highRiskOpportunities = insights.parallelizationOpportunities.filter(
			opp => opp.questSet.riskLevel === "high"
		);
		if (highRiskOpportunities.length > 0) {
			suggestions.push("Consider running high-risk quests sequentially or with extra monitoring");
		}

		// Conflict reduction suggestions
		if (insights.topConflictingPackages.length > 0) {
			suggestions.push(`Focus on parallelizing quests outside of frequently-modified packages: ${insights.topConflictingPackages.slice(0, 3).join(", ")}`);
		}

		// Efficiency suggestions
		const lowBenefitOpportunities = insights.parallelizationOpportunities.filter(
			opp => opp.benefit === "low"
		);
		if (lowBenefitOpportunities.length > 2) {
			suggestions.push("Focus on high-benefit parallelization opportunities first");
		}

		return suggestions;
	}

	/**
	 * Ensure all quests have computed analysis data
	 */
	private async ensureQuestAnalysis(quests: Quest[]): Promise<Quest[]> {
		const analyzed: Quest[] = [];

		for (const quest of quests) {
			let analyzedQuest = { ...quest };

			if (!quest.computedPackages || quest.riskScore === undefined) {
				const analysis = await this.analyzer.analyzeQuest(quest);
				analyzedQuest = {
					...quest,
					computedPackages: analysis.packages,
					riskScore: analysis.riskScore,
					estimatedFiles: analysis.estimatedFiles,
					tags: analysis.tags,
				};
			}

			analyzed.push(analyzedQuest);
		}

		return analyzed;
	}

	/**
	 * Check compatibility between two quests
	 */
	private async checkQuestCompatibility(quest1: Quest, quest2: Quest) {
		// This delegates to the scheduler's compatibility checking logic
		// We create a minimal quest set to use the scheduler's method
		const dummyScheduler = new QuestScheduler(this.analyzer, this.fileTracker);
		return (dummyScheduler as any).checkQuestCompatibility(quest1, quest2);
	}

	/**
	 * Calculate average complexity from complexity array
	 */
	private calculateAverageComplexity(complexities: string[]): "low" | "medium" | "high" {
		if (complexities.length === 0) return "low";

		const scores = complexities.map(c => ({ low: 1, medium: 2, high: 3 }[c] ?? 1));
		const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;

		if (average >= 2.5) return "high";
		if (average >= 1.5) return "medium";
		return "low";
	}

	/**
	 * Estimate time savings from parallel execution
	 */
	private estimateTimeSavings(questSet: QuestSet): number {
		if (questSet.quests.length <= 1) return 0;

		// Simple model: parallel execution takes max(individual_times) vs sum(individual_times)
		// Assume each quest takes similar time based on complexity
		const questTimes = questSet.quests.map(quest => {
			const complexity = quest.tags?.includes("high") ? "high" :
							 quest.tags?.includes("medium") ? "medium" : "low";
			return { low: 15, medium: 30, high: 60 }[complexity]; // minutes
		});

		const sequentialTime = questTimes.reduce((sum, time) => sum + time, 0);
		const parallelTime = Math.max(...questTimes);

		return Math.round(((sequentialTime - parallelTime) / sequentialTime) * 100);
	}

	/**
	 * Categorize the benefit level of a parallelization opportunity
	 */
	private categorizeBenefit(questSet: QuestSet, timeSavings: number): "high" | "medium" | "low" {
		// High benefit: Good parallelism score, significant time savings, low risk
		if (questSet.parallelismScore >= 0.7 && timeSavings >= 40 && questSet.riskLevel === "low") {
			return "high";
		}

		// Medium benefit: Decent parallelism, moderate savings
		if (questSet.parallelismScore >= 0.5 && timeSavings >= 25) {
			return "medium";
		}

		return "low";
	}

	/**
	 * Generate a description for a parallelization opportunity
	 */
	private generateOpportunityDescription(questSet: QuestSet): string {
		const questCount = questSet.quests.length;
		const tags = new Set<string>();

		for (const quest of questSet.quests) {
			if (quest.tags) {
				quest.tags.forEach(tag => tags.add(tag));
			}
		}

		const mainTypes = Array.from(tags).filter(tag =>
			["feature", "bugfix", "refactor", "testing", "documentation"].includes(tag)
		);

		if (mainTypes.length > 0) {
			return `Run ${questCount} ${mainTypes.join("/")} quests in parallel`;
		}

		return `Run ${questCount} quests in parallel`;
	}

	/**
	 * Generate recommendations based on analysis
	 */
	private generateRecommendations(
		pendingQuests: Quest[],
		opportunities: ParallelizationOpportunity[],
		analytics: ReturnType<typeof getQuestBoardAnalytics>
	): string[] {
		const recommendations: string[] = [];

		// Basic recommendations
		if (opportunities.length === 0 && pendingQuests.length > 1) {
			recommendations.push("No parallel opportunities found - consider adding package hints to quests");
		}

		if (opportunities.length > 0) {
			const bestOpportunity = opportunities[0];
			recommendations.push(
				`Best opportunity: ${bestOpportunity.description} (${bestOpportunity.estimatedTimesSaving}% time savings)`
			);
		}

		// Efficiency recommendations
		if (analytics.averageCompletionTime > 30 * 60 * 1000) { // 30 minutes
			recommendations.push("Consider breaking down long-running quests for better parallelization");
		}

		// Risk management
		const highRiskOpportunities = opportunities.filter(opp => opp.questSet.riskLevel === "high");
		if (highRiskOpportunities.length > 0) {
			recommendations.push("Monitor high-risk parallel executions carefully");
		}

		return recommendations;
	}

	/**
	 * Get human-readable description for a conflict
	 */
	private getConflictDescription(conflict: QuestDependency): string {
		switch (conflict.type) {
			case "explicit":
				return "Explicit dependency or conflict defined";
			case "package_overlap":
				return "Quests modify the same package/module";
			case "file_conflict":
				return "Quests are likely to modify the same files";
			default:
				return "Unknown conflict type";
		}
	}
}