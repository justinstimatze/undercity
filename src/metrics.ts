/**
 * Efficiency Metrics Tracker
 *
 * Tracks task execution metrics for analytics and cost optimization.
 *
 * | Metric               | Description                           |
 * |----------------------|---------------------------------------|
 * | Token usage          | Input/output/total per task           |
 * | Execution time       | Duration in milliseconds              |
 * | Success rates        | By model, complexity, agent type      |
 * | Escalation tracking  | Model upgrades and their outcomes     |
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ComplexityLevel } from "./complexity.js";
import { assessComplexityFast } from "./complexity.js";
import { warning } from "./output.js";
import { RateLimitTracker } from "./rate-limit.js";
import type { AgentType, AttemptRecord, EfficiencyAnalytics, TaskMetrics, TokenUsage } from "./types.js";

/** Type for SDK messages that may contain token usage info */
interface SdkMessage {
	usage?: { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number };
	metadata?: { usage?: SdkMessage["usage"] };
	meta?: { usage?: SdkMessage["usage"] };
	inputTokens?: number;
	outputTokens?: number;
	input_tokens?: number;
	output_tokens?: number;
}

const METRICS_DIR = path.join(process.cwd(), ".undercity");
const METRICS_FILE = path.join(METRICS_DIR, "metrics.jsonl");

/**
 * Model tier hierarchy for escalation validation.
 * Maps model names to numeric tiers for comparison.
 */
const MODEL_TIERS: Record<"haiku" | "sonnet" | "opus", number> = {
	haiku: 1,
	sonnet: 2,
	opus: 3,
} as const;

/**
 * Validates that a model escalation follows the correct tier hierarchy.
 *
 * Valid escalations must move from a lower tier to a higher tier:
 * - haiku → sonnet (valid)
 * - haiku → opus (valid)
 * - sonnet → opus (valid)
 *
 * Invalid escalations:
 * - Same tier (e.g., sonnet → sonnet)
 * - Downward (e.g., opus → sonnet, sonnet → haiku)
 * - From opus to any model (opus is the highest tier)
 *
 * @param fromModel - The starting model tier
 * @param toModel - The target model tier after escalation
 * @returns True if the escalation follows valid hierarchy (fromModel tier < toModel tier), false otherwise
 *
 * @example
 * ```typescript
 * isValidEscalation("haiku", "sonnet"); // true - valid escalation
 * isValidEscalation("sonnet", "opus"); // true - valid escalation
 * isValidEscalation("sonnet", "haiku"); // false - invalid downward escalation
 * isValidEscalation("opus", "sonnet"); // false - invalid escalation from highest tier
 * isValidEscalation("sonnet", "sonnet"); // false - invalid same-tier escalation
 * ```
 */
function isValidEscalation(fromModel: "haiku" | "sonnet" | "opus", toModel: "haiku" | "sonnet" | "opus"): boolean {
	const fromTier = MODEL_TIERS[fromModel];
	const toTier = MODEL_TIERS[toModel];
	return fromTier < toTier;
}

/**
 * Logs metrics to .undercity/metrics.jsonl
 * Creates directory if it doesn't exist
 */
async function logMetricsToFile(metrics: TaskMetrics): Promise<void> {
	try {
		// Ensure directory exists
		await fs.mkdir(METRICS_DIR, { recursive: true });

		// Convert metrics to JSON and append to file
		const metricsJson = JSON.stringify(metrics);
		await fs.appendFile(METRICS_FILE, `${metricsJson}\n`);
	} catch (error) {
		console.error("Failed to log metrics:", error);
	}
}

/**
 * Tracks efficiency metrics for tasks and sessions
 *
 * Provides comprehensive tracking of task execution including token usage,
 * duration, agent spawns, model escalations, and effectiveness metrics.
 *
 * @example
 * ```typescript
 * const tracker = new MetricsTracker();
 * tracker.startTask("task-123", "Fix login bug", "session-456", "sonnet", "user");
 * tracker.recordTokenUsage(sdkMessage, "sonnet");
 * tracker.recordEscalation("sonnet", "opus");
 * const metrics = tracker.completeTask(true);
 * ```
 */
export class MetricsTracker {
	private taskStartTime?: Date;
	private taskId?: string;
	private sessionId?: string;
	private objective?: string;
	private totalTokens = 0;
	private agentsSpawned = 0;
	private agentTypes: AgentType[] = [];
	private currentError?: string;
	private rateLimitTracker: RateLimitTracker;
	/** Track individual attempts with model info for escalation analysis */
	private attempts: AttemptRecord[] = [];
	/** Track the final model used (after any escalations) */
	private finalModel?: "haiku" | "sonnet" | "opus";
	/** Complexity level assessed at task start */
	private complexityLevel?: ComplexityLevel;
	/** Starting model before any escalation */
	private startingModel?: "haiku" | "sonnet" | "opus";
	/** Whether the task was escalated */
	private wasEscalated = false;
	/** Source that originated this task */
	private source?: "pm" | "user" | "research" | "codebase_gap" | "pattern_analysis";
	// ============== Effectiveness Tracking Fields ==============
	/** Learning IDs that were injected into the task prompt */
	private injectedLearningIds: string[] = [];
	/** Files predicted to be modified based on task-file patterns */
	private predictedFiles: string[] = [];
	/** Files actually modified during task execution */
	private actualFilesModified: string[] = [];
	/** Review statistics */
	private reviewStats?: {
		issuesFound: number;
		reviewTokens: number;
		reviewPasses: number;
	};
	// ============== Additional Effectiveness Tracking Fields ==============
	/** RAG searches performed during task */
	private ragSearches: Array<{ query: string; resultsCount: number; wasUsed: boolean }> = [];
	/** Model recommended by self-tuning routing profile */
	private recommendedModel?: "sonnet" | "opus";
	/** Task classifier prediction */
	private classifierPrediction?: { riskLevel: "low" | "medium" | "high"; confidence: number };
	// ============== Throughput Tracking Fields ==============
	/** Lines changed (insertions + deletions) */
	private linesChanged?: number;
	/** Files changed count */
	private filesChanged?: number;
	// ============== Phase Timing Fields ==============
	/** Time spent in each phase */
	private phaseTiming: {
		planningMs?: number;
		executionMs?: number;
		verificationMs?: number;
		reviewMs?: number;
		mergeMs?: number;
	} = {};
	/** Track phase start times for calculating durations */
	private phaseStartTime?: number;
	private currentPhase?: "planning" | "execution" | "verification" | "review" | "merge";

	constructor(rateLimitTracker?: RateLimitTracker) {
		this.rateLimitTracker = rateLimitTracker || new RateLimitTracker();
	}

	/**
	 * Reset tracking state for a new task
	 */
	private reset(): void {
		this.taskStartTime = undefined;
		this.taskId = undefined;
		this.sessionId = undefined;
		this.objective = undefined;
		this.totalTokens = 0;
		this.agentsSpawned = 0;
		this.agentTypes = [];
		this.currentError = undefined;
		this.attempts = [];
		this.finalModel = undefined;
		this.complexityLevel = undefined;
		this.startingModel = undefined;
		this.wasEscalated = false;
		this.source = undefined;
		this.injectedLearningIds = [];
		this.predictedFiles = [];
		this.actualFilesModified = [];
		this.reviewStats = undefined;
		this.ragSearches = [];
		this.recommendedModel = undefined;
		this.classifierPrediction = undefined;
		this.linesChanged = undefined;
		this.filesChanged = undefined;
		this.phaseTiming = {};
		this.phaseStartTime = undefined;
		this.currentPhase = undefined;
	}

	/**
	 * Start tracking a task with complexity assessment
	 *
	 * @param taskId - Unique task identifier
	 * @param objective - Task objective/description
	 * @param sessionId - Session identifier
	 * @param startingModel - Starting model tier (before any escalation)
	 * @param source - Source that originated this task (e.g., 'pm', 'user', 'research', 'codebase_gap', 'pattern_analysis')
	 */
	startTask(
		taskId: string,
		objective: string,
		sessionId: string,
		startingModel?: "haiku" | "sonnet" | "opus",
		source?: "pm" | "user" | "research" | "codebase_gap" | "pattern_analysis",
	): void {
		this.reset();
		this.taskStartTime = new Date();
		this.taskId = taskId;
		this.sessionId = sessionId;
		this.objective = objective;
		this.startingModel = startingModel;
		this.source = source;
		// Assess complexity at start time
		this.complexityLevel = assessComplexityFast(objective).level;
	}

	/**
	 * Record model escalation
	 */
	recordEscalation(fromModel: "haiku" | "sonnet" | "opus", toModel: "haiku" | "sonnet" | "opus"): void {
		// Validate escalation follows correct tier hierarchy
		if (!isValidEscalation(fromModel, toModel)) {
			warning("Invalid model escalation detected", {
				fromModel,
				toModel,
				reason:
					fromModel === toModel
						? "Same tier escalation"
						: MODEL_TIERS[fromModel] > MODEL_TIERS[toModel]
							? "Downward escalation"
							: "Invalid escalation path",
			});
		}

		this.wasEscalated = true;
		this.finalModel = toModel;
	}

	/**
	 * Record agent spawn
	 */
	recordAgentSpawn(agentType: AgentType): void {
		this.agentsSpawned++;
		if (!this.agentTypes.includes(agentType)) {
			this.agentTypes.push(agentType);
		}
	}

	/**
	 * Record an attempt for the current task.
	 * Tracks model used, duration, success, and escalation info.
	 */
	recordAttempt(attempt: AttemptRecord): void {
		this.attempts.push(attempt);
		this.finalModel = attempt.model;
	}

	/**
	 * Record multiple attempts at once (useful when batch-setting from external tracking)
	 */
	recordAttempts(attempts: AttemptRecord[]): void {
		this.attempts.push(...attempts);
		if (attempts.length > 0) {
			this.finalModel = attempts[attempts.length - 1].model;
		}
	}

	// ============== Effectiveness Tracking Methods ==============

	/**
	 * Record learning IDs that were injected into the task prompt
	 */
	recordInjectedLearnings(learningIds: string[]): void {
		this.injectedLearningIds = [...learningIds];
	}

	/**
	 * Record files predicted to be modified based on task-file patterns
	 */
	recordPredictedFiles(files: string[]): void {
		this.predictedFiles = [...files];
	}

	/**
	 * Record files actually modified during task execution
	 */
	recordActualFilesModified(files: string[]): void {
		this.actualFilesModified = [...files];
	}

	/**
	 * Record review statistics
	 */
	recordReviewStats(issuesFound: number, reviewTokens: number, reviewPasses: number): void {
		this.reviewStats = { issuesFound, reviewTokens, reviewPasses };
	}

	// ============== Additional Effectiveness Recording Methods ==============

	/**
	 * Record a RAG search performed during task context building
	 */
	recordRagSearch(query: string, resultsCount: number, wasUsed: boolean): void {
		this.ragSearches.push({ query, resultsCount, wasUsed });
	}

	/**
	 * Record the model recommended by self-tuning routing profile
	 */
	recordRecommendedModel(model: "sonnet" | "opus"): void {
		this.recommendedModel = model;
	}

	/**
	 * Record task classifier prediction for risk assessment
	 */
	recordClassifierPrediction(riskLevel: "low" | "medium" | "high", confidence: number): void {
		this.classifierPrediction = { riskLevel, confidence };
	}

	// ============== Throughput Recording Methods ==============

	/**
	 * Record lines and files changed from verification results
	 */
	recordThroughput(linesChanged: number, filesChanged: number): void {
		this.linesChanged = linesChanged;
		this.filesChanged = filesChanged;
	}

	// ============== Phase Timing Methods ==============

	/**
	 * Validates phase transition logic to ensure phases follow a logical sequence.
	 *
	 * Valid phase transition sequences:
	 * - planning → execution → verification → review → merge
	 * - Phases can be skipped (e.g., planning → execution → verification → merge)
	 * - Phases can repeat (e.g., verification can run multiple times)
	 * - Cannot move backwards in sequence (e.g., execution → planning is invalid)
	 *
	 * @param transitionType - Type of transition being validated ("start" for phaseStart, "end" for phaseEnd)
	 * @param targetPhase - The phase being transitioned to (for start) or from (for end)
	 * @param currentPhase - The currently active phase (if any)
	 * @param phaseStartTime - The start time of the current phase (if any)
	 * @throws {Error} If phase transition violates logical sequence rules
	 *
	 * @example
	 * ```typescript
	 * // Valid: moving forward in sequence
	 * validatePhaseTransition("start", "execution", "planning", Date.now());
	 *
	 * // Invalid: moving backwards
	 * validatePhaseTransition("start", "planning", "execution", Date.now()); // throws
	 *
	 * // Valid: ending the correct phase
	 * validatePhaseTransition("end", "planning", "planning", Date.now());
	 *
	 * // Invalid: phase mismatch
	 * validatePhaseTransition("end", "planning", "execution", Date.now()); // throws
	 * ```
	 */
	private validatePhaseTransition(
		transitionType: "start" | "end",
		targetPhase: "planning" | "execution" | "verification" | "review" | "merge",
		currentPhase?: "planning" | "execution" | "verification" | "review" | "merge",
		phaseStartTime?: number,
	): void {
		// Define valid phase order for validation
		const phaseOrder: Record<"planning" | "execution" | "verification" | "review" | "merge", number> = {
			planning: 0,
			execution: 1,
			verification: 2,
			review: 3,
			merge: 4,
		};

		if (transitionType === "start") {
			// Validate phase transition if there's a current phase
			if (currentPhase) {
				const currentOrder = phaseOrder[currentPhase];
				const nextOrder = phaseOrder[targetPhase];

				// Allow repeating the same phase (e.g., multiple verification passes)
				// Allow moving forward in the sequence
				// Disallow moving backwards (e.g., execution → planning)
				if (nextOrder < currentOrder) {
					throw new Error(
						`Invalid phase transition: cannot move from "${currentPhase}" to "${targetPhase}". ` +
							`Phases must follow logical sequence: planning → execution → verification → review → merge`,
					);
				}
			}
		} else if (transitionType === "end") {
			// Validate that a phase is currently active
			if (!currentPhase || !phaseStartTime) {
				throw new Error(
					`Cannot end phase "${targetPhase}": no phase is currently active. Call phaseStart() before calling phaseEnd().`,
				);
			}

			// Validate that the phase being ended matches the current phase
			if (currentPhase !== targetPhase) {
				throw new Error(
					`Cannot end phase "${targetPhase}": current phase is "${currentPhase}". ` +
						`Phase mismatch detected. Ensure you end the correct phase.`,
				);
			}
		}
	}

	/**
	 * Start timing a phase. Automatically ends the previous phase if one is active.
	 */
	startPhase(phase: "planning" | "execution" | "verification" | "review" | "merge"): void {
		// End previous phase if active
		if (this.currentPhase && this.phaseStartTime) {
			this.endPhase();
		}
		this.currentPhase = phase;
		this.phaseStartTime = Date.now();
	}

	/**
	 * End the current phase and record its duration
	 */
	endPhase(): void {
		if (!this.currentPhase || !this.phaseStartTime) {
			return;
		}
		const duration = Date.now() - this.phaseStartTime;
		const key = `${this.currentPhase}Ms` as keyof typeof this.phaseTiming;
		// Accumulate if phase runs multiple times (e.g., multiple verification passes)
		this.phaseTiming[key] = (this.phaseTiming[key] || 0) + duration;
		this.phaseStartTime = undefined;
		this.currentPhase = undefined;
	}

	/**
	 * Start timing a phase with validation for logical phase transitions.
	 * Automatically ends the previous phase if one is active.
	 * Validates that phase transitions follow a logical sequence.
	 *
	 * Valid phase transition sequences:
	 * - planning → execution → verification → review → merge
	 * - Phases can be skipped (e.g., planning → execution → verification → merge)
	 * - Phases can repeat (e.g., verification can run multiple times)
	 *
	 * @param phase - The phase to start timing ("planning" | "execution" | "verification" | "review" | "merge")
	 * @throws {Error} If phase transition is invalid (e.g., trying to go backwards in the sequence)
	 *
	 * @example
	 * ```typescript
	 * const tracker = new MetricsTracker();
	 * tracker.startTask("task-123", "Fix bug", "session-456", "sonnet");
	 * tracker.phaseStart("planning");
	 * // ... planning work ...
	 * tracker.phaseEnd("planning");
	 * tracker.phaseStart("execution");
	 * // ... execution work ...
	 * tracker.phaseEnd("execution");
	 * ```
	 */
	phaseStart(phase: "planning" | "execution" | "verification" | "review" | "merge"): void {
		// Validate phase transition
		this.validatePhaseTransition("start", phase, this.currentPhase, this.phaseStartTime);

		// End previous phase if active and transitioning to a new phase
		if (this.currentPhase && this.phaseStartTime && this.currentPhase !== phase) {
			this.endPhase();
		}

		this.currentPhase = phase;
		this.phaseStartTime = Date.now();
	}

	/**
	 * End the current phase and record its duration with validation.
	 * Validates that a phase is currently active before ending it.
	 *
	 * @param phase - The phase to end (must match the currently active phase)
	 * @throws {Error} If no phase is currently active or if the specified phase doesn't match the current phase
	 *
	 * @example
	 * ```typescript
	 * const tracker = new MetricsTracker();
	 * tracker.startTask("task-123", "Fix bug", "session-456", "sonnet");
	 * tracker.phaseStart("planning");
	 * // ... planning work ...
	 * tracker.phaseEnd("planning"); // Records planning duration
	 *
	 * // Error case:
	 * tracker.phaseStart("execution");
	 * tracker.phaseEnd("planning"); // Throws error: phase mismatch
	 * ```
	 */
	phaseEnd(phase: "planning" | "execution" | "verification" | "review" | "merge"): void {
		// Validate phase transition
		this.validatePhaseTransition("end", phase, this.currentPhase, this.phaseStartTime);

		// Calculate duration and record
		const duration = Date.now() - (this.phaseStartTime as number);
		const key = `${this.currentPhase}Ms` as keyof typeof this.phaseTiming;

		// Accumulate if phase runs multiple times (e.g., multiple verification passes)
		this.phaseTiming[key] = (this.phaseTiming[key] || 0) + duration;

		this.phaseStartTime = undefined;
		this.currentPhase = undefined;
	}

	/**
	 * Get current phase timing data
	 */
	getPhaseTiming(): typeof this.phaseTiming {
		return { ...this.phaseTiming };
	}

	/**
	 * Record phase timings from an external source (e.g., worker phaseTimings object)
	 * Maps common phase names to the standard phaseTiming format
	 */
	recordPhaseTimings(timings: Record<string, number>): void {
		// Map worker phase names to standard names
		if (timings.contextPrep !== undefined) {
			this.phaseTiming.planningMs = (this.phaseTiming.planningMs || 0) + timings.contextPrep;
		}
		if (timings.planning !== undefined) {
			this.phaseTiming.planningMs = (this.phaseTiming.planningMs || 0) + timings.planning;
		}
		if (timings.agentExecution !== undefined) {
			this.phaseTiming.executionMs = (this.phaseTiming.executionMs || 0) + timings.agentExecution;
		}
		if (timings.execution !== undefined) {
			this.phaseTiming.executionMs = (this.phaseTiming.executionMs || 0) + timings.execution;
		}
		if (timings.verification !== undefined) {
			this.phaseTiming.verificationMs = (this.phaseTiming.verificationMs || 0) + timings.verification;
		}
		if (timings.review !== undefined) {
			this.phaseTiming.reviewMs = (this.phaseTiming.reviewMs || 0) + timings.review;
		}
		if (timings.merge !== undefined) {
			this.phaseTiming.mergeMs = (this.phaseTiming.mergeMs || 0) + timings.merge;
		}
	}

	/**
	 * Extract token usage from Claude SDK message
	 */
	extractTokenUsage(message: unknown): TokenUsage | null {
		// Handle different Claude SDK message formats
		if (!message || typeof message !== "object") {
			return null;
		}

		const msg = message as SdkMessage;

		// Try different property paths based on SDK version
		let inputTokens = 0;
		let outputTokens = 0;

		// Common patterns in Claude SDK responses
		if (msg.usage) {
			inputTokens = msg.usage.input_tokens || msg.usage.inputTokens || 0;
			outputTokens = msg.usage.output_tokens || msg.usage.outputTokens || 0;
		} else if (msg.metadata?.usage) {
			inputTokens = msg.metadata.usage.input_tokens || msg.metadata.usage.inputTokens || 0;
			outputTokens = msg.metadata.usage.output_tokens || msg.metadata.usage.outputTokens || 0;
		} else if (msg.meta?.usage) {
			inputTokens = msg.meta.usage.input_tokens || msg.meta.usage.inputTokens || 0;
			outputTokens = msg.meta.usage.output_tokens || msg.meta.usage.outputTokens || 0;
		} else if (msg.inputTokens !== undefined && msg.outputTokens !== undefined) {
			inputTokens = msg.inputTokens;
			outputTokens = msg.outputTokens;
		} else if (msg.input_tokens !== undefined && msg.output_tokens !== undefined) {
			inputTokens = msg.input_tokens;
			outputTokens = msg.output_tokens;
		}

		if (inputTokens === 0 && outputTokens === 0) {
			return null;
		}

		const totalTokens = inputTokens + outputTokens;

		return {
			inputTokens,
			outputTokens,
			totalTokens,
			sonnetEquivalentTokens: totalTokens, // Will be recalculated based on model
		};
	}

	/**
	 * Record token usage from Claude SDK message
	 */
	recordTokenUsage(message: unknown, model?: "haiku" | "sonnet" | "opus"): void {
		const usage = this.extractTokenUsage(message);
		if (!usage) {
			return;
		}

		this.totalTokens += usage.totalTokens;

		// Record in rate limit tracker if we have enough info
		if (this.taskId && model) {
			this.rateLimitTracker.recordTask(this.taskId, model, usage.inputTokens, usage.outputTokens, {
				sessionId: this.sessionId,
				timestamp: new Date(),
			});
		}
	}

	/**
	 * Record a 429 rate limit hit
	 */
	recordRateLimitHit(
		model: "haiku" | "sonnet" | "opus",
		error?: Error | string,
		responseHeaders?: Record<string, string>,
	): void {
		const errorMessage = typeof error === "string" ? error : error?.message;
		this.rateLimitTracker.recordRateLimitHit(model, errorMessage, responseHeaders);
	}

	/**
	 * Record task failure
	 */
	recordTaskFailure(error: string): void {
		this.currentError = error;
	}

	/**
	 * Complete task tracking and return metrics
	 */
	completeTask(success: boolean): TaskMetrics | null {
		if (!this.taskStartTime || !this.taskId || !this.sessionId || !this.objective) {
			return null;
		}

		const completedAt = new Date();
		const durationMs = completedAt.getTime() - this.taskStartTime.getTime();

		const metrics: TaskMetrics = {
			taskId: this.taskId,
			sessionId: this.sessionId,
			objective: this.objective,
			success,
			durationMs,
			totalTokens: this.totalTokens,
			agentsSpawned: this.agentsSpawned,
			agentTypes: [...this.agentTypes],
			startedAt: this.taskStartTime,
			completedAt,
			error: this.currentError,
			// Include attempt records for model escalation analysis
			attempts: this.attempts.length > 0 ? [...this.attempts] : undefined,
			finalModel: this.finalModel,
			// Complexity and escalation tracking
			complexityLevel: this.complexityLevel,
			wasEscalated: this.wasEscalated,
			startingModel: this.startingModel,
			source: this.source,
			// Effectiveness tracking
			injectedLearningIds: this.injectedLearningIds.length > 0 ? [...this.injectedLearningIds] : undefined,
			predictedFiles: this.predictedFiles.length > 0 ? [...this.predictedFiles] : undefined,
			actualFilesModified: this.actualFilesModified.length > 0 ? [...this.actualFilesModified] : undefined,
			reviewStats: this.reviewStats,
			// Additional effectiveness tracking
			ragSearches: this.ragSearches.length > 0 ? [...this.ragSearches] : undefined,
			recommendedModel: this.recommendedModel,
			classifierPrediction: this.classifierPrediction,
			// Throughput tracking
			linesChanged: this.linesChanged,
			filesChanged: this.filesChanged,
			// Phase timing
			phaseTiming: Object.keys(this.phaseTiming).length > 0 ? { ...this.phaseTiming } : undefined,
		};

		// Log metrics to file asynchronously, without blocking
		logMetricsToFile(metrics).catch(console.error);

		return metrics;
	}

	/**
	 * Get rate limit tracker instance for external use
	 */
	getRateLimitTracker(): RateLimitTracker {
		return this.rateLimitTracker;
	}

	/**
	 * Get rate limit usage summary
	 */
	getRateLimitSummary(): ReturnType<RateLimitTracker["getUsageSummary"]> {
		return this.rateLimitTracker.getUsageSummary();
	}

	/**
	 * Generate rate limit usage report
	 */
	generateRateLimitReport(): string {
		return this.rateLimitTracker.generateReport();
	}

	/**
	 * Calculate efficiency analytics from historical metrics
	 */
	static calculateAnalytics(taskMetrics: TaskMetrics[]): EfficiencyAnalytics {
		if (taskMetrics.length === 0) {
			return {
				totalTasks: 0,
				successRate: 0,
				avgTokensPerCompletion: 0,
				avgDurationMs: 0,
				avgAgentsSpawned: 0,
				mostEfficientAgentType: null,
				tokensByAgentType: {} as Record<AgentType, { total: number; avgPerTask: number }>,
				successRateByComplexity: {
					trivial: {
						rate: 0,
						totalTasks: 0,
						avgTokensPerTask: 0,
						escalationTrigger: 0,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					simple: {
						rate: 0,
						totalTasks: 0,
						avgTokensPerTask: 0,
						escalationTrigger: 0.1,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					standard: {
						rate: 0,
						totalTasks: 0,
						avgTokensPerTask: 0,
						escalationTrigger: 0.3,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					complex: {
						rate: 0,
						totalTasks: 0,
						avgTokensPerTask: 0,
						escalationTrigger: 0.5,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					critical: {
						rate: 0,
						totalTasks: 0,
						avgTokensPerTask: 0,
						escalationTrigger: 0.8,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
				},
				analysisPeriod: {
					from: new Date(),
					to: new Date(),
				},
			};
		}

		const completedTasks = taskMetrics.filter((m) => m.success);
		const totalTasks = taskMetrics.length;
		const successRate = (completedTasks.length / totalTasks) * 100;

		// Calculate complexity breakdowns with escalation tracking
		const complexityBreakdown: Record<
			string,
			{
				totalTasks: number;
				successfulTasks: number;
				totalTokens: number;
				escalatedCount: number;
				escalatedSuccessful: number;
				escalatedTokens: number;
				nonEscalatedTokens: number;
			}
		> = {
			trivial: {
				totalTasks: 0,
				successfulTasks: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			simple: {
				totalTasks: 0,
				successfulTasks: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			standard: {
				totalTasks: 0,
				successfulTasks: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			complex: {
				totalTasks: 0,
				successfulTasks: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			critical: {
				totalTasks: 0,
				successfulTasks: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
		};

		// Calculate averages from completed tasks only
		const avgTokensPerCompletion =
			completedTasks.length > 0 ? completedTasks.reduce((sum, m) => sum + m.totalTokens, 0) / completedTasks.length : 0;

		const avgDurationMs =
			taskMetrics.length > 0 ? taskMetrics.reduce((sum, m) => sum + m.durationMs, 0) / taskMetrics.length : 0;

		const avgAgentsSpawned =
			taskMetrics.length > 0 ? taskMetrics.reduce((sum, m) => sum + m.agentsSpawned, 0) / taskMetrics.length : 0;

		// Calculate tokens by agent type
		const tokensByAgentType: Record<AgentType, { total: number; avgPerTask: number }> = {
			scout: { total: 0, avgPerTask: 0 },
			planner: { total: 0, avgPerTask: 0 },
			builder: { total: 0, avgPerTask: 0 },
			reviewer: { total: 0, avgPerTask: 0 },
		};

		const agentTypeTasks: Record<AgentType, number> = {
			scout: 0,
			planner: 0,
			builder: 0,
			reviewer: 0,
		};

		// Process metrics for different dimensions
		for (const metrics of taskMetrics) {
			// Use stored complexity if available, otherwise assess from objective
			const complexity = metrics.complexityLevel ?? assessComplexityFast(metrics.objective).level;
			const complexityData = complexityBreakdown[complexity];
			complexityData.totalTasks++;
			complexityData.totalTokens += metrics.totalTokens;

			if (metrics.success) {
				complexityData.successfulTasks++;
			}

			// Track escalation data per complexity level
			if (metrics.wasEscalated) {
				complexityData.escalatedCount++;
				complexityData.escalatedTokens += metrics.totalTokens;
				if (metrics.success) {
					complexityData.escalatedSuccessful++;
				}
			} else {
				complexityData.nonEscalatedTokens += metrics.totalTokens;
			}

			// Agent type tracking
			if (metrics.agentTypes && Array.isArray(metrics.agentTypes)) {
				for (const agentType of metrics.agentTypes) {
					tokensByAgentType[agentType].total += metrics.totalTokens;
					agentTypeTasks[agentType]++;
				}
			}
		}

		// Calculate agent type averages
		for (const agentType of Object.keys(tokensByAgentType) as AgentType[]) {
			const taskCount = agentTypeTasks[agentType];
			if (taskCount > 0) {
				tokensByAgentType[agentType].avgPerTask = tokensByAgentType[agentType].total / taskCount;
			}
		}

		// Find most efficient agent type (lowest tokens per completion)
		let mostEfficientAgentType: AgentType | null = null;
		let lowestTokensPerCompletion = Infinity;

		for (const [agentType, stats] of Object.entries(tokensByAgentType)) {
			if (stats.avgPerTask > 0 && stats.avgPerTask < lowestTokensPerCompletion) {
				lowestTokensPerCompletion = stats.avgPerTask;
				mostEfficientAgentType = agentType as AgentType;
			}
		}

		// Compute complexity-level success rates and metrics with escalation data
		const successRateByComplexity = Object.entries(complexityBreakdown).reduce(
			(acc, [complexity, data]) => {
				// Calculate escalation success rate
				const escalationSuccessRate =
					data.escalatedCount > 0 ? (data.escalatedSuccessful / data.escalatedCount) * 100 : 0;

				// Calculate token overhead from escalation
				// Compare average tokens for escalated vs non-escalated tasks
				const nonEscalatedCount = data.totalTasks - data.escalatedCount;
				const avgEscalatedTokens = data.escalatedCount > 0 ? data.escalatedTokens / data.escalatedCount : 0;
				const avgNonEscalatedTokens = nonEscalatedCount > 0 ? data.nonEscalatedTokens / nonEscalatedCount : 0;
				const escalationTokenOverhead =
					avgNonEscalatedTokens > 0 ? avgEscalatedTokens - avgNonEscalatedTokens : avgEscalatedTokens;

				acc[complexity as ComplexityLevel] = {
					rate: data.totalTasks > 0 ? (data.successfulTasks / data.totalTasks) * 100 : 0,
					totalTasks: data.totalTasks,
					avgTokensPerTask: data.totalTasks > 0 ? data.totalTokens / data.totalTasks : 0,
					// Escalation trigger - more aggressive for higher complexity levels
					escalationTrigger:
						complexity === "trivial"
							? 0
							: complexity === "simple"
								? 0.1
								: complexity === "standard"
									? 0.3
									: complexity === "complex"
										? 0.5
										: 0.8,
					// New escalation tracking fields
					escalatedCount: data.escalatedCount,
					escalationSuccessRate,
					escalationTokenOverhead,
				};
				return acc;
			},
			{} as Record<
				ComplexityLevel,
				{
					rate: number;
					totalTasks: number;
					avgTokensPerTask: number;
					escalationTrigger: number;
					escalatedCount: number;
					escalationSuccessRate: number;
					escalationTokenOverhead: number;
				}
			>,
		);

		// Analysis period
		const dates = taskMetrics
			.map((m) => m.startedAt)
			.filter((d) => d)
			.map((d) => (d instanceof Date ? d : new Date(d)))
			.filter((d) => !Number.isNaN(d.getTime()));

		const analysisPeriod =
			dates.length > 0
				? {
						from: new Date(Math.min(...dates.map((d) => d.getTime()))),
						to: new Date(Math.max(...dates.map((d) => d.getTime()))),
					}
				: {
						from: new Date(),
						to: new Date(),
					};

		return {
			totalTasks,
			successRate,
			avgTokensPerCompletion,
			avgDurationMs,
			avgAgentsSpawned,
			mostEfficientAgentType,
			tokensByAgentType,
			successRateByComplexity,
			analysisPeriod,
		};
	}
}

/**
 * Load all task metrics from the JSONL file
 *
 * Reads and parses task metrics from the `.undercity/metrics.jsonl` file.
 * Each line in the file represents a single task execution with complete metrics.
 * Date strings are automatically converted back to Date objects.
 *
 * @returns Promise resolving to array of TaskMetrics objects, or empty array if file doesn't exist
 *
 * @example
 * ```typescript
 * const metrics = await loadTaskMetrics();
 * console.log(`Loaded ${metrics.length} task records`);
 * const successRate = metrics.filter(m => m.success).length / metrics.length;
 * ```
 */
export async function loadTaskMetrics(): Promise<TaskMetrics[]> {
	try {
		const fileContent = await fs.readFile(METRICS_FILE, "utf-8");
		const lines = fileContent.trim().split("\n");
		const metrics: TaskMetrics[] = [];

		for (const line of lines) {
			if (line.trim()) {
				try {
					const parsed = JSON.parse(line);
					// Convert date strings back to Date objects and set defaults for missing fields
					if (parsed.timestamp) {
						parsed.timestamp = new Date(parsed.timestamp);
					}
					if (parsed.startedAt) {
						parsed.startedAt = new Date(parsed.startedAt);
					}
					if (parsed.completedAt) {
						parsed.completedAt = new Date(parsed.completedAt);
					}
					// Ensure required fields exist with defaults
					parsed.agentTypes = parsed.agentTypes || [];
					parsed.objective = parsed.objective || "";
					parsed.success = parsed.success ?? false;
					parsed.totalTokens = parsed.totalTokens || 0;
					parsed.durationMs = parsed.durationMs || 0;
					parsed.agentsSpawned = parsed.agentsSpawned || 0;

					metrics.push(parsed);
				} catch (parseError) {
					console.warn("Skipping malformed metrics line:", parseError);
				}
			}
		}

		return metrics;
	} catch (_error) {
		// File doesn't exist or can't be read
		return [];
	}
}

/**
 * Generate efficiency analytics from stored metrics
 *
 * Computes comprehensive analytics including success rates, average token usage,
 * duration statistics, agent efficiency metrics, and complexity-level breakdowns
 * with escalation tracking. Uses all metrics stored in the JSONL file.
 *
 * @returns Promise resolving to EfficiencyAnalytics object containing all computed metrics
 *
 * @example
 * ```typescript
 * const analytics = await generateEfficiencyAnalytics();
 * console.log(`Success rate: ${analytics.successRate}%`);
 * console.log(`Avg tokens per completion: ${analytics.avgTokensPerCompletion}`);
 * console.log(`Most efficient agent: ${analytics.mostEfficientAgentType}`);
 * console.log(`Complex tasks success rate: ${analytics.successRateByComplexity.complex.rate}%`);
 * ```
 */
export async function generateEfficiencyAnalytics(): Promise<EfficiencyAnalytics> {
	const taskMetrics = await loadTaskMetrics();
	return MetricsTracker.calculateAnalytics(taskMetrics);
}

/**
 * Summary of metrics for quick overview
 */
export interface MetricsSummary {
	totalTasks: number;
	successRate: number;
	avgTokens: number;
	modelDistribution: Record<string, number>;
	avgTimeTakenMs: number;
	escalationRate: number;
}

/**
 * Get a summary of task metrics
 *
 * Provides a high-level overview of task execution including total tasks,
 * success rate, average token usage, model distribution, average duration,
 * and escalation rate. Replaces MetricsCollector.getMetricsSummary().
 *
 * @returns Promise resolving to MetricsSummary object with aggregated metrics
 *
 * @example
 * ```typescript
 * const summary = await getMetricsSummary();
 * console.log(`Total tasks: ${summary.totalTasks}`);
 * console.log(`Success rate: ${(summary.successRate * 100).toFixed(1)}%`);
 * console.log(`Avg tokens: ${summary.avgTokens.toFixed(0)}`);
 * console.log(`Escalation rate: ${(summary.escalationRate * 100).toFixed(1)}%`);
 * console.log(`Model distribution:`, summary.modelDistribution);
 * ```
 */
export async function getMetricsSummary(): Promise<MetricsSummary> {
	const metrics = await loadTaskMetrics();

	if (metrics.length === 0) {
		return {
			totalTasks: 0,
			successRate: 0,
			avgTokens: 0,
			modelDistribution: {},
			avgTimeTakenMs: 0,
			escalationRate: 0,
		};
	}

	const totalTasks = metrics.length;
	const successfulTasks = metrics.filter((m) => m.success).length;
	const successRate = successfulTasks / totalTasks;

	const totalTokens = metrics.reduce((sum, m) => sum + (m.totalTokens || 0), 0);
	const avgTokens = totalTokens / totalTasks;

	const modelDistribution = metrics.reduce(
		(dist, m) => {
			const model = m.finalModel || "unknown";
			dist[model] = (dist[model] || 0) + 1;
			return dist;
		},
		{} as Record<string, number>,
	);

	const totalTime = metrics.reduce((sum, m) => sum + (m.durationMs || 0), 0);
	const avgTimeTakenMs = totalTime / totalTasks;

	const escalatedTasks = metrics.filter((m) => m.wasEscalated).length;
	const escalationRate = escalatedTasks / totalTasks;

	return {
		totalTasks,
		successRate,
		avgTokens,
		modelDistribution,
		avgTimeTakenMs,
		escalationRate,
	};
}

/**
 * Get escalation analysis from metrics
 *
 * Analyzes model escalation patterns including total escalations, escalation paths
 * (e.g., sonnet → opus), success rates after escalation, and common reasons that
 * triggered escalations. Replaces EnhancedMetricsQuery.getEscalationAnalysis().
 *
 * @returns Promise resolving to object containing escalation analysis data
 *
 * @example
 * ```typescript
 * const analysis = await getEscalationAnalysis();
 * console.log(`Total escalations: ${analysis.totalEscalations}`);
 * console.log(`Escalation success rate: ${(analysis.escalationSuccessRate * 100).toFixed(1)}%`);
 * console.log(`Escalation paths:`, analysis.escalationsByModel);
 * console.log(`Top reasons:`, analysis.commonEscalationReasons.slice(0, 3));
 * ```
 */
export async function getEscalationAnalysis(): Promise<{
	totalEscalations: number;
	escalationsByModel: Record<string, number>;
	escalationSuccessRate: number;
	averageTokensSaved: number;
	commonEscalationReasons: Array<{ reason: string; count: number }>;
}> {
	const metrics = await loadTaskMetrics();

	const escalatedMetrics = metrics.filter((m) => m.wasEscalated);
	const escalationReasons: Record<string, number> = {};
	const escalationsByModel: Record<string, number> = {};
	let successfulEscalations = 0;

	for (const metric of escalatedMetrics) {
		// Track escalation path
		if (metric.startingModel && metric.finalModel && metric.startingModel !== metric.finalModel) {
			const key = `${metric.startingModel} → ${metric.finalModel}`;
			escalationsByModel[key] = (escalationsByModel[key] || 0) + 1;
		}

		// Track reasons from attempts (using errorCategories if available)
		if (metric.attempts) {
			for (const attempt of metric.attempts) {
				if (!attempt.success && attempt.errorCategories) {
					for (const category of attempt.errorCategories) {
						escalationReasons[category] = (escalationReasons[category] || 0) + 1;
					}
				}
			}
		}

		if (metric.success) {
			successfulEscalations++;
		}
	}

	const commonReasons = Object.entries(escalationReasons)
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 10);

	return {
		totalEscalations: escalatedMetrics.length,
		escalationsByModel,
		escalationSuccessRate: escalatedMetrics.length > 0 ? successfulEscalations / escalatedMetrics.length : 0,
		averageTokensSaved: 0, // Not tracked in current schema
		commonEscalationReasons: commonReasons,
	};
}

/**
 * Get token usage trends over time
 *
 * Analyzes token usage patterns over a specified time period, breaking down
 * usage by model (haiku, sonnet, opus) and by day. Provides insights into
 * token consumption trends and daily task volume. Replaces EnhancedMetricsQuery.getTokenUsageTrends().
 *
 * @param days - Number of days to look back (default: 30)
 * @returns Promise resolving to object containing token usage trends and daily breakdowns
 *
 * @example
 * ```typescript
 * const trends = await getTokenUsageTrends(7); // Last 7 days
 * console.log(`Total tokens (7 days): ${trends.totalTokens}`);
 * console.log(`Sonnet tokens: ${trends.tokensByModel.sonnet}`);
 * console.log(`Opus tokens: ${trends.tokensByModel.opus}`);
 * console.log(`Daily breakdown:`, trends.dailyUsage);
 * // Example dailyUsage: [{ date: "2024-01-15", tokens: 45000, tasks: 12 }, ...]
 * ```
 */
export async function getTokenUsageTrends(days = 30): Promise<{
	totalTokens: number;
	tokensByModel: Record<"haiku" | "sonnet" | "opus", number>;
	tokensByPhase: Record<string, number>;
	averageEfficiencyRatio: number;
	dailyUsage: Array<{ date: string; tokens: number; tasks: number }>;
}> {
	const metrics = await loadTaskMetrics();

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - days);

	const recentMetrics = metrics.filter((m) => m.startedAt && new Date(m.startedAt) >= cutoffDate);

	const tokensByModel: Record<"haiku" | "sonnet" | "opus", number> = {
		sonnet: 0,
		opus: 0,
		haiku: 0,
	};

	let totalTokens = 0;
	const dailyMap: Record<string, { tokens: number; tasks: number }> = {};

	for (const metric of recentMetrics) {
		totalTokens += metric.totalTokens || 0;

		// Assign tokens to final model
		if (metric.finalModel && tokensByModel[metric.finalModel] !== undefined) {
			tokensByModel[metric.finalModel] += metric.totalTokens || 0;
		}

		// Track daily usage
		if (metric.startedAt) {
			const date = new Date(metric.startedAt).toISOString().split("T")[0];
			if (!dailyMap[date]) {
				dailyMap[date] = { tokens: 0, tasks: 0 };
			}
			dailyMap[date].tokens += metric.totalTokens || 0;
			dailyMap[date].tasks += 1;
		}
	}

	const dailyUsage = Object.entries(dailyMap)
		.map(([date, data]) => ({ date, ...data }))
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		totalTokens,
		tokensByModel,
		tokensByPhase: {}, // Not tracked in current schema
		averageEfficiencyRatio: 1, // Not tracked in current schema
		dailyUsage,
	};
}

/**
 * Phase timing summary for performance analysis
 */
export interface PhaseTimingSummary {
	/** Total tasks with phase timing data */
	tasksWithData: number;
	/** Average time in each phase (milliseconds) */
	averageMs: {
		planning?: number;
		execution?: number;
		verification?: number;
		review?: number;
		merge?: number;
	};
	/** Percentage of total time spent in each phase */
	percentages: {
		planning?: number;
		execution?: number;
		verification?: number;
		review?: number;
		merge?: number;
	};
	/** Total average task duration */
	avgTotalMs: number;
}

/**
 * Get phase timing summary from recent task metrics
 *
 * Aggregates phase timing data across tasks to show where time is spent.
 *
 * @param limit - Maximum number of recent tasks to analyze (default: 50)
 * @returns Promise resolving to PhaseTimingSummary
 *
 * @example
 * ```typescript
 * const timing = await getPhaseTimingSummary();
 * console.log(`Avg execution: ${timing.averageMs.execution}ms (${timing.percentages.execution}%)`);
 * ```
 */
export async function getPhaseTimingSummary(limit = 50): Promise<PhaseTimingSummary> {
	const metrics = await loadTaskMetrics();

	// Get recent metrics with phase timing data
	const withTiming = metrics.filter((m) => m.phaseTiming && Object.keys(m.phaseTiming).length > 0).slice(-limit);

	if (withTiming.length === 0) {
		return {
			tasksWithData: 0,
			averageMs: {},
			percentages: {},
			avgTotalMs: 0,
		};
	}

	// Aggregate phase times
	const totals: Record<string, number> = {};
	const counts: Record<string, number> = {};

	for (const metric of withTiming) {
		const timing = metric.phaseTiming;
		if (!timing) continue;

		for (const [phase, ms] of Object.entries(timing)) {
			if (typeof ms === "number" && ms > 0) {
				totals[phase] = (totals[phase] || 0) + ms;
				counts[phase] = (counts[phase] || 0) + 1;
			}
		}
	}

	// Calculate averages
	const averageMs: Record<string, number> = {};
	for (const phase of Object.keys(totals)) {
		averageMs[phase] = Math.round(totals[phase] / counts[phase]);
	}

	// Calculate total and percentages
	const totalAvgMs = Object.values(averageMs).reduce((sum, ms) => sum + ms, 0);
	const percentages: Record<string, number> = {};
	for (const [phase, ms] of Object.entries(averageMs)) {
		percentages[phase] = totalAvgMs > 0 ? Math.round((ms / totalAvgMs) * 100) : 0;
	}

	return {
		tasksWithData: withTiming.length,
		averageMs: averageMs as PhaseTimingSummary["averageMs"],
		percentages: percentages as PhaseTimingSummary["percentages"],
		avgTotalMs: totalAvgMs,
	};
}
