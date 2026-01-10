/**
 * Improvement Persistence Manager
 *
 * Handles persistence of self-improvement data including metrics,
 * experiments, efficiency outcomes, and improvement quests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { raidLogger } from "./logger.js";
import type { ExperimentConfig, ImprovementQuest } from "./self-improvement.js";
import type { EfficiencyOutcome, ExperimentResult, QuestMetrics } from "./types.js";

/**
 * Storage structure for improvement data
 */
interface ImprovementStorage {
	/** Quest execution metrics */
	questMetrics: QuestMetrics[];
	/** Efficiency outcomes from A/B testing */
	efficiencyOutcomes: EfficiencyOutcome[];
	/** Experiment results */
	experimentResults: ExperimentResult[];
	/** Active experiment configurations */
	activeExperiments: Record<string, ExperimentConfig>;
	/** Generated improvement quests */
	improvementQuests: ImprovementQuest[];
	/** Last updated timestamp */
	lastUpdated: Date;
	/** Data format version */
	version: string;
}

/**
 * Manages persistence of self-improvement loop data
 */
export class ImprovementPersistence {
	private storageDir: string;
	private storage: ImprovementStorage;

	constructor(baseDir: string = process.cwd()) {
		this.storageDir = path.join(baseDir, ".undercity", "improvement");
		this.storage = this.initializeStorage();
		this.ensureStorageDir();
		this.loadStorage();
	}

	/**
	 * Initialize default storage structure
	 */
	private initializeStorage(): ImprovementStorage {
		return {
			questMetrics: [],
			efficiencyOutcomes: [],
			experimentResults: [],
			activeExperiments: {},
			improvementQuests: [],
			lastUpdated: new Date(),
			version: "1.0.0",
		};
	}

	/**
	 * Ensure storage directory exists
	 */
	private ensureStorageDir(): void {
		try {
			fs.mkdirSync(this.storageDir, { recursive: true });
		} catch (error) {
			raidLogger.warn({ error: String(error) }, "Failed to create improvement storage directory");
		}
	}

	/**
	 * Get storage file path
	 */
	private getStorageFilePath(): string {
		return path.join(this.storageDir, "improvement-data.json");
	}

	/**
	 * Load storage from disk
	 */
	private loadStorage(): void {
		const filePath = this.getStorageFilePath();

		try {
			if (fs.existsSync(filePath)) {
				const data = fs.readFileSync(filePath, "utf-8");
				const parsed = JSON.parse(data);

				// Ensure all required properties exist and handle version migration
				this.storage = {
					...this.initializeStorage(),
					...parsed,
					// Convert date strings back to Date objects
					lastUpdated: new Date(parsed.lastUpdated || Date.now()),
					questMetrics: (parsed.questMetrics || []).map((qm: any) => ({
						...qm,
						startedAt: new Date(qm.startedAt),
						completedAt: new Date(qm.completedAt),
					})),
					efficiencyOutcomes: (parsed.efficiencyOutcomes || []).map((eo: any) => ({
						...eo,
						recordedAt: new Date(eo.recordedAt),
					})),
					improvementQuests: (parsed.improvementQuests || []).map((iq: any) => ({
						...iq,
						createdAt: new Date(iq.createdAt),
					})),
				};

				raidLogger.debug(
					{
						questMetrics: this.storage.questMetrics.length,
						efficiencyOutcomes: this.storage.efficiencyOutcomes.length,
						experimentResults: this.storage.experimentResults.length,
					},
					"Loaded improvement storage",
				);
			}
		} catch (error) {
			raidLogger.warn({ error: String(error), filePath }, "Failed to load improvement storage, starting fresh");
			this.storage = this.initializeStorage();
		}
	}

	/**
	 * Save storage to disk
	 */
	private saveStorage(): void {
		const filePath = this.getStorageFilePath();

		try {
			this.storage.lastUpdated = new Date();
			const data = JSON.stringify(this.storage, null, 2);
			fs.writeFileSync(filePath, data, "utf-8");

			raidLogger.debug({ filePath }, "Saved improvement storage");
		} catch (error) {
			raidLogger.error({ error: String(error), filePath }, "Failed to save improvement storage");
		}
	}

	/**
	 * Add quest metrics
	 */
	addQuestMetrics(metrics: QuestMetrics): void {
		this.storage.questMetrics.push(metrics);
		this.saveStorage();
	}

	/**
	 * Add efficiency outcome
	 */
	addEfficiencyOutcome(outcome: EfficiencyOutcome): void {
		this.storage.efficiencyOutcomes.push(outcome);
		this.saveStorage();
	}

	/**
	 * Add experiment result
	 */
	addExperimentResult(result: ExperimentResult): void {
		this.storage.experimentResults.push(result);
		this.saveStorage();
	}

	/**
	 * Save active experiment configuration
	 */
	saveActiveExperiment(config: ExperimentConfig): void {
		this.storage.activeExperiments[config.id] = config;
		this.saveStorage();
	}

	/**
	 * Remove active experiment
	 */
	removeActiveExperiment(experimentId: string): void {
		delete this.storage.activeExperiments[experimentId];
		this.saveStorage();
	}

	/**
	 * Add improvement quest
	 */
	addImprovementQuest(quest: ImprovementQuest): void {
		this.storage.improvementQuests.push(quest);
		this.saveStorage();
	}

	/**
	 * Update improvement quest status (for tracking completion)
	 */
	updateImprovementQuest(questId: string, updates: Partial<ImprovementQuest>): boolean {
		const index = this.storage.improvementQuests.findIndex((q) => q.id === questId);
		if (index >= 0) {
			this.storage.improvementQuests[index] = {
				...this.storage.improvementQuests[index],
				...updates,
			};
			this.saveStorage();
			return true;
		}
		return false;
	}

	/**
	 * Get all quest metrics
	 */
	getQuestMetrics(): QuestMetrics[] {
		return [...this.storage.questMetrics];
	}

	/**
	 * Get quest metrics within a time range
	 */
	getQuestMetricsInRange(fromDate: Date, toDate: Date): QuestMetrics[] {
		return this.storage.questMetrics.filter((qm) => qm.startedAt >= fromDate && qm.startedAt <= toDate);
	}

	/**
	 * Get all efficiency outcomes
	 */
	getEfficiencyOutcomes(): EfficiencyOutcome[] {
		return [...this.storage.efficiencyOutcomes];
	}

	/**
	 * Get efficiency outcomes for a specific experiment
	 */
	getEfficiencyOutcomesByExperiment(experimentId: string): EfficiencyOutcome[] {
		return this.storage.efficiencyOutcomes.filter((eo) => eo.experimentId === experimentId);
	}

	/**
	 * Get all experiment results
	 */
	getExperimentResults(): ExperimentResult[] {
		return [...this.storage.experimentResults];
	}

	/**
	 * Get active experiments
	 */
	getActiveExperiments(): Record<string, ExperimentConfig> {
		return { ...this.storage.activeExperiments };
	}

	/**
	 * Get active experiment by ID
	 */
	getActiveExperiment(experimentId: string): ExperimentConfig | null {
		return this.storage.activeExperiments[experimentId] || null;
	}

	/**
	 * Get all improvement quests
	 */
	getImprovementQuests(): ImprovementQuest[] {
		return [...this.storage.improvementQuests];
	}

	/**
	 * Get improvement quests by priority
	 */
	getImprovementQuestsByPriority(priority: ImprovementQuest["priority"]): ImprovementQuest[] {
		return this.storage.improvementQuests.filter((q) => q.priority === priority);
	}

	/**
	 * Get improvement quests by category
	 */
	getImprovementQuestsByCategory(category: ImprovementQuest["category"]): ImprovementQuest[] {
		return this.storage.improvementQuests.filter((q) => q.category === category);
	}

	/**
	 * Clean old data to prevent unlimited growth
	 */
	cleanOldData(
		options: {
			maxQuestMetrics?: number;
			maxEfficiencyOutcomes?: number;
			maxExperimentResults?: number;
			maxImprovementQuests?: number;
			maxAgeDays?: number;
		} = {},
	): void {
		const {
			maxQuestMetrics = 1000,
			maxEfficiencyOutcomes = 500,
			maxExperimentResults = 100,
			maxImprovementQuests = 50,
			maxAgeDays = 90,
		} = options;

		const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
		let cleaned = false;

		// Clean quest metrics by count and age
		if (this.storage.questMetrics.length > maxQuestMetrics) {
			this.storage.questMetrics = this.storage.questMetrics
				.filter((qm) => qm.startedAt > cutoffDate)
				.slice(-maxQuestMetrics);
			cleaned = true;
		}

		// Clean efficiency outcomes by count and age
		if (this.storage.efficiencyOutcomes.length > maxEfficiencyOutcomes) {
			this.storage.efficiencyOutcomes = this.storage.efficiencyOutcomes
				.filter((eo) => eo.recordedAt > cutoffDate)
				.slice(-maxEfficiencyOutcomes);
			cleaned = true;
		}

		// Clean experiment results by count and age
		if (this.storage.experimentResults.length > maxExperimentResults) {
			this.storage.experimentResults = this.storage.experimentResults.slice(-maxExperimentResults);
			cleaned = true;
		}

		// Clean improvement quests by count and age
		if (this.storage.improvementQuests.length > maxImprovementQuests) {
			this.storage.improvementQuests = this.storage.improvementQuests
				.filter((iq) => iq.createdAt > cutoffDate)
				.slice(-maxImprovementQuests);
			cleaned = true;
		}

		if (cleaned) {
			this.saveStorage();
			raidLogger.info(
				{
					questMetrics: this.storage.questMetrics.length,
					efficiencyOutcomes: this.storage.efficiencyOutcomes.length,
					experimentResults: this.storage.experimentResults.length,
					improvementQuests: this.storage.improvementQuests.length,
				},
				"Cleaned old improvement data",
			);
		}
	}

	/**
	 * Export data for backup or analysis
	 */
	exportData(): ImprovementStorage {
		return JSON.parse(JSON.stringify(this.storage));
	}

	/**
	 * Import data from backup
	 */
	importData(data: Partial<ImprovementStorage>): void {
		try {
			this.storage = {
				...this.storage,
				...data,
				lastUpdated: new Date(),
			};
			this.saveStorage();

			raidLogger.info("Imported improvement data");
		} catch (error) {
			raidLogger.error({ error: String(error) }, "Failed to import improvement data");
		}
	}

	/**
	 * Get storage statistics
	 */
	getStorageStats(): {
		questMetrics: number;
		efficiencyOutcomes: number;
		experimentResults: number;
		activeExperiments: number;
		improvementQuests: number;
		lastUpdated: Date;
		storageSizeBytes: number;
	} {
		const filePath = this.getStorageFilePath();
		let storageSizeBytes = 0;

		try {
			const stats = fs.statSync(filePath);
			storageSizeBytes = stats.size;
		} catch {
			// File may not exist yet
		}

		return {
			questMetrics: this.storage.questMetrics.length,
			efficiencyOutcomes: this.storage.efficiencyOutcomes.length,
			experimentResults: this.storage.experimentResults.length,
			activeExperiments: Object.keys(this.storage.activeExperiments).length,
			improvementQuests: this.storage.improvementQuests.length,
			lastUpdated: this.storage.lastUpdated,
			storageSizeBytes,
		};
	}
}

// Singleton instance for global access
let improvementPersistence: ImprovementPersistence | null = null;

export function getImprovementPersistence(baseDir?: string): ImprovementPersistence {
	if (!improvementPersistence) {
		improvementPersistence = new ImprovementPersistence(baseDir);
	}
	return improvementPersistence;
}
