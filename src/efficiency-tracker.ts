/**
 * Efficiency Tracker
 *
 * Tracks real-time efficiency metrics during quest execution for A/B testing.
 * Monitors first-order vs second-order token usage, rework attempts, and user interventions.
 */

import type {
	AgentType,
	EfficiencyOutcome,
	FirstOrderEfficiency,
	LoadoutModelChoices,
	ModelChoice,
	ParallelismLevel,
	ReworkAttempt,
	SecondOrderEfficiency,
	UserIntervention,
} from "./types.js";

/**
 * Real-time efficiency tracker for quest execution
 */
export class EfficiencyTracker {
	private questId: string;
	private raidId: string;
	private objective: string;
	private parallelismLevel: ParallelismLevel;
	private modelChoices: LoadoutModelChoices;
	private modelSuccessRates: Record<ModelChoice, { attempts: number; successes: number }> = {
		haiku: { attempts: 0, successes: 0 },
		sonnet: { attempts: 0, successes: 0 },
		opus: { attempts: 0, successes: 0 },
	};
	private experimentId?: string;
	private variantName?: string;

	// Timing tracking
	private questStartTime: Date;
	private firstSuccessTime?: Date;
	private stableCompletionTime?: Date;

	// Token tracking
	private firstOrderTokens = 0;
	private totalTokens = 0;
	private firstAttemptSuccessful = false;

	// Rework and intervention tracking
	private reworkAttempts: ReworkAttempt[] = [];
	private userInterventions: UserIntervention[] = [];
	private agentsUsed: Set<AgentType> = new Set();

	// State tracking
	private questCompleted = false;
	private questSuccessful = false;
	private isTrackingFirstAttempt = true;

	constructor(
		questId: string,
		raidId: string,
		objective: string,
		parallelismLevel: ParallelismLevel,
		modelChoices: LoadoutModelChoices,
		experimentId?: string,
		variantName?: string,
	) {
		this.questId = questId;
		this.raidId = raidId;
		this.objective = objective;
		this.parallelismLevel = parallelismLevel;
		this.modelChoices = modelChoices;
		this.experimentId = experimentId;
		this.variantName = variantName;
		this.questStartTime = new Date();
	}

	/**
	 * Record agent activity
	 */
	recordAgentActivity(agentType: AgentType): void {
		this.agentsUsed.add(agentType);
	}

	/**
	 * Record token usage from agent activity
	 */
	recordTokenUsage(tokens: number, agentType?: AgentType): void {
		this.totalTokens += tokens;

		// Track first-order tokens (before any rework)
		if (this.isTrackingFirstAttempt) {
			this.firstOrderTokens += tokens;
		}

		if (agentType) {
			this.agentsUsed.add(agentType);
		}
	}

	/**
	 * Record first attempt completion (success or failure)
	 */
	recordFirstAttemptCompletion(successful: boolean): void {
		if (this.firstSuccessTime) return; // Already recorded

		this.firstSuccessTime = new Date();
		this.firstAttemptSuccessful = successful;
		this.isTrackingFirstAttempt = false;
	}

	/**
	 * Record a rework attempt
	 */
	recordReworkAttempt(reason: string, agentType: AgentType, tokensUsed: number, successful: boolean): void {
		const rework: ReworkAttempt = {
			timestamp: new Date(),
			reason,
			agentType,
			tokensUsed,
			successful,
		};

		this.reworkAttempts.push(rework);
		this.totalTokens += tokensUsed;
		this.agentsUsed.add(agentType);
	}

	/**
	 * Record a user intervention
	 */
	recordUserIntervention(type: UserIntervention["type"], description: string, timeSpentMs: number): void {
		const intervention: UserIntervention = {
			timestamp: new Date(),
			type,
			description,
			timeSpentMs,
		};

		this.userInterventions.push(intervention);
	}

	/**
	 * Mark quest as completed and stable
	 */
	recordStableCompletion(successful: boolean): void {
		if (this.questCompleted) return; // Already recorded

		this.stableCompletionTime = new Date();
		this.questCompleted = true;
		this.questSuccessful = successful;

		// Update model success rates
		const modelChoice = this.determineModelChoice();
		if (modelChoice) {
			this.modelSuccessRates[modelChoice].attempts++;
			if (successful) {
				this.modelSuccessRates[modelChoice].successes++;
			}
		}

		// If this is the first completion, also record it as first attempt
		if (!this.firstSuccessTime) {
			this.recordFirstAttemptCompletion(successful);
		}
	}

	/**
	 * Determines the primary model choice based on most tokens used
	 */
	private determineModelChoice(): ModelChoice | null {
		const modelTokens: Record<ModelChoice, number> = {
			haiku: 0,
			sonnet: 0,
			opus: 0,
		};

		this.reworkAttempts.forEach((attempt) => {
			modelTokens[this.modelChoices[attempt.agentType]] += attempt.tokensUsed;
		});

		let primaryModel: ModelChoice | null = null;
		let maxTokens = 0;

		(Object.keys(modelTokens) as ModelChoice[]).forEach((model) => {
			if (modelTokens[model] > maxTokens) {
				maxTokens = modelTokens[model];
				primaryModel = model;
			}
		});

		return primaryModel;
	}

	/**
	 * Get current model success rates
	 */
	getModelSuccessRates(): Record<ModelChoice, number> {
		const successRates: Record<ModelChoice, number> = {
			haiku: 0,
			sonnet: 0,
			opus: 0,
		};

		(Object.keys(this.modelSuccessRates) as ModelChoice[]).forEach((model) => {
			const { attempts, successes } = this.modelSuccessRates[model];
			successRates[model] = attempts > 0 ? successes / attempts : 0;
		});

		return successRates;
	}

	/**
	 * Get current first-order efficiency metrics
	 */
	getFirstOrderMetrics(): FirstOrderEfficiency {
		const timeToComplete = this.firstSuccessTime ? this.firstSuccessTime.getTime() - this.questStartTime.getTime() : 0;

		return {
			tokensUsed: this.firstOrderTokens,
			timeToComplete,
			successfulFirstAttempt: this.firstAttemptSuccessful,
		};
	}

	/**
	 * Get current second-order efficiency metrics
	 */
	getSecondOrderMetrics(): SecondOrderEfficiency {
		const totalTime = this.stableCompletionTime
			? this.stableCompletionTime.getTime() - this.questStartTime.getTime()
			: Date.now() - this.questStartTime.getTime();

		const timeToStableCompletion = this.stableCompletionTime
			? this.stableCompletionTime.getTime() - this.questStartTime.getTime()
			: 0;

		return {
			totalTokens: this.totalTokens,
			totalTime,
			reworkAttempts: this.reworkAttempts.length,
			userInterventions: this.userInterventions.length,
			timeToStableCompletion,
		};
	}

	/**
	 * Generate complete efficiency outcome
	 */
	generateOutcome(): EfficiencyOutcome {
		const outcome: EfficiencyOutcome = {
			id: `efficiency-${this.questId}-${Date.now()}`,
			questId: this.questId,
			raidId: this.raidId,
			experimentId: this.experimentId,
			variantName: this.variantName,
			parallelismLevel: this.parallelismLevel,
			objective: this.objective,
			firstOrder: this.getFirstOrderMetrics(),
			secondOrder: this.getSecondOrderMetrics(),
			agentsUsed: Array.from(this.agentsUsed),
			modelChoices: this.modelChoices,
			finalSuccess: this.questSuccessful,
			recordedAt: new Date(),
			// Track model success rates
			modelSuccessRates: this.getModelSuccessRates(),
		};

		return outcome;
	}

	/**
	 * Get current status for monitoring
	 */
	getStatus(): {
		questId: string;
		isCompleted: boolean;
		currentTokens: number;
		reworkCount: number;
		interventionCount: number;
		timeElapsed: number;
	} {
		return {
			questId: this.questId,
			isCompleted: this.questCompleted,
			currentTokens: this.totalTokens,
			reworkCount: this.reworkAttempts.length,
			interventionCount: this.userInterventions.length,
			timeElapsed: Date.now() - this.questStartTime.getTime(),
		};
	}

	/**
	 * Get detailed rework history
	 */
	getReworkHistory(): ReworkAttempt[] {
		return [...this.reworkAttempts];
	}

	/**
	 * Get detailed intervention history
	 */
	getInterventionHistory(): UserIntervention[] {
		return [...this.userInterventions];
	}

	/**
	 * Track routing prediction accuracy
	 */
	recordRoutingPrediction(
		prediction: string,
		actualTier: string,
		successful: boolean,
		timeToResolutionMs: number,
	): void {
		const routingIntervention: UserIntervention = {
			timestamp: new Date(),
			type: successful ? "clarification" : "direction_change",
			description: `Routing Prediction: Predicted '${prediction}', Actual Tier: '${actualTier}'`,
			timeSpentMs: timeToResolutionMs,
		};

		this.userInterventions.push(routingIntervention);
	}

	/**
	 * Calculate current efficiency ratio (first-order vs second-order)
	 */
	getEfficiencyRatio(): number {
		if (this.totalTokens === 0) return 1;
		return this.firstOrderTokens / this.totalTokens;
	}

	/**
	 * Check if quest is in rework phase
	 */
	isInRework(): boolean {
		return !this.isTrackingFirstAttempt && !this.questCompleted;
	}

	/**
	 * Get average tokens per rework attempt
	 */
	getAvgTokensPerRework(): number {
		if (this.reworkAttempts.length === 0) return 0;
		const reworkTokens = this.reworkAttempts.reduce((sum, r) => sum + r.tokensUsed, 0);
		return reworkTokens / this.reworkAttempts.length;
	}

	/**
	 * Get time distribution between phases
	 */
	getTimeDistribution(): {
		firstAttemptMs: number;
		reworkMs: number;
		totalMs: number;
	} {
		const now = Date.now();
		const startTime = this.questStartTime.getTime();
		const firstAttemptEnd = this.firstSuccessTime?.getTime() ?? now;
		const stableEnd = this.stableCompletionTime?.getTime() ?? now;

		return {
			firstAttemptMs: firstAttemptEnd - startTime,
			reworkMs: stableEnd - firstAttemptEnd,
			totalMs: stableEnd - startTime,
		};
	}

	/**
	 * Analyze overall performance metrics
	 */
	analyzeOverallPerformance(): {
		overallEfficiencyRatio: number;
		reworkRate: number;
		avgTokensPerRework: number;
		modelSuccessRates: Record<ModelChoice, number>;
		agentVariety: string[];
	} {
		return {
			overallEfficiencyRatio: this.getEfficiencyRatio(),
			reworkRate: this.reworkAttempts.length / (this.reworkAttempts.length + 1), // Normalize to handle 0 rework
			avgTokensPerRework: this.getAvgTokensPerRework(),
			modelSuccessRates: this.getModelSuccessRates(),
			agentVariety: Array.from(this.agentsUsed),
		};
	}
}
