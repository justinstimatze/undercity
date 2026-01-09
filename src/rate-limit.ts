/**
 * Rate Limit Tracking
 *
 * Empirical rate limit tracking for Claude API usage.
 * Logs tokens per quest, models usage over time, and captures 429 events.
 */

import {
	QuestUsage,
	TokenUsage,
	RateLimitHit,
	RateLimitState,
	RateLimitConfig,
	TimeWindow,
} from "./types.js";

/**
 * Default rate limit configuration
 */
const DEFAULT_CONFIG: RateLimitConfig = {
	// Conservative estimates - can be adjusted based on actual limits
	maxTokensPer5Hours: 1_000_000, // 1M Sonnet tokens per 5 hours
	maxTokensPerWeek: 5_000_000, // 5M Sonnet tokens per week
	warningThreshold: 0.8, // Warn at 80%
	tokenMultipliers: {
		haiku: 0.25, // Haiku is ~1/4 the cost of Sonnet
		sonnet: 1.0, // Base unit
		opus: 12.0, // Opus is ~12x the cost of Sonnet
	},
};

/**
 * Rate limit tracker - monitors API usage and predicts limits
 */
export class RateLimitTracker {
	private state: RateLimitState;

	constructor(initialState?: Partial<RateLimitState>) {
		this.state = {
			quests: [],
			rateLimitHits: [],
			config: { ...DEFAULT_CONFIG, ...initialState?.config },
			lastUpdated: new Date(),
			...initialState,
		};
	}

	/**
	 * Calculate token usage with Sonnet equivalence
	 */
	private calculateTokenUsage(
		inputTokens: number,
		outputTokens: number,
		model: "haiku" | "sonnet" | "opus"
	): TokenUsage {
		const totalTokens = inputTokens + outputTokens;
		const multiplier = this.state.config.tokenMultipliers[model];
		const sonnetEquivalentTokens = Math.round(totalTokens * multiplier);

		return {
			inputTokens,
			outputTokens,
			totalTokens,
			sonnetEquivalentTokens,
		};
	}

	/**
	 * Record a quest's token usage
	 */
	recordQuest(
		questId: string,
		model: "haiku" | "sonnet" | "opus",
		inputTokens: number,
		outputTokens: number,
		options?: {
			durationMs?: number;
			raidId?: string;
			agentId?: string;
			timestamp?: Date;
		}
	): void {
		const tokens = this.calculateTokenUsage(inputTokens, outputTokens, model);

		const questUsage: QuestUsage = {
			questId,
			model,
			tokens,
			timestamp: options?.timestamp || new Date(),
			durationMs: options?.durationMs,
			raidId: options?.raidId,
			agentId: options?.agentId,
		};

		this.state.quests.push(questUsage);
		this.state.lastUpdated = new Date();

		// Clean up old entries to prevent unbounded growth
		this.cleanupOldEntries();

		// Check for warnings
		this.checkUsageWarnings(model);
	}

	/**
	 * Record a rate limit hit (429 response)
	 */
	recordRateLimitHit(
		model: "haiku" | "sonnet" | "opus",
		errorMessage?: string,
		responseHeaders?: Record<string, string>
	): void {
		const currentUsage = this.getCurrentUsage();

		const hit: RateLimitHit = {
			timestamp: new Date(),
			model,
			currentUsage,
			responseHeaders,
			errorMessage,
		};

		this.state.rateLimitHits.push(hit);
		this.state.lastUpdated = new Date();

		console.error(`🚨 Rate limit hit for ${model}:`, {
			timestamp: hit.timestamp,
			usage: currentUsage,
			error: errorMessage,
		});
	}

	/**
	 * Get current usage across time windows
	 */
	getCurrentUsage(): {
		last5Hours: number;
		currentWeek: number;
		last5HoursSonnet: number;
		currentWeekSonnet: number;
	} {
		const now = new Date();
		const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
		const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

		let last5Hours = 0;
		let currentWeek = 0;
		let last5HoursSonnet = 0;
		let currentWeekSonnet = 0;

		for (const quest of this.state.quests) {
			const questTime = quest.timestamp;

			if (questTime >= weekAgo) {
				currentWeek += quest.tokens.totalTokens;
				currentWeekSonnet += quest.tokens.sonnetEquivalentTokens;

				if (questTime >= fiveHoursAgo) {
					last5Hours += quest.tokens.totalTokens;
					last5HoursSonnet += quest.tokens.sonnetEquivalentTokens;
				}
			}
		}

		return {
			last5Hours,
			currentWeek,
			last5HoursSonnet,
			currentWeekSonnet,
		};
	}

	/**
	 * Get usage percentage for a time window
	 */
	getUsagePercentage(window: TimeWindow): number {
		const usage = this.getCurrentUsage();

		if (window === "5hour") {
			return usage.last5HoursSonnet / this.state.config.maxTokensPer5Hours;
		} else {
			return usage.currentWeekSonnet / this.state.config.maxTokensPerWeek;
		}
	}

	/**
	 * Check if usage is approaching limits and warn
	 */
	private checkUsageWarnings(model: string): void {
		const fiveHourUsage = this.getUsagePercentage("5hour");
		const weeklyUsage = this.getUsagePercentage("week");
		const threshold = this.state.config.warningThreshold;

		if (fiveHourUsage >= threshold) {
			console.warn(
				`⚠️  Rate limit warning: ${(fiveHourUsage * 100).toFixed(1)}% of 5-hour limit used (${model})`
			);
		}

		if (weeklyUsage >= threshold) {
			console.warn(
				`⚠️  Rate limit warning: ${(weeklyUsage * 100).toFixed(1)}% of weekly limit used (${model})`
			);
		}
	}

	/**
	 * Clean up old quest entries beyond the tracking window
	 */
	private cleanupOldEntries(): void {
		const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days (1 week + buffer)

		const originalLength = this.state.quests.length;
		this.state.quests = this.state.quests.filter(
			(quest) => quest.timestamp >= cutoff
		);

		const cleaned = originalLength - this.state.quests.length;
		if (cleaned > 0) {
			console.log(`🧹 Cleaned up ${cleaned} old quest entries`);
		}

		// Also clean up old rate limit hits
		const originalHits = this.state.rateLimitHits.length;
		this.state.rateLimitHits = this.state.rateLimitHits.filter(
			(hit) => hit.timestamp >= cutoff
		);

		const cleanedHits = originalHits - this.state.rateLimitHits.length;
		if (cleanedHits > 0) {
			console.log(`🧹 Cleaned up ${cleanedHits} old rate limit hit entries`);
		}
	}

	/**
	 * Get usage analytics for a specific model
	 */
	getModelUsage(model: "haiku" | "sonnet" | "opus"): {
		totalQuests: number;
		totalTokens: number;
		sonnetEquivalentTokens: number;
		last24Hours: number;
		rateLimitHits: number;
	} {
		const modelQuests = this.state.quests.filter((q) => q.model === model);
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

		const totalQuests = modelQuests.length;
		const totalTokens = modelQuests.reduce((sum, q) => sum + q.tokens.totalTokens, 0);
		const sonnetEquivalentTokens = modelQuests.reduce(
			(sum, q) => sum + q.tokens.sonnetEquivalentTokens,
			0
		);
		const last24Hours = modelQuests
			.filter((q) => q.timestamp >= yesterday)
			.reduce((sum, q) => sum + q.tokens.totalTokens, 0);
		const rateLimitHits = this.state.rateLimitHits.filter(
			(hit) => hit.model === model
		).length;

		return {
			totalQuests,
			totalTokens,
			sonnetEquivalentTokens,
			last24Hours,
			rateLimitHits,
		};
	}

	/**
	 * Get usage summary across all models
	 */
	getUsageSummary(): {
		current: ReturnType<typeof this.getCurrentUsage>;
		percentages: { fiveHour: number; weekly: number };
		modelBreakdown: Record<string, ReturnType<typeof this.getModelUsage>>;
		totalRateLimitHits: number;
	} {
		const current = this.getCurrentUsage();
		const percentages = {
			fiveHour: this.getUsagePercentage("5hour"),
			weekly: this.getUsagePercentage("week"),
		};

		const modelBreakdown = {
			haiku: this.getModelUsage("haiku"),
			sonnet: this.getModelUsage("sonnet"),
			opus: this.getModelUsage("opus"),
		};

		return {
			current,
			percentages,
			modelBreakdown,
			totalRateLimitHits: this.state.rateLimitHits.length,
		};
	}

	/**
	 * Get the current state (for persistence)
	 */
	getState(): RateLimitState {
		return { ...this.state };
	}

	/**
	 * Update configuration
	 */
	updateConfig(config: Partial<RateLimitConfig>): void {
		this.state.config = { ...this.state.config, ...config };
		this.state.lastUpdated = new Date();
	}

	/**
	 * Generate a detailed usage report
	 */
	generateReport(): string {
		const summary = this.getUsageSummary();
		const { current, percentages, modelBreakdown, totalRateLimitHits } = summary;

		const lines = [
			"📊 Rate Limit Usage Report",
			"=" + "=".repeat(25),
			"",
			"Current Usage:",
			`  5-hour window: ${current.last5HoursSonnet.toLocaleString()} Sonnet tokens (${(percentages.fiveHour * 100).toFixed(1)}%)`,
			`  Weekly window: ${current.currentWeekSonnet.toLocaleString()} Sonnet tokens (${(percentages.weekly * 100).toFixed(1)}%)`,
			"",
			"Model Breakdown:",
		];

		for (const [model, usage] of Object.entries(modelBreakdown)) {
			lines.push(
				`  ${model.padEnd(6)}: ${usage.totalQuests.toString().padStart(4)} quests, ` +
				`${usage.sonnetEquivalentTokens.toLocaleString().padStart(8)} Sonnet eq, ` +
				`${usage.rateLimitHits} rate limit hits`
			);
		}

		lines.push("", `Total rate limit hits: ${totalRateLimitHits}`);

		if (totalRateLimitHits > 0) {
			lines.push("", "Recent Rate Limit Hits:");
			const recentHits = this.state.rateLimitHits
				.slice(-3)
				.reverse();

			for (const hit of recentHits) {
				lines.push(
					`  ${hit.timestamp.toISOString()} - ${hit.model} (${hit.currentUsage.last5HoursSonnet.toLocaleString()} tokens)`
				);
			}
		}

		return lines.join("\n");
	}
}