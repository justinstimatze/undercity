/**
 * Knowledge Tracking Module
 *
 * Tracks successful prompts, approaches, and learnings across different task types
 * Builds institutional knowledge to improve future raid performance
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
		writeFileSync(this.storagePath, JSON.stringify(storage, null, 2));
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
}
