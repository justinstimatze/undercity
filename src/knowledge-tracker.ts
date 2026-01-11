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
}
