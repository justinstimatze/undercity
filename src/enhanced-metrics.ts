/**
 * Enhanced Metrics System
 *
 * Extends the existing metrics system to provide comprehensive logging of:
 * - Task durations with detailed timing breakdowns
 * - Token usage across all models with escalation tracking
 * - Model escalation patterns and effectiveness
 * - Queryable history in .undercity/metrics.jsonl format
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentType, TaskMetrics } from "./types.js";

const METRICS_DIR = path.join(process.cwd(), ".undercity");
const METRICS_FILE = path.join(METRICS_DIR, "metrics.jsonl");

/**
 * Enhanced task metrics with detailed escalation and timing data
 */
export interface EnhancedTaskMetrics extends TaskMetrics {
	/** Type identifier for enhanced metrics */
	type: "enhanced_task_metrics";
	/** Version for schema evolution */
	version: string;
	/** Detailed timing breakdown */
	timing: {
		/** Time from task start to first attempt completion */
		firstAttemptMs: number;
		/** Time spent in planning phase */
		planningMs?: number;
		/** Time spent in execution phase */
		executionMs: number;
		/** Time spent in review/verification phase */
		reviewMs?: number;
		/** Total idle time waiting for rate limits, user input, etc. */
		idleMs?: number;
	};
	/** Enhanced escalation tracking */
	escalation: {
		/** Number of model escalations during this task */
		escalationCount: number;
		/** Chain of models used (e.g., ["haiku", "sonnet", "opus"]) */
		modelChain: Array<"haiku" | "sonnet" | "opus">;
		/** Reasons for each escalation */
		escalationReasons: string[];
		/** Success rate per model in this task */
		modelSuccess: Record<"haiku" | "sonnet" | "opus", { attempts: number; successes: number }>;
	};
	/** Enhanced token tracking */
	tokenUsage: {
		/** Tokens by model type */
		byModel: Record<"haiku" | "sonnet" | "opus", { input: number; output: number; total: number }>;
		/** Tokens by phase */
		byPhase: {
			planning: number;
			execution: number;
			review: number;
			rework: number;
			escalation: number;
		};
		/** Cost efficiency metrics (tokens per successful operation) */
		efficiency: {
			/** First-order tokens (without rework) */
			firstOrderTokens: number;
			/** Total tokens including all rework */
			totalTokens: number;
			/** Efficiency ratio (first-order / total) */
			efficiencyRatio: number;
		};
	};
	/** Agent coordination metrics */
	coordination: {
		/** Agents used in parallel */
		parallelAgents: number;
		/** Agent spawn pattern */
		spawnPattern: AgentType[];
		/** Cross-agent communication events */
		communicationEvents: number;
	};
}

/**
 * Model escalation event for detailed tracking
 */
export interface ModelEscalationEvent {
	/** Type identifier */
	type: "model_escalation";
	/** Version for schema evolution */
	version: string;
	/** Timestamp of escalation */
	timestamp: Date;
	/** Task and session context */
	taskId: string;
	sessionId: string;
	/** Escalation details */
	escalation: {
		/** Model being escalated from */
		from: "haiku" | "sonnet" | "opus";
		/** Model being escalated to */
		to: "haiku" | "sonnet" | "opus";
		/** Reason for escalation */
		reason: string;
		/** Error that triggered escalation (if any) */
		triggerError?: string;
		/** Number of attempts made with the previous model */
		previousAttempts: number;
		/** Tokens spent before escalation */
		tokensBeforeEscalation: number;
	};
	/** Outcome tracking */
	outcome: {
		/** Did the escalation resolve the issue? */
		successful: boolean;
		/** Tokens used by the new model */
		tokensUsed: number;
		/** Time taken by the new model */
		durationMs: number;
		/** Final success state */
		finalSuccess: boolean;
	};
}

/**
 * Token usage event for granular tracking
 */
export interface TokenUsageEvent {
	/** Type identifier */
	type: "token_usage";
	/** Version for schema evolution */
	version: string;
	/** Timestamp */
	timestamp: Date;
	/** Context */
	taskId: string;
	sessionId: string;
	agentType: AgentType;
	/** Token details */
	usage: {
		/** Model used */
		model: "haiku" | "sonnet" | "opus";
		/** Input tokens */
		inputTokens: number;
		/** Output tokens */
		outputTokens: number;
		/** Total tokens */
		totalTokens: number;
		/** Operation type */
		operation: "planning" | "execution" | "review" | "rework" | "escalation";
		/** Was this operation successful? */
		successful: boolean;
	};
}

/**
 * Enhanced metrics collector that extends the existing system
 */
export class EnhancedMetricsCollector {
	private taskStartTime?: Date;
	private taskId?: string;
	private sessionId?: string;
	private objective?: string;

	// Timing tracking
	private timingBreakdown = {
		firstAttemptMs: 0,
		planningMs: 0,
		executionMs: 0,
		reviewMs: 0,
		idleMs: 0,
	};

	// Escalation tracking
	private modelChain: Array<"haiku" | "sonnet" | "opus"> = [];
	private escalationReasons: string[] = [];
	private escalationCount = 0;
	private modelSuccess: Record<"haiku" | "sonnet" | "opus", { attempts: number; successes: number }> = {
		haiku: { attempts: 0, successes: 0 },
		sonnet: { attempts: 0, successes: 0 },
		opus: { attempts: 0, successes: 0 },
	};

	// Token tracking
	private tokensByModel: Record<"haiku" | "sonnet" | "opus", { input: number; output: number; total: number }> = {
		haiku: { input: 0, output: 0, total: 0 },
		sonnet: { input: 0, output: 0, total: 0 },
		opus: { input: 0, output: 0, total: 0 },
	};

	private tokensByPhase = {
		planning: 0,
		execution: 0,
		review: 0,
		rework: 0,
		escalation: 0,
	};

	private firstOrderTokens = 0;
	private totalTokens = 0;

	// Agent tracking
	private agentsUsed: AgentType[] = [];
	private parallelAgents = 0;
	private communicationEvents = 0;

	/**
	 * Start tracking a new task
	 */
	startTask(taskId: string, objective: string, sessionId: string): void {
		this.reset();
		this.taskStartTime = new Date();
		this.taskId = taskId;
		this.sessionId = sessionId;
		this.objective = objective;
	}

	/**
	 * Reset all tracking state
	 */
	private reset(): void {
		this.taskStartTime = undefined;
		this.taskId = undefined;
		this.sessionId = undefined;
		this.objective = undefined;

		this.timingBreakdown = {
			firstAttemptMs: 0,
			planningMs: 0,
			executionMs: 0,
			reviewMs: 0,
			idleMs: 0,
		};

		this.modelChain = [];
		this.escalationReasons = [];
		this.escalationCount = 0;
		this.modelSuccess = {
			haiku: { attempts: 0, successes: 0 },
			sonnet: { attempts: 0, successes: 0 },
			opus: { attempts: 0, successes: 0 },
		};

		this.tokensByModel = {
			haiku: { input: 0, output: 0, total: 0 },
			sonnet: { input: 0, output: 0, total: 0 },
			opus: { input: 0, output: 0, total: 0 },
		};

		this.tokensByPhase = {
			planning: 0,
			execution: 0,
			review: 0,
			rework: 0,
			escalation: 0,
		};

		this.firstOrderTokens = 0;
		this.totalTokens = 0;
		this.agentsUsed = [];
		this.parallelAgents = 0;
		this.communicationEvents = 0;
	}

	/**
	 * Record token usage for a specific operation
	 */
	recordTokenUsage(
		model: "haiku" | "sonnet" | "opus",
		inputTokens: number,
		outputTokens: number,
		operation: "planning" | "execution" | "review" | "rework" | "escalation",
		agentType: AgentType,
		successful: boolean,
	): void {
		const totalTokens = inputTokens + outputTokens;

		// Update model-specific counters
		this.tokensByModel[model].input += inputTokens;
		this.tokensByModel[model].output += outputTokens;
		this.tokensByModel[model].total += totalTokens;

		// Update phase-specific counters
		this.tokensByPhase[operation] += totalTokens;

		// Track first-order vs total tokens
		if (operation !== "rework") {
			this.firstOrderTokens += totalTokens;
		}
		this.totalTokens += totalTokens;

		// Record agent usage
		if (!this.agentsUsed.includes(agentType)) {
			this.agentsUsed.push(agentType);
		}

		// Log the token usage event
		if (this.taskId && this.sessionId) {
			const tokenEvent: TokenUsageEvent = {
				type: "token_usage",
				version: "1.0",
				timestamp: new Date(),
				taskId: this.taskId,
				sessionId: this.sessionId,
				agentType,
				usage: {
					model,
					inputTokens,
					outputTokens,
					totalTokens,
					operation,
					successful,
				},
			};

			this.appendToMetricsFile(tokenEvent).catch(console.error);
		}
	}

	/**
	 * Record a model escalation event
	 */
	recordModelEscalation(
		from: "haiku" | "sonnet" | "opus",
		to: "haiku" | "sonnet" | "opus",
		reason: string,
		previousAttempts: number,
		tokensBeforeEscalation: number,
		triggerError?: string,
	): void {
		this.escalationCount++;
		this.escalationReasons.push(reason);

		// Track model chain
		if (!this.modelChain.includes(from)) {
			this.modelChain.push(from);
		}
		if (!this.modelChain.includes(to)) {
			this.modelChain.push(to);
		}

		// Log the escalation event
		if (this.taskId && this.sessionId) {
			const escalationEvent: ModelEscalationEvent = {
				type: "model_escalation",
				version: "1.0",
				timestamp: new Date(),
				taskId: this.taskId,
				sessionId: this.sessionId,
				escalation: {
					from,
					to,
					reason,
					triggerError,
					previousAttempts,
					tokensBeforeEscalation,
				},
				outcome: {
					successful: false, // Will be updated when outcome is known
					tokensUsed: 0,
					durationMs: 0,
					finalSuccess: false,
				},
			};

			this.appendToMetricsFile(escalationEvent).catch(console.error);
		}
	}

	/**
	 * Record timing for a specific phase
	 */
	recordTiming(phase: "planning" | "execution" | "review" | "idle", durationMs: number): void {
		switch (phase) {
			case "planning":
				this.timingBreakdown.planningMs += durationMs;
				break;
			case "execution":
				this.timingBreakdown.executionMs += durationMs;
				break;
			case "review":
				this.timingBreakdown.reviewMs += durationMs;
				break;
			case "idle":
				this.timingBreakdown.idleMs += durationMs;
				break;
		}
	}

	/**
	 * Record attempt outcome
	 */
	recordAttemptOutcome(model: "haiku" | "sonnet" | "opus", successful: boolean): void {
		this.modelSuccess[model].attempts++;
		if (successful) {
			this.modelSuccess[model].successes++;
		}
	}

	/**
	 * Complete task tracking and generate enhanced metrics
	 */
	completeTask(baseMetrics: TaskMetrics): EnhancedTaskMetrics | null {
		if (!this.taskStartTime || !this.taskId || !this.sessionId || !this.objective) {
			return null;
		}

		const completedAt = new Date();
		const totalDurationMs = completedAt.getTime() - this.taskStartTime.getTime();

		// Calculate first attempt time
		this.timingBreakdown.firstAttemptMs = Math.min(
			this.timingBreakdown.planningMs + this.timingBreakdown.executionMs,
			totalDurationMs,
		);

		// Calculate efficiency ratio
		const efficiencyRatio = this.totalTokens > 0 ? this.firstOrderTokens / this.totalTokens : 1;

		const enhancedMetrics: EnhancedTaskMetrics = {
			...baseMetrics,
			type: "enhanced_task_metrics",
			version: "1.0",
			timing: {
				...this.timingBreakdown,
				firstAttemptMs: this.timingBreakdown.firstAttemptMs,
			},
			escalation: {
				escalationCount: this.escalationCount,
				modelChain: [...this.modelChain],
				escalationReasons: [...this.escalationReasons],
				modelSuccess: { ...this.modelSuccess },
			},
			tokenUsage: {
				byModel: { ...this.tokensByModel },
				byPhase: { ...this.tokensByPhase },
				efficiency: {
					firstOrderTokens: this.firstOrderTokens,
					totalTokens: this.totalTokens,
					efficiencyRatio,
				},
			},
			coordination: {
				parallelAgents: this.parallelAgents,
				spawnPattern: [...this.agentsUsed],
				communicationEvents: this.communicationEvents,
			},
		};

		// Log the enhanced metrics
		this.appendToMetricsFile(enhancedMetrics).catch(console.error);

		return enhancedMetrics;
	}

	/**
	 * Append metrics to the JSONL file
	 */
	private async appendToMetricsFile(
		metrics: EnhancedTaskMetrics | ModelEscalationEvent | TokenUsageEvent,
	): Promise<void> {
		try {
			// Ensure directory exists
			await fs.mkdir(METRICS_DIR, { recursive: true });

			// Convert metrics to JSON and append to file
			const metricsJson = JSON.stringify(metrics);
			await fs.appendFile(METRICS_FILE, `${metricsJson}\n`);
		} catch (error) {
			console.error("Failed to append to metrics file:", error);
		}
	}
}

/**
 * Query enhanced metrics from the JSONL file
 */
export class EnhancedMetricsQuery {
	/**
	 * Load all enhanced metrics from the JSONL file
	 */
	static async loadAllMetrics(): Promise<{
		taskMetrics: EnhancedTaskMetrics[];
		escalationEvents: ModelEscalationEvent[];
		tokenEvents: TokenUsageEvent[];
	}> {
		try {
			const fileContent = await fs.readFile(METRICS_FILE, "utf-8");
			const lines = fileContent.trim().split("\n");

			const taskMetrics: EnhancedTaskMetrics[] = [];
			const escalationEvents: ModelEscalationEvent[] = [];
			const tokenEvents: TokenUsageEvent[] = [];

			for (const line of lines) {
				if (line.trim()) {
					try {
						const parsed = JSON.parse(line);

						// Convert date strings back to Date objects
						if (parsed.timestamp) {
							parsed.timestamp = new Date(parsed.timestamp);
						}
						if (parsed.startedAt) {
							parsed.startedAt = new Date(parsed.startedAt);
						}
						if (parsed.completedAt) {
							parsed.completedAt = new Date(parsed.completedAt);
						}

						// Categorize by type
						switch (parsed.type) {
							case "enhanced_task_metrics":
								taskMetrics.push(parsed as EnhancedTaskMetrics);
								break;
							case "model_escalation":
								escalationEvents.push(parsed as ModelEscalationEvent);
								break;
							case "token_usage":
								tokenEvents.push(parsed as TokenUsageEvent);
								break;
							// Skip other types or legacy metrics without type field
						}
					} catch (parseError) {
						console.warn("Skipping malformed metrics line:", parseError);
					}
				}
			}

			return { taskMetrics, escalationEvents, tokenEvents };
		} catch {
			// File doesn't exist or can't be read
			return { taskMetrics: [], escalationEvents: [], tokenEvents: [] };
		}
	}

	/**
	 * Get escalation patterns and effectiveness
	 */
	static async getEscalationAnalysis(): Promise<{
		totalEscalations: number;
		escalationsByModel: Record<string, number>;
		escalationSuccessRate: number;
		averageTokensSaved: number;
		commonEscalationReasons: Array<{ reason: string; count: number }>;
	}> {
		const { escalationEvents } = await EnhancedMetricsQuery.loadAllMetrics();

		const escalationsByModel: Record<string, number> = {};
		const escalationReasons: Record<string, number> = {};
		let successfulEscalations = 0;
		let totalTokensSaved = 0;

		for (const event of escalationEvents) {
			const escalationKey = `${event.escalation.from} → ${event.escalation.to}`;
			escalationsByModel[escalationKey] = (escalationsByModel[escalationKey] || 0) + 1;

			escalationReasons[event.escalation.reason] = (escalationReasons[event.escalation.reason] || 0) + 1;

			if (event.outcome.successful) {
				successfulEscalations++;
			}

			// Calculate potential tokens saved by escalation
			// This is a heuristic based on the difference between tokens used and expected tokens
			totalTokensSaved += Math.max(0, event.escalation.tokensBeforeEscalation - event.outcome.tokensUsed);
		}

		const commonReasons = Object.entries(escalationReasons)
			.map(([reason, count]) => ({ reason, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		return {
			totalEscalations: escalationEvents.length,
			escalationsByModel,
			escalationSuccessRate: escalationEvents.length > 0 ? successfulEscalations / escalationEvents.length : 0,
			averageTokensSaved: escalationEvents.length > 0 ? totalTokensSaved / escalationEvents.length : 0,
			commonEscalationReasons: commonReasons,
		};
	}

	/**
	 * Get token usage trends over time
	 */
	static async getTokenUsageTrends(days = 30): Promise<{
		totalTokens: number;
		tokensByModel: Record<"haiku" | "sonnet" | "opus", number>;
		tokensByPhase: Record<string, number>;
		averageEfficiencyRatio: number;
		dailyUsage: Array<{ date: string; tokens: number; tasks: number }>;
	}> {
		const { taskMetrics } = await EnhancedMetricsQuery.loadAllMetrics();

		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - days);

		const recentMetrics = taskMetrics.filter((m) => m.startedAt && new Date(m.startedAt) >= cutoffDate);

		const tokensByModel: Record<"haiku" | "sonnet" | "opus", number> = {
			haiku: 0,
			sonnet: 0,
			opus: 0,
		};

		const tokensByPhase: Record<string, number> = {};
		let totalTokens = 0;
		let totalEfficiencyRatio = 0;

		for (const metrics of recentMetrics) {
			totalTokens += metrics.tokenUsage.efficiency.totalTokens;
			totalEfficiencyRatio += metrics.tokenUsage.efficiency.efficiencyRatio;

			// Sum tokens by model
			for (const [model, usage] of Object.entries(metrics.tokenUsage.byModel)) {
				tokensByModel[model as keyof typeof tokensByModel] += usage.total;
			}

			// Sum tokens by phase
			for (const [phase, tokens] of Object.entries(metrics.tokenUsage.byPhase)) {
				tokensByPhase[phase] = (tokensByPhase[phase] || 0) + tokens;
			}
		}

		// Calculate daily usage
		const dailyUsage = new Map<string, { tokens: number; tasks: number }>();
		for (const metrics of recentMetrics) {
			const date = new Date(metrics.startedAt).toISOString().split("T")[0];
			const existing = dailyUsage.get(date) || { tokens: 0, tasks: 0 };
			existing.tokens += metrics.tokenUsage.efficiency.totalTokens;
			existing.tasks += 1;
			dailyUsage.set(date, existing);
		}

		const dailyUsageArray = Array.from(dailyUsage.entries())
			.map(([date, data]) => ({ date, tokens: data.tokens, tasks: data.tasks }))
			.sort((a, b) => a.date.localeCompare(b.date));

		return {
			totalTokens,
			tokensByModel,
			tokensByPhase,
			averageEfficiencyRatio: recentMetrics.length > 0 ? totalEfficiencyRatio / recentMetrics.length : 0,
			dailyUsage: dailyUsageArray,
		};
	}
}

// Singleton instance for global use
let enhancedMetricsCollector: EnhancedMetricsCollector | undefined;

/**
 * Get the global enhanced metrics collector instance
 */
export function getEnhancedMetricsCollector(): EnhancedMetricsCollector {
	if (!enhancedMetricsCollector) {
		enhancedMetricsCollector = new EnhancedMetricsCollector();
	}
	return enhancedMetricsCollector;
}
