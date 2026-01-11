/**
 * Experimentation Framework Core
 *
 * Provides the main experimentation capabilities for A/B testing
 * task execution parameters and automatically analyzing results.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Task } from "../task.js";
import type {
	Experiment,
	ExperimentAnalysis,
	ExperimentOutcome,
	ExperimentStorage,
	ExperimentVariant,
	SignificanceTestResult,
	SuccessMetrics,
	TaskAssignment,
	VariantParameters,
} from "./types.js";

const DEFAULT_STORAGE_PATH = ".undercity/experiments/storage.json";
const STORAGE_VERSION = "1.0.0";

export class ExperimentFramework {
	private storagePath: string;

	constructor(storagePath: string = DEFAULT_STORAGE_PATH) {
		this.storagePath = storagePath;
		this.ensureStorageDirectory();
	}

	private ensureStorageDirectory(): void {
		const dir = this.storagePath.substring(0, this.storagePath.lastIndexOf("/"));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Load experiment storage from disk
	 */
	private loadStorage(): ExperimentStorage {
		if (!existsSync(this.storagePath)) {
			return {
				experiments: {},
				assignments: [],
				outcomes: [],
				version: STORAGE_VERSION,
				lastUpdated: new Date(),
			};
		}

		try {
			const content = readFileSync(this.storagePath, "utf-8");
			const storage = JSON.parse(content) as ExperimentStorage;

			// Convert date strings back to Date objects
			for (const exp of Object.values(storage.experiments)) {
				exp.createdAt = new Date(exp.createdAt);
				if (exp.startedAt) exp.startedAt = new Date(exp.startedAt);
				if (exp.endedAt) exp.endedAt = new Date(exp.endedAt);
				if (exp.latestAnalysis) {
					exp.latestAnalysis.analyzedAt = new Date(exp.latestAnalysis.analyzedAt);
				}
			}

			for (const assignment of storage.assignments) {
				assignment.assignedAt = new Date(assignment.assignedAt);
			}

			for (const outcome of storage.outcomes) {
				outcome.recordedAt = new Date(outcome.recordedAt);
			}

			storage.lastUpdated = new Date(storage.lastUpdated);

			return storage;
		} catch {
			return {
				experiments: {},
				assignments: [],
				outcomes: [],
				version: STORAGE_VERSION,
				lastUpdated: new Date(),
			};
		}
	}

	/**
	 * Save experiment storage to disk
	 */
	private saveStorage(storage: ExperimentStorage): void {
		storage.lastUpdated = new Date();
		const tempPath = `${this.storagePath}.tmp`;

		try {
			writeFileSync(tempPath, JSON.stringify(storage, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});
			renameSync(tempPath, this.storagePath);
		} catch (error) {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}
	}

	/**
	 * Generate a unique ID
	 */
	private generateId(prefix: string): string {
		const timestamp = Date.now().toString(36);
		const random = randomBytes(4).toString("hex");
		return `${prefix}-${timestamp}-${random}`;
	}

	/**
	 * Create a new experiment
	 */
	createExperiment(
		name: string,
		description: string,
		hypothesis: string,
		variants: Omit<ExperimentVariant, "id">[],
		options: {
			targetSampleSize?: number;
			alphaLevel?: number;
			minimumDetectableEffect?: number;
			createdBy?: string;
			tags?: string[];
		} = {},
	): Experiment {
		const storage = this.loadStorage();

		// Validate variants
		const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
		if (Math.abs(totalWeight - 1.0) > 0.001) {
			throw new Error(`Variant weights must sum to 1.0, got ${totalWeight}`);
		}

		const controlVariants = variants.filter((v) => v.isControl);
		if (controlVariants.length !== 1) {
			throw new Error("Exactly one variant must be marked as control");
		}

		const experiment: Experiment = {
			id: this.generateId("exp"),
			name,
			description,
			hypothesis,
			status: "draft",
			variants: variants.map((v) => ({
				...v,
				id: this.generateId("var"),
			})),
			targetSampleSize: options.targetSampleSize ?? 100,
			alphaLevel: options.alphaLevel ?? 0.05,
			minimumDetectableEffect: options.minimumDetectableEffect ?? 0.1,
			createdAt: new Date(),
			createdBy: options.createdBy ?? "system",
			tags: options.tags ?? [],
		};

		storage.experiments[experiment.id] = experiment;
		this.saveStorage(storage);

		return experiment;
	}

	/**
	 * Start an experiment (change status from draft to active)
	 * @param experimentId The ID of the experiment to start
	 * @param trials Optional number of trials to run (defaults to target sample size)
	 */
	startExperiment(experimentId: string, trials?: number): void {
		const storage = this.loadStorage();
		const experiment = storage.experiments[experimentId];

		if (!experiment) {
			throw new Error(`Experiment ${experimentId} not found`);
		}

		if (experiment.status !== "draft") {
			throw new Error(`Cannot start experiment in status: ${experiment.status}`);
		}

		// Override target sample size if trials is specified
		if (trials !== undefined) {
			experiment.targetSampleSize = trials;
		}

		experiment.status = "active";
		experiment.startedAt = new Date();
		this.saveStorage(storage);
	}

	/**
	 * Stop an experiment
	 */
	stopExperiment(experimentId: string): void {
		const storage = this.loadStorage();
		const experiment = storage.experiments[experimentId];

		if (!experiment) {
			throw new Error(`Experiment ${experimentId} not found`);
		}

		experiment.status = "completed";
		experiment.endedAt = new Date();
		this.saveStorage(storage);
	}

	/**
	 * Assign a task to an experiment variant using deterministic randomization
	 */
	assignTaskToVariant(taskId: string, experimentId: string): TaskAssignment | null {
		const storage = this.loadStorage();
		const experiment = storage.experiments[experimentId];

		if (!experiment) {
			throw new Error(`Experiment ${experimentId} not found`);
		}

		if (experiment.status !== "active") {
			return null; // Only assign for active experiments
		}

		// Check if task is already assigned to this experiment
		const existingAssignment = storage.assignments.find((a) => a.taskId === taskId && a.experimentId === experimentId);

		if (existingAssignment) {
			return existingAssignment;
		}

		// Create deterministic seed from task ID and experiment ID
		const seedString = `${taskId}-${experimentId}`;
		const hash = createHash("md5").update(seedString).digest("hex");
		const seed = parseInt(hash.substring(0, 8), 16) / 0xffffffff;

		// Use weighted random selection
		let cumulativeWeight = 0;
		let selectedVariant: ExperimentVariant | null = null;

		for (const variant of experiment.variants) {
			cumulativeWeight += variant.weight;
			if (seed < cumulativeWeight) {
				selectedVariant = variant;
				break;
			}
		}

		if (!selectedVariant) {
			selectedVariant = experiment.variants[experiment.variants.length - 1];
		}

		const assignment: TaskAssignment = {
			taskId,
			experimentId,
			variantId: selectedVariant.id,
			assignedAt: new Date(),
			assignmentSeed: hash,
		};

		storage.assignments.push(assignment);
		this.saveStorage(storage);

		return assignment;
	}

	/**
	 * Get the variant parameters for a task
	 */
	getVariantParameters(taskId: string, experimentId: string): VariantParameters | null {
		const assignment = this.getTaskAssignment(taskId, experimentId);
		if (!assignment) return null;

		const storage = this.loadStorage();
		const experiment = storage.experiments[experimentId];
		const variant = experiment?.variants.find((v) => v.id === assignment.variantId);

		return variant?.parameters || null;
	}

	/**
	 * Get task assignment for a specific experiment
	 */
	getTaskAssignment(taskId: string, experimentId: string): TaskAssignment | null {
		const storage = this.loadStorage();
		return storage.assignments.find((a) => a.taskId === taskId && a.experimentId === experimentId) || null;
	}

	/**
	 * Record an experiment outcome
	 */
	recordOutcome(
		experimentId: string,
		taskId: string,
		outcome: {
			success: boolean;
			tokensUsed: number;
			executionTimeMs: number;
			reworkCount: number;
			humanRating?: number;
			metadata?: Record<string, any>;
			diffMetrics?: {
				diffGenerated: boolean;
				diffApplied: boolean;
				diffGenerationTimeMs: number;
				diffModel?: string;
				diffSize?: number;
			};
		},
	): void {
		const storage = this.loadStorage();

		const assignment = storage.assignments.find((a) => a.taskId === taskId && a.experimentId === experimentId);

		if (!assignment) {
			throw new Error(`No assignment found for task ${taskId} in experiment ${experimentId}`);
		}

		const outcomeRecord: ExperimentOutcome = {
			id: this.generateId("outcome"),
			experimentId,
			variantId: assignment.variantId,
			taskId,
			...outcome,
			recordedAt: new Date(),
		};

		storage.outcomes.push(outcomeRecord);
		this.saveStorage(storage);
	}

	/**
	 * Get all active experiments that should receive task assignments
	 */
	getActiveExperiments(): Experiment[] {
		const storage = this.loadStorage();
		return Object.values(storage.experiments).filter((exp) => exp.status === "active");
	}

	/**
	 * Perform statistical analysis of an experiment
	 */
	analyzeExperiment(experimentId: string): ExperimentAnalysis {
		const storage = this.loadStorage();
		const experiment = storage.experiments[experimentId];

		if (!experiment) {
			throw new Error(`Experiment ${experimentId} not found`);
		}

		const outcomes = storage.outcomes.filter((o) => o.experimentId === experimentId);

		if (outcomes.length === 0) {
			return {
				analyzedAt: new Date(),
				sampleSizes: {},
				variantMetrics: {},
				significanceTests: [],
				status: "insufficient_data",
				recommendation: "continue",
				confidence: 0,
			};
		}

		// Group outcomes by variant
		const outcomesByVariant = new Map<string, ExperimentOutcome[]>();
		for (const outcome of outcomes) {
			if (!outcomesByVariant.has(outcome.variantId)) {
				outcomesByVariant.set(outcome.variantId, []);
			}
			outcomesByVariant.get(outcome.variantId)!.push(outcome);
		}

		// Calculate metrics per variant
		const variantMetrics: Record<string, SuccessMetrics> = {};
		const sampleSizes: Record<string, number> = {};

		for (const [variantId, variantOutcomes] of outcomesByVariant) {
			sampleSizes[variantId] = variantOutcomes.length;

			const successCount = variantOutcomes.filter((o) => o.success).length;
			const totalTokens = variantOutcomes.reduce((sum, o) => sum + o.tokensUsed, 0);
			const totalTime = variantOutcomes.reduce((sum, o) => sum + o.executionTimeMs, 0);
			const totalRework = variantOutcomes.reduce((sum, o) => sum + o.reworkCount, 0);

			const ratingsWithValues = variantOutcomes.filter((o) => o.humanRating !== undefined);
			const avgRating =
				ratingsWithValues.length > 0
					? ratingsWithValues.reduce((sum, o) => sum + o.humanRating!, 0) / ratingsWithValues.length
					: undefined;

			// Calculate diff-specific metrics
			const diffOutcomes = variantOutcomes.filter((o) => o.diffMetrics);
			const diffSuccessCount = diffOutcomes.filter((o) => o.diffMetrics?.diffGenerated).length;
			const diffApplicationCount = diffOutcomes.filter((o) => o.diffMetrics?.diffApplied).length;
			const diffGenTimes = diffOutcomes.map((o) => o.diffMetrics?.diffGenerationTimeMs || 0).filter((t) => t > 0);

			variantMetrics[variantId] = {
				successRate: successCount / variantOutcomes.length,
				avgTokensPerTask: totalTokens / variantOutcomes.length,
				avgExecutionTimeMs: totalTime / variantOutcomes.length,
				avgReworkCount: totalRework / variantOutcomes.length,
				humanSatisfaction: avgRating,
				diffSuccessRate: diffOutcomes.length > 0 ? diffSuccessCount / diffOutcomes.length : undefined,
				diffApplicationSuccessRate: diffOutcomes.length > 0 ? diffApplicationCount / diffOutcomes.length : undefined,
				avgDiffGenerationTimeMs:
					diffGenTimes.length > 0 ? diffGenTimes.reduce((sum, t) => sum + t, 0) / diffGenTimes.length : undefined,
			};
		}

		// Find control variant
		const controlVariant = experiment.variants.find((v) => v.isControl);
		if (!controlVariant || !outcomesByVariant.has(controlVariant.id)) {
			return {
				analyzedAt: new Date(),
				sampleSizes,
				variantMetrics,
				significanceTests: [],
				status: "insufficient_data",
				recommendation: "continue",
				confidence: 0,
			};
		}

		// Perform significance tests
		const significanceTests: SignificanceTestResult[] = [];
		const treatmentVariants = experiment.variants.filter((v) => !v.isControl);

		for (const treatmentVariant of treatmentVariants) {
			if (!outcomesByVariant.has(treatmentVariant.id)) continue;

			const controlOutcomes = outcomesByVariant.get(controlVariant.id)!;
			const treatmentOutcomes = outcomesByVariant.get(treatmentVariant.id)!;

			// Test success rate
			const successRateTest = this.performProportionTest(
				controlOutcomes.filter((o) => o.success).length,
				controlOutcomes.length,
				treatmentOutcomes.filter((o) => o.success).length,
				treatmentOutcomes.length,
				experiment.alphaLevel,
			);

			significanceTests.push({
				metric: "success_rate",
				controlValue: variantMetrics[controlVariant.id].successRate,
				treatmentValue: variantMetrics[treatmentVariant.id].successRate,
				improvement:
					((variantMetrics[treatmentVariant.id].successRate - variantMetrics[controlVariant.id].successRate) /
						variantMetrics[controlVariant.id].successRate) *
					100,
				pValue: successRateTest.pValue,
				isSignificant: successRateTest.isSignificant,
				confidenceInterval: successRateTest.confidenceInterval,
				sampleSizes: {
					control: controlOutcomes.length,
					treatment: treatmentOutcomes.length,
				},
			});
		}

		// Determine overall status and recommendation
		const minSampleSize = experiment.targetSampleSize;
		const hasMinimumSamples = Object.values(sampleSizes).every((size) => size >= minSampleSize);
		const hasSignificantResults = significanceTests.some((test) => test.isSignificant);

		let status: ExperimentAnalysis["status"];
		let recommendation: ExperimentAnalysis["recommendation"];
		let winningVariant: string | undefined;
		let confidence: number;

		if (!hasMinimumSamples) {
			status = "insufficient_data";
			recommendation = "continue";
			confidence = 0.2;
		} else if (hasSignificantResults) {
			status = "significant";
			const bestTest = significanceTests.reduce((best, current) =>
				current.improvement > best.improvement ? current : best,
			);
			recommendation = "stop_winner";
			winningVariant = treatmentVariants.find((v) => variantMetrics[v.id].successRate === bestTest.treatmentValue)?.id;
			confidence = 1 - bestTest.pValue;
		} else {
			status = "running";
			recommendation = hasMinimumSamples ? "increase_sample_size" : "continue";
			confidence = 0.5;
		}

		const analysis: ExperimentAnalysis = {
			analyzedAt: new Date(),
			sampleSizes,
			variantMetrics,
			significanceTests,
			status,
			recommendation,
			winningVariant,
			confidence,
		};

		// Store analysis in experiment
		experiment.latestAnalysis = analysis;
		this.saveStorage(storage);

		return analysis;
	}

	/**
	 * Perform a two-proportion z-test
	 */
	private performProportionTest(
		successes1: number,
		n1: number,
		successes2: number,
		n2: number,
		alpha: number,
	): { pValue: number; isSignificant: boolean; confidenceInterval: [number, number] } {
		if (n1 === 0 || n2 === 0) {
			return { pValue: 1, isSignificant: false, confidenceInterval: [-1, 1] };
		}

		const p1 = successes1 / n1;
		const p2 = successes2 / n2;
		const pooledP = (successes1 + successes2) / (n1 + n2);

		const standardError = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2));

		if (standardError === 0) {
			return { pValue: 1, isSignificant: false, confidenceInterval: [0, 0] };
		}

		const zScore = (p2 - p1) / standardError;
		const pValue = 2 * (1 - this.normalCDF(Math.abs(zScore)));

		// Confidence interval for difference in proportions
		const diff = p2 - p1;
		const ciSe = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
		const zCritical = this.normalInverseCDF(1 - alpha / 2);
		const margin = zCritical * ciSe;

		return {
			pValue,
			isSignificant: pValue < alpha,
			confidenceInterval: [diff - margin, diff + margin],
		};
	}

	/**
	 * Standard normal CDF (cumulative distribution function)
	 */
	private normalCDF(z: number): number {
		return 0.5 * (1 + this.erf(z / Math.sqrt(2)));
	}

	/**
	 * Inverse normal CDF approximation
	 */
	private normalInverseCDF(p: number): number {
		// Beasley-Springer-Moro algorithm approximation
		const a = [
			0, -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
			2.506628277459239,
		];
		const b = [
			0, -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
		];
		const c = [
			0, -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
			2.938163982698783,
		];
		const d = [0, 7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

		const p_low = 0.02425;
		const p_high = 1 - p_low;

		if (p < p_low) {
			const q = Math.sqrt(-2 * Math.log(p));
			return (
				(((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
				((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1)
			);
		} else if (p <= p_high) {
			const q = p - 0.5;
			const r = q * q;
			return (
				((((((a[1] * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * r + a[6]) * q) /
				(((((b[1] * r + b[2]) * r + b[3]) * r + b[4]) * r + b[5]) * r + 1)
			);
		} else {
			const q = Math.sqrt(-2 * Math.log(1 - p));
			return (
				-(((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
				((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1)
			);
		}
	}

	/**
	 * Error function approximation
	 */
	private erf(x: number): number {
		// Abramowitz and Stegun approximation
		const a1 = 0.254829592;
		const a2 = -0.284496736;
		const a3 = 1.421413741;
		const a4 = -1.453152027;
		const a5 = 1.061405429;
		const p = 0.3275911;

		const sign = x >= 0 ? 1 : -1;
		x = Math.abs(x);

		const t = 1.0 / (1.0 + p * x);
		const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

		return sign * y;
	}

	/**
	 * List all experiments
	 */
	listExperiments(): Experiment[] {
		const storage = this.loadStorage();
		return Object.values(storage.experiments);
	}

	/**
	 * Get a specific experiment
	 */
	getExperiment(experimentId: string): Experiment | null {
		const storage = this.loadStorage();
		return storage.experiments[experimentId] || null;
	}

	/**
	 * Delete an experiment and all associated data
	 */
	deleteExperiment(experimentId: string): void {
		const storage = this.loadStorage();

		delete storage.experiments[experimentId];
		storage.assignments = storage.assignments.filter((a) => a.experimentId !== experimentId);
		storage.outcomes = storage.outcomes.filter((o) => o.experimentId !== experimentId);

		this.saveStorage(storage);
	}
}
