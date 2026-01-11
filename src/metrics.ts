/**
 * Efficiency Metrics Tracker
 *
 * Tracks token usage, execution time, and success metrics for quest completion analysis.
 * Provides tokens-per-completion ratios and historical analytics.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ComplexityLevel } from "./complexity.js";
import { assessComplexityFast } from "./complexity.js";
import { RateLimitTracker } from "./rate-limit.js";
import type { AgentType, AttemptRecord, EfficiencyAnalytics, QuestMetrics, TokenUsage } from "./types.js";

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
 * Logs metrics to .undercity/metrics.jsonl
 * Creates directory if it doesn't exist
 */
async function logMetricsToFile(metrics: QuestMetrics): Promise<void> {
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
 * Tracks efficiency metrics for quests and raids
 */
export class MetricsTracker {
	private questStartTime?: Date;
	private questId?: string;
	private raidId?: string;
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

	constructor(rateLimitTracker?: RateLimitTracker) {
		this.rateLimitTracker = rateLimitTracker || new RateLimitTracker();
	}

	/**
	 * Reset tracking state for a new quest
	 */
	private reset(): void {
		this.questStartTime = undefined;
		this.questId = undefined;
		this.raidId = undefined;
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
	}

	/**
	 * Start tracking a quest with complexity assessment
	 */
	startQuest(questId: string, objective: string, raidId: string, startingModel?: "haiku" | "sonnet" | "opus"): void {
		this.reset();
		this.questStartTime = new Date();
		this.questId = questId;
		this.raidId = raidId;
		this.objective = objective;
		this.startingModel = startingModel;
		// Assess complexity at start time
		this.complexityLevel = assessComplexityFast(objective).level;
	}

	/**
	 * Record model escalation
	 */
	recordEscalation(_fromModel: "haiku" | "sonnet" | "opus", toModel: "haiku" | "sonnet" | "opus"): void {
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
	 * Record an attempt for the current quest.
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
		if (this.questId && model) {
			this.rateLimitTracker.recordQuest(this.questId, model, usage.inputTokens, usage.outputTokens, {
				raidId: this.raidId,
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
	 * Record quest failure
	 */
	recordQuestFailure(error: string): void {
		this.currentError = error;
	}

	/**
	 * Complete quest tracking and return metrics
	 */
	completeQuest(success: boolean): QuestMetrics | null {
		if (!this.questStartTime || !this.questId || !this.raidId || !this.objective) {
			return null;
		}

		const completedAt = new Date();
		const durationMs = completedAt.getTime() - this.questStartTime.getTime();

		const metrics: QuestMetrics = {
			questId: this.questId,
			raidId: this.raidId,
			objective: this.objective,
			success,
			durationMs,
			totalTokens: this.totalTokens,
			agentsSpawned: this.agentsSpawned,
			agentTypes: [...this.agentTypes],
			startedAt: this.questStartTime,
			completedAt,
			error: this.currentError,
			// Include attempt records for model escalation analysis
			attempts: this.attempts.length > 0 ? [...this.attempts] : undefined,
			finalModel: this.finalModel,
			// Complexity and escalation tracking
			complexityLevel: this.complexityLevel,
			wasEscalated: this.wasEscalated,
			startingModel: this.startingModel,
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
	static calculateAnalytics(questMetrics: QuestMetrics[]): EfficiencyAnalytics {
		if (questMetrics.length === 0) {
			return {
				totalQuests: 0,
				successRate: 0,
				avgTokensPerCompletion: 0,
				avgDurationMs: 0,
				avgAgentsSpawned: 0,
				mostEfficientAgentType: null,
				tokensByAgentType: {} as Record<AgentType, { total: number; avgPerQuest: number }>,
				successRateByComplexity: {
					trivial: {
						rate: 0,
						totalQuests: 0,
						avgTokensPerQuest: 0,
						escalationTrigger: 0,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					simple: {
						rate: 0,
						totalQuests: 0,
						avgTokensPerQuest: 0,
						escalationTrigger: 0.1,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					standard: {
						rate: 0,
						totalQuests: 0,
						avgTokensPerQuest: 0,
						escalationTrigger: 0.3,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					complex: {
						rate: 0,
						totalQuests: 0,
						avgTokensPerQuest: 0,
						escalationTrigger: 0.5,
						escalatedCount: 0,
						escalationSuccessRate: 0,
						escalationTokenOverhead: 0,
					},
					critical: {
						rate: 0,
						totalQuests: 0,
						avgTokensPerQuest: 0,
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

		const completedQuests = questMetrics.filter((m) => m.success);
		const totalQuests = questMetrics.length;
		const successRate = (completedQuests.length / totalQuests) * 100;

		// Calculate complexity breakdowns with escalation tracking
		const complexityBreakdown: Record<
			string,
			{
				totalQuests: number;
				successfulQuests: number;
				totalTokens: number;
				escalatedCount: number;
				escalatedSuccessful: number;
				escalatedTokens: number;
				nonEscalatedTokens: number;
			}
		> = {
			trivial: {
				totalQuests: 0,
				successfulQuests: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			simple: {
				totalQuests: 0,
				successfulQuests: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			standard: {
				totalQuests: 0,
				successfulQuests: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			complex: {
				totalQuests: 0,
				successfulQuests: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
			critical: {
				totalQuests: 0,
				successfulQuests: 0,
				totalTokens: 0,
				escalatedCount: 0,
				escalatedSuccessful: 0,
				escalatedTokens: 0,
				nonEscalatedTokens: 0,
			},
		};

		// Calculate averages from completed quests only
		const avgTokensPerCompletion =
			completedQuests.length > 0
				? completedQuests.reduce((sum, m) => sum + m.totalTokens, 0) / completedQuests.length
				: 0;

		const avgDurationMs =
			questMetrics.length > 0 ? questMetrics.reduce((sum, m) => sum + m.durationMs, 0) / questMetrics.length : 0;

		const avgAgentsSpawned =
			questMetrics.length > 0 ? questMetrics.reduce((sum, m) => sum + m.agentsSpawned, 0) / questMetrics.length : 0;

		// Calculate tokens by agent type
		const tokensByAgentType: Record<AgentType, { total: number; avgPerQuest: number }> = {
			flute: { total: 0, avgPerQuest: 0 },
			logistics: { total: 0, avgPerQuest: 0 },
			quester: { total: 0, avgPerQuest: 0 },
			sheriff: { total: 0, avgPerQuest: 0 },
		};

		const agentTypeQuests: Record<AgentType, number> = {
			flute: 0,
			logistics: 0,
			quester: 0,
			sheriff: 0,
		};

		// Process metrics for different dimensions
		for (const metrics of questMetrics) {
			// Use stored complexity if available, otherwise assess from objective
			const complexity = metrics.complexityLevel ?? assessComplexityFast(metrics.objective).level;
			const complexityData = complexityBreakdown[complexity];
			complexityData.totalQuests++;
			complexityData.totalTokens += metrics.totalTokens;

			if (metrics.success) {
				complexityData.successfulQuests++;
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
					agentTypeQuests[agentType]++;
				}
			}
		}

		// Calculate agent type averages
		for (const agentType of Object.keys(tokensByAgentType) as AgentType[]) {
			const questCount = agentTypeQuests[agentType];
			if (questCount > 0) {
				tokensByAgentType[agentType].avgPerQuest = tokensByAgentType[agentType].total / questCount;
			}
		}

		// Find most efficient agent type (lowest tokens per completion)
		let mostEfficientAgentType: AgentType | null = null;
		let lowestTokensPerCompletion = Infinity;

		for (const [agentType, stats] of Object.entries(tokensByAgentType)) {
			if (stats.avgPerQuest > 0 && stats.avgPerQuest < lowestTokensPerCompletion) {
				lowestTokensPerCompletion = stats.avgPerQuest;
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
				const nonEscalatedCount = data.totalQuests - data.escalatedCount;
				const avgEscalatedTokens = data.escalatedCount > 0 ? data.escalatedTokens / data.escalatedCount : 0;
				const avgNonEscalatedTokens = nonEscalatedCount > 0 ? data.nonEscalatedTokens / nonEscalatedCount : 0;
				const escalationTokenOverhead =
					avgNonEscalatedTokens > 0 ? avgEscalatedTokens - avgNonEscalatedTokens : avgEscalatedTokens;

				acc[complexity as ComplexityLevel] = {
					rate: data.totalQuests > 0 ? (data.successfulQuests / data.totalQuests) * 100 : 0,
					totalQuests: data.totalQuests,
					avgTokensPerQuest: data.totalQuests > 0 ? data.totalTokens / data.totalQuests : 0,
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
					totalQuests: number;
					avgTokensPerQuest: number;
					escalationTrigger: number;
					escalatedCount: number;
					escalationSuccessRate: number;
					escalationTokenOverhead: number;
				}
			>,
		);

		// Analysis period
		const dates = questMetrics
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
			totalQuests,
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
 * Load all quest metrics from the JSONL file
 */
export async function loadQuestMetrics(): Promise<QuestMetrics[]> {
	try {
		const fileContent = await fs.readFile(METRICS_FILE, "utf-8");
		const lines = fileContent.trim().split("\n");
		const metrics: QuestMetrics[] = [];

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
 */
export async function generateEfficiencyAnalytics(): Promise<EfficiencyAnalytics> {
	const questMetrics = await loadQuestMetrics();
	return MetricsTracker.calculateAnalytics(questMetrics);
}
