/**
 * Experiment Framework
 *
 * A/B testing framework for grind - randomly assign tasks to variants
 * and track which routing/prompts work better.
 *
 * Usage:
 * 1. Create experiment with variants
 * 2. During grind, call selectVariant() to get random assignment
 * 3. After task completes, call recordResult()
 * 4. Analyze with getVariantMetrics()
 */

import { persistenceLogger } from "./logger.js";
import { Persistence } from "./persistence.js";
import type {
	Experiment,
	ExperimentStorage,
	ExperimentTaskResult,
	ExperimentVariant,
	VariantMetrics,
} from "./types.js";

const logger = persistenceLogger.child({ module: "experiment" });

/**
 * Generate a unique experiment ID
 */
function generateExperimentId(): string {
	return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Experiment Manager
 *
 * Handles experiment lifecycle and variant assignment.
 */
export class ExperimentManager {
	private persistence: Persistence;
	private storage: ExperimentStorage;

	constructor(persistence?: Persistence) {
		this.persistence = persistence ?? new Persistence();
		this.storage = this.loadStorage();
	}

	/**
	 * Load experiment storage from persistence
	 */
	private loadStorage(): ExperimentStorage {
		try {
			return this.persistence.getExperimentStorage<ExperimentStorage>({
				experiments: [],
				lastUpdated: new Date(),
			});
		} catch {
			return {
				experiments: [],
				lastUpdated: new Date(),
			};
		}
	}

	/**
	 * Save experiment storage to persistence
	 */
	private saveStorage(): void {
		this.storage.lastUpdated = new Date();
		this.persistence.saveExperimentStorage(this.storage);
	}

	/**
	 * Create a new experiment
	 */
	createExperiment(name: string, description: string, variants: ExperimentVariant[]): Experiment {
		const experiment: Experiment = {
			id: generateExperimentId(),
			name,
			description,
			variants,
			isActive: false,
			createdAt: new Date(),
			results: [],
		};

		this.storage.experiments.push(experiment);
		this.saveStorage();

		logger.info({ experimentId: experiment.id, name, variantCount: variants.length }, "Created experiment");
		return experiment;
	}

	/**
	 * Activate an experiment (deactivates any currently active one)
	 */
	activateExperiment(experimentId: string): boolean {
		// Deactivate all experiments first
		for (const exp of this.storage.experiments) {
			exp.isActive = false;
		}

		const experiment = this.storage.experiments.find((e) => e.id === experimentId);
		if (!experiment) {
			logger.warn({ experimentId }, "Experiment not found");
			return false;
		}

		experiment.isActive = true;
		this.storage.activeExperimentId = experimentId;
		this.saveStorage();

		logger.info({ experimentId, name: experiment.name }, "Activated experiment");
		return true;
	}

	/**
	 * Deactivate the current experiment
	 */
	deactivateExperiment(): void {
		for (const exp of this.storage.experiments) {
			exp.isActive = false;
		}
		this.storage.activeExperimentId = undefined;
		this.saveStorage();

		logger.info("Deactivated experiment");
	}

	/**
	 * Get the currently active experiment
	 */
	getActiveExperiment(): Experiment | null {
		if (!this.storage.activeExperimentId) {
			return null;
		}
		return this.storage.experiments.find((e) => e.id === this.storage.activeExperimentId) ?? null;
	}

	/**
	 * Select a variant for a task using weighted random selection
	 *
	 * Returns null if no experiment is active.
	 */
	selectVariant(): ExperimentVariant | null {
		const experiment = this.getActiveExperiment();
		if (!experiment || experiment.variants.length === 0) {
			return null;
		}

		// Weighted random selection
		const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
		let random = Math.random() * totalWeight;

		for (const variant of experiment.variants) {
			random -= variant.weight;
			if (random <= 0) {
				logger.debug({ experimentId: experiment.id, variantId: variant.id }, "Selected variant");
				return variant;
			}
		}

		// Fallback to first variant
		return experiment.variants[0];
	}

	/**
	 * Record the result of a task execution
	 */
	recordResult(result: Omit<ExperimentTaskResult, "timestamp">): void {
		const experiment = this.getActiveExperiment();
		if (!experiment) {
			logger.debug("No active experiment, skipping result recording");
			return;
		}

		const fullResult: ExperimentTaskResult = {
			...result,
			timestamp: new Date(),
		};

		experiment.results.push(fullResult);
		this.saveStorage();

		logger.debug(
			{
				experimentId: experiment.id,
				variantId: result.variantId,
				taskId: result.taskId,
				success: result.success,
			},
			"Recorded experiment result",
		);
	}

	/**
	 * Get metrics for all variants in an experiment
	 */
	getVariantMetrics(experimentId?: string): VariantMetrics[] {
		const experiment = experimentId
			? this.storage.experiments.find((e) => e.id === experimentId)
			: this.getActiveExperiment();

		if (!experiment) {
			return [];
		}

		const metrics: VariantMetrics[] = [];

		for (const variant of experiment.variants) {
			const variantResults = experiment.results.filter((r) => r.variantId === variant.id);
			const totalTasks = variantResults.length;

			if (totalTasks === 0) {
				metrics.push({
					variantId: variant.id,
					totalTasks: 0,
					successCount: 0,
					successRate: 0,
					avgDurationMs: 0,
					avgTokensPerTask: 0,
					avgAttempts: 0,
				});
				continue;
			}

			const successCount = variantResults.filter((r) => r.success).length;
			const totalDuration = variantResults.reduce((sum, r) => sum + r.durationMs, 0);
			const totalTokens = variantResults.reduce((sum, r) => sum + r.tokensUsed, 0);
			const totalAttempts = variantResults.reduce((sum, r) => sum + r.attempts, 0);

			metrics.push({
				variantId: variant.id,
				totalTasks,
				successCount,
				successRate: successCount / totalTasks,
				avgDurationMs: totalDuration / totalTasks,
				avgTokensPerTask: totalTokens / totalTasks,
				avgAttempts: totalAttempts / totalTasks,
			});
		}

		return metrics;
	}

	/**
	 * Get all experiments
	 */
	getAllExperiments(): Experiment[] {
		return this.storage.experiments;
	}

	/**
	 * Get experiment by ID
	 */
	getExperiment(experimentId: string): Experiment | null {
		return this.storage.experiments.find((e) => e.id === experimentId) ?? null;
	}

	/**
	 * Delete an experiment
	 */
	deleteExperiment(experimentId: string): boolean {
		const index = this.storage.experiments.findIndex((e) => e.id === experimentId);
		if (index === -1) {
			return false;
		}

		if (this.storage.activeExperimentId === experimentId) {
			this.storage.activeExperimentId = undefined;
		}

		this.storage.experiments.splice(index, 1);
		this.saveStorage();

		logger.info({ experimentId }, "Deleted experiment");
		return true;
	}

	/**
	 * Create default A/B experiment comparing model tiers
	 */
	createModelComparisonExperiment(): Experiment {
		const variants: ExperimentVariant[] = [
			{
				id: "control-sonnet",
				name: "Control (Sonnet)",
				model: "sonnet",
				weight: 1,
				reviewEnabled: false,
			},
			{
				id: "haiku-aggressive",
				name: "Haiku Aggressive",
				model: "haiku",
				weight: 1,
				reviewEnabled: false,
			},
			{
				id: "sonnet-with-review",
				name: "Sonnet + Review",
				model: "sonnet",
				weight: 1,
				reviewEnabled: true,
			},
		];

		return this.createExperiment(
			"Model Tier Comparison",
			"Compare haiku vs sonnet routing, and effect of review passes",
			variants,
		);
	}
}

/**
 * Singleton instance for convenience
 */
let defaultManager: ExperimentManager | null = null;

/**
 * Get the default experiment manager instance
 */
export function getExperimentManager(): ExperimentManager {
	if (!defaultManager) {
		defaultManager = new ExperimentManager();
	}
	return defaultManager;
}
