/**
 * Efficiency Metrics Tracker
 *
 * Tracks token usage, execution time, and success metrics for quest completion analysis.
 * Provides tokens-per-completion ratios and historical analytics.
 */

import { persistenceLogger } from "./logger.js";
import type {
	AgentType,
	EfficiencyAnalytics,
	ExtendedStash,
	QuestMetrics,
	Raid,
	SquadMember,
	TokenUsage,
} from "./types.js";

const METRICS_VERSION = "1.0";

/**
 * Tracks efficiency metrics for quests and raids
 */
export class MetricsTracker {
	private questStartTime?: Date;
	private questId?: string;
	private raidId?: string;
	private objective?: string;
	private totalTokens: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
	};
	private agentsSpawned: number = 0;
	private agentTypes: Record<AgentType, number> = {
		scout: 0,
		planner: 0,
		fabricator: 0,
		auditor: 0,
	};
	private currentError?: string;

	constructor() {
		this.reset();
	}

	/**
	 * Reset tracking state for a new quest
	 */
	private reset(): void {
		this.questStartTime = undefined;
		this.questId = undefined;
		this.raidId = undefined;
		this.objective = undefined;
		this.totalTokens = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
		};
		this.agentsSpawned = 0;
		this.agentTypes = {
			scout: 0,
			planner: 0,
			fabricator: 0,
			auditor: 0,
		};
		this.currentError = undefined;
	}

	/**
	 * Start tracking a quest
	 */
	startQuest(questId: string, objective: string, raidId: string): void {
		this.reset();
		this.questStartTime = new Date();
		this.questId = questId;
		this.raidId = raidId;
		this.objective = objective;

		persistenceLogger.debug(
			{ questId, raidId, objective: objective.substring(0, 50) },
			"Started tracking quest metrics"
		);
	}

	/**
	 * Record agent spawn
	 */
	recordAgentSpawn(agentType: AgentType): void {
		if (!this.questStartTime) {
			persistenceLogger.warn("Attempted to record agent spawn without active quest tracking");
			return;
		}

		this.agentsSpawned++;
		this.agentTypes[agentType]++;

		persistenceLogger.debug(
			{ questId: this.questId, agentType, totalSpawned: this.agentsSpawned },
			"Recorded agent spawn"
		);
	}

	/**
	 * Extract token usage from Claude SDK message
	 */
	extractTokenUsage(message: unknown): TokenUsage | null {
		try {
			const msg = message as Record<string, unknown>;

			// Check for usage in message metadata
			if (msg.usage && typeof msg.usage === "object") {
				const usage = msg.usage as Record<string, unknown>;

				const tokenUsage: TokenUsage = {
					inputTokens: Number(usage.input_tokens || 0),
					outputTokens: Number(usage.output_tokens || 0),
					cacheCreationTokens: Number(usage.cache_creation_input_tokens || 0),
					cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
					totalTokens: 0,
				};

				// Calculate total
				tokenUsage.totalTokens =
					tokenUsage.inputTokens +
					tokenUsage.outputTokens +
					(tokenUsage.cacheCreationTokens || 0) +
					(tokenUsage.cacheReadTokens || 0);

				return tokenUsage.totalTokens > 0 ? tokenUsage : null;
			}

			// Check for usage in result messages
			if (msg.type === "result" && msg.usage && typeof msg.usage === "object") {
				const usage = msg.usage as Record<string, unknown>;

				const tokenUsage: TokenUsage = {
					inputTokens: Number(usage.input_tokens || 0),
					outputTokens: Number(usage.output_tokens || 0),
					cacheCreationTokens: Number(usage.cache_creation_input_tokens || 0),
					cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
					totalTokens: 0,
				};

				tokenUsage.totalTokens =
					tokenUsage.inputTokens +
					tokenUsage.outputTokens +
					(tokenUsage.cacheCreationTokens || 0) +
					(tokenUsage.cacheReadTokens || 0);

				return tokenUsage.totalTokens > 0 ? tokenUsage : null;
			}

			return null;
		} catch (error) {
			persistenceLogger.warn({ error }, "Error extracting token usage from message");
			return null;
		}
	}

	/**
	 * Record token usage from Claude SDK message
	 */
	recordTokenUsage(message: unknown): void {
		if (!this.questStartTime) {
			return; // Not tracking a quest
		}

		const usage = this.extractTokenUsage(message);
		if (usage) {
			this.totalTokens.inputTokens += usage.inputTokens;
			this.totalTokens.outputTokens += usage.outputTokens;
			this.totalTokens.cacheCreationTokens = (this.totalTokens.cacheCreationTokens || 0) + (usage.cacheCreationTokens || 0);
			this.totalTokens.cacheReadTokens = (this.totalTokens.cacheReadTokens || 0) + (usage.cacheReadTokens || 0);
			this.totalTokens.totalTokens += usage.totalTokens;

			persistenceLogger.debug(
				{
					questId: this.questId,
					currentUsage: usage.totalTokens,
					cumulativeUsage: this.totalTokens.totalTokens
				},
				"Recorded token usage"
			);
		}
	}

	/**
	 * Record quest failure
	 */
	recordQuestFailure(error: string): void {
		this.currentError = error;
		persistenceLogger.debug({ questId: this.questId, error }, "Recorded quest failure");
	}

	/**
	 * Complete quest tracking and return metrics
	 */
	completeQuest(success: boolean): QuestMetrics | null {
		if (!this.questStartTime || !this.questId || !this.raidId || !this.objective) {
			persistenceLogger.warn("Attempted to complete quest tracking without active tracking");
			return null;
		}

		const completedAt = new Date();
		const executionTimeMs = completedAt.getTime() - this.questStartTime.getTime();

		const metrics: QuestMetrics = {
			questId: this.questId,
			objective: this.objective,
			raidId: this.raidId,
			success,
			startedAt: this.questStartTime,
			completedAt,
			executionTimeMs,
			tokenUsage: { ...this.totalTokens },
			agentsSpawned: this.agentsSpawned,
			agentTypes: { ...this.agentTypes },
			error: success ? undefined : this.currentError,
		};

		persistenceLogger.info(
			{
				questId: this.questId,
				success,
				tokens: this.totalTokens.totalTokens,
				timeMinutes: Math.round(executionTimeMs / 60000),
				agents: this.agentsSpawned,
			},
			"Completed quest metrics tracking"
		);

		// Reset for next quest
		this.reset();

		return metrics;
	}

	/**
	 * Calculate efficiency analytics from historical metrics
	 */
	static calculateAnalytics(questMetrics: QuestMetrics[]): EfficiencyAnalytics {
		if (questMetrics.length === 0) {
			return {
				totalQuests: 0,
				successfulQuests: 0,
				failedQuests: 0,
				successRate: 0,
				avgTokensPerQuest: 0,
				avgTokensPerCompletion: 0,
				avgExecutionTimeMinutes: 0,
				tokenEfficiency: 0,
				agentUtilization: {
					scout: { timesUsed: 0, avgTokens: 0, successRate: 0 },
					planner: { timesUsed: 0, avgTokens: 0, successRate: 0 },
					fabricator: { timesUsed: 0, avgTokens: 0, successRate: 0 },
					auditor: { timesUsed: 0, avgTokens: 0, successRate: 0 },
				},
			};
		}

		const totalQuests = questMetrics.length;
		const successfulQuests = questMetrics.filter((m) => m.success).length;
		const failedQuests = totalQuests - successfulQuests;
		const successRate = (successfulQuests / totalQuests) * 100;

		// Token analytics
		const totalTokens = questMetrics.reduce((sum, m) => sum + m.tokenUsage.totalTokens, 0);
		const avgTokensPerQuest = totalTokens / totalQuests;
		const successfulMetrics = questMetrics.filter((m) => m.success);
		const successfulTokens = successfulMetrics.reduce((sum, m) => sum + m.tokenUsage.totalTokens, 0);
		const avgTokensPerCompletion = successfulQuests > 0 ? successfulTokens / successfulQuests : 0;

		// Time analytics
		const totalTimeMs = questMetrics.reduce((sum, m) => sum + m.executionTimeMs, 0);
		const avgExecutionTimeMinutes = totalTimeMs / (totalQuests * 60000);

		// Efficiency (tokens per minute)
		const tokenEfficiency = totalTimeMs > 0 ? (totalTokens / (totalTimeMs / 60000)) : 0;

		// Find extremes
		let mostExpensiveQuest: EfficiencyAnalytics['mostExpensiveQuest'];
		let mostEfficientQuest: EfficiencyAnalytics['mostEfficientQuest'];

		if (questMetrics.length > 0) {
			// Most expensive by total tokens
			const expensive = questMetrics.reduce((max, current) =>
				current.tokenUsage.totalTokens > max.tokenUsage.totalTokens ? current : max
			);
			mostExpensiveQuest = {
				questId: expensive.questId,
				objective: expensive.objective,
				tokens: expensive.tokenUsage.totalTokens,
				timeMinutes: expensive.executionTimeMs / 60000,
			};

			// Most efficient (lowest tokens per minute for successful quests)
			const successful = questMetrics.filter(m => m.success && m.executionTimeMs > 0);
			if (successful.length > 0) {
				const efficient = successful.reduce((min, current) => {
					const currentEfficiency = current.tokenUsage.totalTokens / (current.executionTimeMs / 60000);
					const minEfficiency = min.tokenUsage.totalTokens / (min.executionTimeMs / 60000);
					return currentEfficiency < minEfficiency ? current : min;
				});
				mostEfficientQuest = {
					questId: efficient.questId,
					objective: efficient.objective,
					tokensPerMinute: efficient.tokenUsage.totalTokens / (efficient.executionTimeMs / 60000),
					success: efficient.success,
				};
			}
		}

		// Agent utilization
		const agentUtilization: EfficiencyAnalytics['agentUtilization'] = {
			scout: { timesUsed: 0, avgTokens: 0, successRate: 0 },
			planner: { timesUsed: 0, avgTokens: 0, successRate: 0 },
			fabricator: { timesUsed: 0, avgTokens: 0, successRate: 0 },
			auditor: { timesUsed: 0, avgTokens: 0, successRate: 0 },
		};

		for (const agentType of Object.keys(agentUtilization) as AgentType[]) {
			const agentMetrics = questMetrics.filter(m => m.agentTypes[agentType] > 0);
			const timesUsed = agentMetrics.length;

			if (timesUsed > 0) {
				const totalTokensForAgent = agentMetrics.reduce((sum, m) => sum + m.tokenUsage.totalTokens, 0);
				const successfulForAgent = agentMetrics.filter(m => m.success).length;

				agentUtilization[agentType] = {
					timesUsed,
					avgTokens: totalTokensForAgent / timesUsed,
					successRate: (successfulForAgent / timesUsed) * 100,
				};
			}
		}

		return {
			totalQuests,
			successfulQuests,
			failedQuests,
			successRate,
			avgTokensPerQuest,
			avgTokensPerCompletion,
			avgExecutionTimeMinutes,
			tokenEfficiency,
			mostExpensiveQuest,
			mostEfficientQuest,
			agentUtilization,
		};
	}
}