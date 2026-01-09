/**
 * Quest Scheduler Module
 *
 * Core matchmaking engine for finding compatible quest sets that can run in parallel.
 * Analyzes dependencies, conflicts, and resource requirements to optimize parallel execution.
 */

import type { FileTracker } from "./file-tracker.js";
import type { Quest } from "./quest.js";
import type { QuestAnalyzer } from "./quest-analyzer.js";

export interface QuestSet {
	quests: Quest[];
	estimatedDuration: number;
	riskLevel: "low" | "medium" | "high";
	parallelismScore: number;
	compatibilityMatrix: CompatibilityResult[][];
}

export interface QuestDependencyGraph {
	nodes: Quest[];
	edges: QuestDependency[];
	readyQuests: Quest[];
}

export interface QuestDependency {
	fromQuestId: string;
	toQuestId: string;
	type: "explicit" | "file_conflict" | "package_overlap";
	severity: "blocking" | "warning";
}

export interface CompatibilityResult {
	quest1Id: string;
	quest2Id: string;
	compatible: boolean;
	conflicts: QuestDependency[];
	compatibilityScore: number; // 0-1, where 1 is fully compatible
}

export class QuestScheduler {
	private analyzer: QuestAnalyzer;
	private fileTracker: FileTracker;
	private maxParallelQuests: number;

	constructor(analyzer: QuestAnalyzer, fileTracker: FileTracker, maxParallelQuests: number = 3) {
		this.analyzer = analyzer;
		this.fileTracker = fileTracker;
		this.maxParallelQuests = maxParallelQuests;
	}

	/**
	 * Main matchmaking algorithm - find optimal parallelizable quest sets
	 */
	async findParallelizableSets(availableQuests: Quest[]): Promise<QuestSet[]> {
		if (availableQuests.length === 0) return [];

		// First, analyze all quests to ensure they have computed analysis
		const analyzedQuests = await this.ensureQuestAnalysis(availableQuests);

		// Build dependency graph to understand relationships
		const dependencyGraph = this.buildDependencyGraph(analyzedQuests);

		// Find all possible quest combinations
		const questSets = this.generateQuestCombinations(dependencyGraph.readyQuests, this.maxParallelQuests);

		// Evaluate each set for compatibility and performance
		const evaluatedSets: QuestSet[] = [];
		for (const questSet of questSets) {
			const evaluation = await this.evaluateQuestSet(questSet);
			if (evaluation) {
				evaluatedSets.push(evaluation);
			}
		}

		// Sort by parallelism score (higher is better)
		evaluatedSets.sort((a, b) => b.parallelismScore - a.parallelismScore);

		return evaluatedSets;
	}

	/**
	 * Ensure all quests have computed analysis data
	 */
	private async ensureQuestAnalysis(quests: Quest[]): Promise<Quest[]> {
		const analyzed: Quest[] = [];

		for (const quest of quests) {
			let analyzedQuest = { ...quest };

			// Skip analysis if already computed
			if (!quest.computedPackages || !quest.riskScore) {
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
	 * Build dependency graph and identify ready-to-run quests
	 */
	buildDependencyGraph(quests: Quest[]): QuestDependencyGraph {
		const edges: QuestDependency[] = [];
		const blockedQuests = new Set<string>();

		// Process explicit dependencies
		for (const quest of quests) {
			if (quest.dependsOn) {
				for (const depId of quest.dependsOn) {
					edges.push({
						fromQuestId: depId,
						toQuestId: quest.id,
						type: "explicit",
						severity: "blocking",
					});
					blockedQuests.add(quest.id);
				}
			}

			// Process explicit conflicts
			if (quest.conflicts) {
				for (const conflictId of quest.conflicts) {
					edges.push({
						fromQuestId: quest.id,
						toQuestId: conflictId,
						type: "explicit",
						severity: "blocking",
					});
				}
			}
		}

		// Detect implicit conflicts (package overlap, file conflicts)
		for (let i = 0; i < quests.length; i++) {
			for (let j = i + 1; j < quests.length; j++) {
				const quest1 = quests[i];
				const quest2 = quests[j];

				const conflicts = this.detectImplicitConflicts(quest1, quest2);
				edges.push(...conflicts);

				if (conflicts.some((c) => c.severity === "blocking")) {
					// Mark both quests as potentially conflicting
					// (actual blocking will be resolved in compatibility check)
				}
			}
		}

		// Identify ready quests (no blocking dependencies)
		const readyQuests = quests.filter((quest) => !blockedQuests.has(quest.id));

		return {
			nodes: quests,
			edges,
			readyQuests,
		};
	}

	/**
	 * Detect implicit conflicts between two quests
	 */
	private detectImplicitConflicts(quest1: Quest, quest2: Quest): QuestDependency[] {
		const conflicts: QuestDependency[] = [];

		// Check package boundary overlap
		const quest1Packages = quest1.computedPackages || [];
		const quest2Packages = quest2.computedPackages || [];

		if (this.hasPackageOverlap(quest1Packages, quest2Packages)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "package_overlap",
				severity: "warning", // Package overlap is warning, not blocking
			});
		}

		// Check estimated file conflicts
		const quest1Files = quest1.estimatedFiles || [];
		const quest2Files = quest2.estimatedFiles || [];

		if (this.hasFileOverlap(quest1Files, quest2Files)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "file_conflict",
				severity: "blocking", // File conflicts are blocking
			});
		}

		return conflicts;
	}

	/**
	 * Generate all possible combinations of quests up to maxSize
	 */
	private generateQuestCombinations(quests: Quest[], maxSize: number): Quest[][] {
		const combinations: Quest[][] = [];

		// Single quest combinations (always valid)
		for (const quest of quests) {
			combinations.push([quest]);
		}

		// Multi-quest combinations
		for (let size = 2; size <= Math.min(maxSize, quests.length); size++) {
			const sizeCombinations = this.getCombinations(quests, size);
			combinations.push(...sizeCombinations);
		}

		return combinations;
	}

	/**
	 * Get all combinations of a specific size
	 */
	private getCombinations<T>(items: T[], size: number): T[][] {
		if (size === 1) {
			return items.map((item) => [item]);
		}

		const combinations: T[][] = [];
		for (let i = 0; i < items.length - size + 1; i++) {
			const head = items[i];
			const tailCombinations = this.getCombinations(items.slice(i + 1), size - 1);
			for (const tail of tailCombinations) {
				combinations.push([head, ...tail]);
			}
		}

		return combinations;
	}

	/**
	 * Evaluate a quest set for compatibility and performance
	 */
	private async evaluateQuestSet(questSet: Quest[]): Promise<QuestSet | null> {
		if (questSet.length === 0) return null;

		// Build compatibility matrix
		const compatibilityMatrix = this.buildCompatibilityMatrix(questSet);

		// Check if all quests in the set are compatible
		let _allCompatible = true;
		const allConflicts: QuestDependency[] = [];

		for (const row of compatibilityMatrix) {
			for (const result of row) {
				if (!result.compatible) {
					_allCompatible = false;
				}
				allConflicts.push(...result.conflicts);
			}
		}

		// If any blocking conflicts exist, this set is invalid
		const blockingConflicts = allConflicts.filter((c) => c.severity === "blocking");
		if (blockingConflicts.length > 0) {
			return null;
		}

		// Calculate metrics
		const estimatedDuration = this.estimateSetDuration(questSet);
		const riskLevel = this.calculateSetRiskLevel(questSet);
		const parallelismScore = this.calculateParallelismScore(questSet, compatibilityMatrix);

		return {
			quests: questSet,
			estimatedDuration,
			riskLevel,
			parallelismScore,
			compatibilityMatrix,
		};
	}

	/**
	 * Build compatibility matrix for a quest set
	 */
	private buildCompatibilityMatrix(questSet: Quest[]): CompatibilityResult[][] {
		const matrix: CompatibilityResult[][] = [];

		for (let i = 0; i < questSet.length; i++) {
			const row: CompatibilityResult[] = [];
			for (let j = 0; j < questSet.length; j++) {
				if (i === j) {
					// Quest is always compatible with itself
					row.push({
						quest1Id: questSet[i].id,
						quest2Id: questSet[j].id,
						compatible: true,
						conflicts: [],
						compatibilityScore: 1.0,
					});
				} else {
					const compatibility = this.checkQuestCompatibility(questSet[i], questSet[j]);
					row.push(compatibility);
				}
			}
			matrix.push(row);
		}

		return matrix;
	}

	/**
	 * Check if two quests are compatible for parallel execution
	 */
	private checkQuestCompatibility(quest1: Quest, quest2: Quest): CompatibilityResult {
		const conflicts: QuestDependency[] = [];
		let score = 1.0;

		// Check explicit dependencies
		if (quest1.dependsOn?.includes(quest2.id) || quest2.dependsOn?.includes(quest1.id)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "explicit",
				severity: "blocking",
			});
			score = 0;
		}

		// Check explicit conflicts
		if (quest1.conflicts?.includes(quest2.id) || quest2.conflicts?.includes(quest1.id)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "explicit",
				severity: "blocking",
			});
			score = 0;
		}

		// Check package boundary overlap
		const quest1Packages = quest1.computedPackages || [];
		const quest2Packages = quest2.computedPackages || [];
		if (this.hasPackageOverlap(quest1Packages, quest2Packages)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "package_overlap",
				severity: "warning",
			});
			score -= 0.3; // Reduce score but don't block
		}

		// Check estimated file conflicts
		const quest1Files = quest1.estimatedFiles || [];
		const quest2Files = quest2.estimatedFiles || [];
		if (this.hasFileOverlap(quest1Files, quest2Files)) {
			conflicts.push({
				fromQuestId: quest1.id,
				toQuestId: quest2.id,
				type: "file_conflict",
				severity: "blocking",
			});
			score = 0;
		}

		// Check risk threshold (avoid running multiple high-risk quests)
		const quest1Risk = quest1.riskScore || 0;
		const quest2Risk = quest2.riskScore || 0;
		if (quest1Risk > 0.7 && quest2Risk > 0.7) {
			score -= 0.4; // Heavy penalty for double high-risk
		}

		const compatible = score > 0 && !conflicts.some((c) => c.severity === "blocking");

		return {
			quest1Id: quest1.id,
			quest2Id: quest2.id,
			compatible,
			conflicts,
			compatibilityScore: Math.max(0, score),
		};
	}

	/**
	 * Check if two package arrays have overlapping entries
	 */
	private hasPackageOverlap(packages1: string[], packages2: string[]): boolean {
		const set1 = new Set(packages1);
		return packages2.some((pkg) => set1.has(pkg));
	}

	/**
	 * Check if two file arrays have overlapping patterns
	 */
	private hasFileOverlap(files1: string[], files2: string[]): boolean {
		// Simple exact match check for now
		// In a more sophisticated implementation, this could handle glob patterns
		const set1 = new Set(files1);
		return files2.some((file) => set1.has(file));
	}

	/**
	 * Estimate total duration for a quest set (assumes parallel execution)
	 */
	private estimateSetDuration(questSet: Quest[]): number {
		// For parallel execution, duration is the maximum of individual quest durations
		// Base estimate: complexity maps to duration
		const durations = questSet.map((quest) => {
			const complexity = quest.tags?.includes("high") ? "high" : quest.tags?.includes("medium") ? "medium" : "low";
			switch (complexity) {
				case "high":
					return 45 * 60 * 1000; // 45 minutes
				case "medium":
					return 25 * 60 * 1000; // 25 minutes
				case "low":
					return 15 * 60 * 1000; // 15 minutes
				default:
					return 20 * 60 * 1000; // 20 minutes default
			}
		});

		return Math.max(...durations);
	}

	/**
	 * Calculate overall risk level for a quest set
	 */
	private calculateSetRiskLevel(questSet: Quest[]): "low" | "medium" | "high" {
		const maxRisk = Math.max(...questSet.map((q) => q.riskScore || 0));
		const avgRisk = questSet.reduce((sum, q) => sum + (q.riskScore || 0), 0) / questSet.length;

		if (maxRisk > 0.8 || avgRisk > 0.6) return "high";
		if (maxRisk > 0.5 || avgRisk > 0.3) return "medium";
		return "low";
	}

	/**
	 * Calculate parallelism score (higher is better for parallel execution)
	 */
	private calculateParallelismScore(questSet: Quest[], compatibilityMatrix: CompatibilityResult[][]): number {
		if (questSet.length === 1) {
			// Single quest gets base score
			return 0.5;
		}

		// Start with base parallelism benefit
		let score = questSet.length * 0.3; // More quests = higher parallelism

		// Add compatibility bonus
		let totalCompatibility = 0;
		let pairCount = 0;

		for (let i = 0; i < compatibilityMatrix.length; i++) {
			for (let j = i + 1; j < compatibilityMatrix[i].length; j++) {
				totalCompatibility += compatibilityMatrix[i][j].compatibilityScore;
				pairCount++;
			}
		}

		if (pairCount > 0) {
			const avgCompatibility = totalCompatibility / pairCount;
			score += avgCompatibility * 0.4; // Reward high compatibility
		}

		// Penalty for risk concentration
		const highRiskCount = questSet.filter((q) => (q.riskScore || 0) > 0.7).length;
		score -= highRiskCount * 0.2;

		// Bonus for diverse quest types
		const uniqueTags = new Set<string>();
		for (const quest of questSet) {
			if (quest.tags) {
				for (const tag of quest.tags) {
					uniqueTags.add(tag);
				}
			}
		}
		score += Math.min(uniqueTags.size * 0.1, 0.3); // Up to 0.3 bonus for diversity

		return Math.max(0, Math.min(1, score)); // Clamp to [0, 1]
	}

	/**
	 * Select the optimal quest set from available options
	 */
	selectOptimalQuestSet(questSets: QuestSet[], maxCount: number = 3): QuestSet | null {
		if (questSets.length === 0) return null;

		// Filter by size constraint
		const validSets = questSets.filter((set) => set.quests.length <= maxCount);
		if (validSets.length === 0) return null;

		// Sort by parallelism score and return the best
		validSets.sort((a, b) => b.parallelismScore - a.parallelismScore);
		return validSets[0];
	}
}
