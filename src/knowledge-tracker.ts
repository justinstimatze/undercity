/**
 * Knowledge Tracking Module
 *
 * Tracks successful prompts, approaches, and learnings across different task types
 * Builds institutional knowledge to improve future raid performance
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface PromptKnowledge {
	/** Unique hash identifier for this prompt/approach */
	id: string;
	/** Type of task this knowledge applies to */
	taskType: string;
	/** The original prompt or input */
	prompt: string;
	/** Successful approach or implementation details */
	approach: string;
	/** Performance metrics from successful execution */
	metrics: {
		/** Tokens used */
		tokensUsed: number;
		/** Execution time in milliseconds */
		executionTimeMs: number;
		/** Success rating (1-5) */
		successRating?: number;
		/** Human satisfaction score (1-5) for DSPy evaluation */
		humanSatisfactionScore?: number;
		/** Error categories encountered (for prompt quality analysis) */
		errorCategories?: string[];
		/** Whether this prompt required human intervention */
		requiredHumanIntervention?: boolean;
	};
	/** Metadata tags for searchability */
	tags: string[];
	/** When this knowledge was first recorded */
	recordedAt: Date;
	/** Number of times this approach has been successful */
	successCount: number;
}

/**
 * KnowledgeTracker manages persistent storage of successful approaches
 * Provides methods to record, search, and retrieve institutional knowledge
 */
export class KnowledgeTracker {
	private storagePath: string;
	private static STORAGE_VERSION = "1.0.0";

	constructor(storagePath: string = ".undercity/knowledge/storage.json") {
		this.storagePath = storagePath;
		this.ensureStorageDirectory();
	}

	/**
	 * Ensure the storage directory exists
	 */
	private ensureStorageDirectory(): void {
		const dir = this.storagePath.substring(0, this.storagePath.lastIndexOf("/"));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Generate a unique hash for a prompt
	 */
	private generatePromptHash(prompt: string, taskType: string): string {
		const hash = createHash("sha256");
		hash.update(`${taskType}:${prompt}`);
		return hash.digest("hex").substring(0, 12);
	}

	/**
	 * Load knowledge storage from disk
	 */
	private loadStorage(): {
		version: string;
		lastUpdated: Date;
		knowledge: PromptKnowledge[];
	} {
		if (!existsSync(this.storagePath)) {
			return {
				version: KnowledgeTracker.STORAGE_VERSION,
				lastUpdated: new Date(),
				knowledge: [],
			};
		}

		try {
			const content = readFileSync(this.storagePath, "utf-8");
			const storage = JSON.parse(content) as {
				version: string;
				lastUpdated: string;
				knowledge: PromptKnowledge[];
			};

			// Convert dates back to Date objects
			const knowledgeStorage = {
				version: storage.version,
				lastUpdated: new Date(storage.lastUpdated),
				knowledge: storage.knowledge.map((entry) => ({
					...entry,
					recordedAt: new Date(entry.recordedAt),
				})),
			};

			return knowledgeStorage;
		} catch {
			return {
				version: KnowledgeTracker.STORAGE_VERSION,
				lastUpdated: new Date(),
				knowledge: [],
			};
		}
	}

	/**
	 * Save knowledge storage to disk
	 */
	private saveStorage(storage: { version: string; lastUpdated: Date; knowledge: PromptKnowledge[] }): void {
		storage.lastUpdated = new Date();
		const tempPath = `${this.storagePath}.tmp`;

		try {
			// Write to temporary file first
			writeFileSync(tempPath, JSON.stringify(storage, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});

			// Atomically rename temporary file to target file
			// This ensures the file is never in a partially written state
			renameSync(tempPath, this.storagePath);
		} catch (error) {
			// Clean up temporary file if it exists
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}
	}

	/**
	 * Record a successful prompt/approach
	 */
	recordPromptKnowledge(
		taskType: string,
		prompt: string,
		approach: string,
		metrics: PromptKnowledge["metrics"],
		tags: string[] = [],
	): void {
		const storage = this.loadStorage();
		const promptHash = this.generatePromptHash(prompt, taskType);

		// Check if this prompt approach already exists
		const existingKnowledgeIndex = storage.knowledge.findIndex((k) => k.id === promptHash);

		const knowledgeEntry: PromptKnowledge =
			existingKnowledgeIndex !== -1
				? {
						...storage.knowledge[existingKnowledgeIndex],
						approach, // Update approach with latest successful method
						metrics: {
							tokensUsed: (storage.knowledge[existingKnowledgeIndex].metrics.tokensUsed + metrics.tokensUsed) / 2,
							executionTimeMs:
								(storage.knowledge[existingKnowledgeIndex].metrics.executionTimeMs + metrics.executionTimeMs) / 2,
							successRating: metrics.successRating ?? storage.knowledge[existingKnowledgeIndex].metrics.successRating,
						},
						tags: [...new Set([...storage.knowledge[existingKnowledgeIndex].tags, ...tags])],
						successCount: (storage.knowledge[existingKnowledgeIndex].successCount || 0) + 1,
					}
				: {
						id: promptHash,
						taskType,
						prompt,
						approach,
						metrics,
						tags,
						recordedAt: new Date(),
						successCount: 1,
					};

		if (existingKnowledgeIndex !== -1) {
			storage.knowledge[existingKnowledgeIndex] = knowledgeEntry;
		} else {
			storage.knowledge.push(knowledgeEntry);
		}

		this.saveStorage(storage);
	}

	/**
	 * Retrieve knowledge for a specific task type
	 */
	getKnowledgeByTaskType(taskType: string): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge.filter((k) => k.taskType === taskType).sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Search knowledge by tags
	 */
	searchKnowledgeByTags(tags: string[]): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => tags.some((tag) => k.tags.includes(tag)))
			.sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Find the most successful prompt for a given task type
	 */
	findMostSuccessfulPrompt(taskType: string, limit: number = 1): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => k.taskType === taskType)
			.sort((a, b) => b.successCount - a.successCount)
			.slice(0, limit);
	}

	/**
	 * Identify low-success prompts for a given task type
	 * @param taskType - The type of task to analyze
	 * @param successThreshold - Maximum number of successful attempts before considering a prompt effective
	 * @param limit - Maximum number of low-success prompts to return
	 */
	identifyLowSuccessPrompts(taskType: string, successThreshold: number = 2, limit: number = 5): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => k.taskType === taskType && (k.successCount === undefined || k.successCount <= successThreshold))
			.sort((a, b) => (a.successCount || 0) - (b.successCount || 0))
			.slice(0, limit);
	}

	/**
	 * Generate prompt improvement suggestions
	 * @param lowSuccessPrompt - The prompt with low success rate
	 * @returns Suggested improvements for the prompt
	 */
	generatePromptImprovements(lowSuccessPrompt: PromptKnowledge): string[] {
		const improvements: string[] = [];

		// Check metrics for potential improvement areas
		if ((lowSuccessPrompt.metrics.tokensUsed || 0) > 1000) {
			improvements.push("Reduce prompt verbosity and token usage");
		}

		// Human intervention analysis for DSPy readiness assessment
		if (lowSuccessPrompt.metrics.requiredHumanIntervention) {
			improvements.push("Improve prompt autonomy - reduce human dependency");
		}

		// Error category analysis
		if (lowSuccessPrompt.metrics.errorCategories?.length) {
			const errorTypes = lowSuccessPrompt.metrics.errorCategories;
			if (errorTypes.includes("ambiguous_requirements")) {
				improvements.push("Add more specific task requirements and constraints");
			}
			if (errorTypes.includes("poor_context")) {
				improvements.push("Improve contextual information and examples");
			}
			if (errorTypes.includes("wrong_approach")) {
				improvements.push("Consider few-shot examples of successful approaches");
			}
		}

		// Human satisfaction analysis
		if ((lowSuccessPrompt.metrics.humanSatisfactionScore || 0) < 3) {
			improvements.push("Focus on improving output quality and user experience");
		}

		// Add tags-based suggestions
		if (lowSuccessPrompt.tags.includes("complex")) {
			improvements.push("Break down complex tasks into smaller, more focused prompts");
		}

		// Basic prompt clarity and structure suggestions
		improvements.push("Clarify task objectives and context");
		improvements.push("Provide more specific examples or constraints");
		improvements.push("Use a step-by-step approach in the prompt");

		// A/B testing suggestion
		improvements.push("Create alternative prompt variants for comparison");

		return improvements;
	}

	/**
	 * Perform basic A/B testing of prompt improvements
	 * @param originalPrompt - The original low-success prompt
	 * @param improvedPrompts - Suggested improved prompt variants
	 * @returns A map of improved prompts with their initial performance metrics
	 */
	async testPromptImprovements(
		originalPrompt: PromptKnowledge,
		improvedPrompts: string[],
	): Promise<Map<string, { successCount: number; metrics: PromptKnowledge["metrics"] }>> {
		const resultsMap = new Map<string, { successCount: number; metrics: PromptKnowledge["metrics"] }>();

		for (const improvedPrompt of improvedPrompts) {
			// Simulate initial testing of the improved prompt
			// In a real implementation, this would involve actual task execution
			const simulatedMetrics: PromptKnowledge["metrics"] = {
				tokensUsed: Math.max(100, (originalPrompt.metrics.tokensUsed || 0) * 0.8),
				executionTimeMs: Math.max(100, (originalPrompt.metrics.executionTimeMs || 0) * 0.9),
				successRating: 4, // Hypothetical initial improvement
			};

			resultsMap.set(improvedPrompt, {
				successCount: 1, // Initial test
				metrics: simulatedMetrics,
			});
		}

		return resultsMap;
	}

	/**
	 * Assess readiness for DSPy integration by analyzing prompt performance patterns
	 * @returns Analysis indicating whether DSPy would provide value
	 */
	assessDSPyReadiness(): {
		recommendDSPy: boolean;
		confidence: number;
		rationale: string[];
		criticalMetrics: {
			lowPerformingPrompts: number;
			humanInterventionRate: number;
			avgSatisfactionScore: number;
			errorPatternDiversity: number;
		};
	} {
		const storage = this.loadStorage();
		const allKnowledge = storage.knowledge;

		if (allKnowledge.length < 50) {
			return {
				recommendDSPy: false,
				confidence: 0.1,
				rationale: ["Insufficient data: Need at least 50 prompt records for meaningful analysis"],
				criticalMetrics: {
					lowPerformingPrompts: 0,
					humanInterventionRate: 0,
					avgSatisfactionScore: 0,
					errorPatternDiversity: 0,
				},
			};
		}

		// Calculate critical metrics
		const lowPerformingPrompts = allKnowledge.filter(k =>
			(k.successCount || 0) <= 2 || (k.metrics.successRating || 0) < 3
		).length;

		const promptsWithInterventionData = allKnowledge.filter(k =>
			k.metrics.requiredHumanIntervention !== undefined
		);
		const humanInterventionRate = promptsWithInterventionData.length > 0
			? promptsWithInterventionData.filter(k => k.metrics.requiredHumanIntervention).length / promptsWithInterventionData.length
			: 0;

		const promptsWithSatisfactionData = allKnowledge.filter(k =>
			k.metrics.humanSatisfactionScore !== undefined
		);
		const avgSatisfactionScore = promptsWithSatisfactionData.length > 0
			? promptsWithSatisfactionData.reduce((sum, k) => sum + (k.metrics.humanSatisfactionScore || 0), 0) / promptsWithSatisfactionData.length
			: 0;

		const allErrorCategories = new Set<string>();
		allKnowledge.forEach(k => {
			k.metrics.errorCategories?.forEach(cat => allErrorCategories.add(cat));
		});
		const errorPatternDiversity = allErrorCategories.size;

		const metrics = {
			lowPerformingPrompts,
			humanInterventionRate,
			avgSatisfactionScore,
			errorPatternDiversity,
		};

		// Decision logic for DSPy recommendation
		const rationale: string[] = [];
		let score = 0;

		// High proportion of low-performing prompts suggests optimization opportunity
		const lowPerfRatio = lowPerformingPrompts / allKnowledge.length;
		if (lowPerfRatio > 0.3) {
			score += 3;
			rationale.push(`High proportion of low-performing prompts (${(lowPerfRatio * 100).toFixed(1)}%)`);
		} else if (lowPerfRatio > 0.15) {
			score += 1;
			rationale.push(`Moderate proportion of low-performing prompts (${(lowPerfRatio * 100).toFixed(1)}%)`);
		} else {
			rationale.push(`Low proportion of underperforming prompts (${(lowPerfRatio * 100).toFixed(1)}%) - existing system effective`);
		}

		// High human intervention rate suggests prompts need improvement
		if (humanInterventionRate > 0.4) {
			score += 3;
			rationale.push(`High human intervention rate (${(humanInterventionRate * 100).toFixed(1)}%)`);
		} else if (humanInterventionRate > 0.2) {
			score += 1;
			rationale.push(`Moderate human intervention rate (${(humanInterventionRate * 100).toFixed(1)}%)`);
		} else {
			rationale.push(`Low human intervention rate (${(humanInterventionRate * 100).toFixed(1)}%) - prompts are sufficiently autonomous`);
		}

		// Low satisfaction suggests quality issues
		if (avgSatisfactionScore > 0 && avgSatisfactionScore < 3) {
			score += 2;
			rationale.push(`Low average satisfaction score (${avgSatisfactionScore.toFixed(1)}/5)`);
		} else if (avgSatisfactionScore >= 4) {
			rationale.push(`High average satisfaction score (${avgSatisfactionScore.toFixed(1)}/5) - current prompts perform well`);
		}

		// Diverse error patterns suggest systematic prompt issues
		if (errorPatternDiversity >= 5) {
			score += 2;
			rationale.push(`Diverse error patterns (${errorPatternDiversity} categories) suggest systematic prompt quality issues`);
		}

		// Confidence based on data completeness
		const dataCompleteness = Math.min(
			promptsWithInterventionData.length / allKnowledge.length,
			promptsWithSatisfactionData.length / allKnowledge.length,
			allKnowledge.length / 100 // Cap at 100 samples for confidence calculation
		);

		const confidence = Math.max(0.1, dataCompleteness);

		// Recommendation threshold
		const recommendDSPy = score >= 5 && confidence > 0.7;

		if (!recommendDSPy) {
			if (score < 5) {
				rationale.push("Current prompt optimization appears sufficient - DSPy overhead not justified");
			}
			if (confidence <= 0.7) {
				rationale.push("Insufficient data quality for confident DSPy recommendation");
			}
		}

		return {
			recommendDSPy,
			confidence,
			rationale,
			criticalMetrics: metrics,
		};
	}
}
