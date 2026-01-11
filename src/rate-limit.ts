/**
 * Rate Limit Tracking
 *
 * Empirical rate limit tracking for Claude API usage.
 * Logs tokens per quest, models usage over time, and captures 429 events.
 */

import type {
	QuestUsage,
	RateLimitConfig,
	RateLimitHit,
	RateLimitPause,
	RateLimitState,
	TimeWindow,
	TokenUsage,
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
			pause: { isPaused: false },
			...initialState,
		};
	}

	/**
	 * Calculate token usage with Sonnet equivalence
	 */
	private calculateTokenUsage(
		inputTokens: number,
		outputTokens: number,
		model: "haiku" | "sonnet" | "opus",
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
		},
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
		responseHeaders?: Record<string, string>,
	): void {
		const currentUsage = this.getCurrentUsage();

		// Log enhanced header information
		this.logRateLimitHeaders(responseHeaders);

		const hit: RateLimitHit = {
			timestamp: new Date(),
			model,
			currentUsage,
			responseHeaders,
			errorMessage,
		};

		this.state.rateLimitHits.push(hit);
		this.state.lastUpdated = new Date();

		// Extract enhanced metadata from headers
		const headerMetadata = RateLimitTracker.processRateLimitHeaders(responseHeaders);

		console.error(`🚨 Rate limit hit for ${model}:`, {
			timestamp: hit.timestamp,
			usage: currentUsage,
			error: errorMessage,
			apiLimitInfo: headerMetadata,
		});

		// Trigger pause for this model
		this.pauseForRateLimit(model, errorMessage, undefined, responseHeaders);
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
	 * Check if usage is approaching limits and warn or prevent
	 */
	private checkUsageWarnings(model: string): void {
		const fiveHourUsage = this.getUsagePercentage("5hour");
		const weeklyUsage = this.getUsagePercentage("week");
		const threshold = this.state.config.warningThreshold;

		// Proactive prevention at 95% to avoid hitting hard limits
		const preventionThreshold = 0.95;

		if (fiveHourUsage >= preventionThreshold) {
			console.warn(
				`🚨 Proactive rate limit prevention: ${(fiveHourUsage * 100).toFixed(1)}% of 5-hour limit used (${model})`,
			);
			this.triggerProactivePause(model as "haiku" | "sonnet" | "opus", "5-hour");
			return;
		}

		if (weeklyUsage >= preventionThreshold) {
			console.warn(
				`🚨 Proactive rate limit prevention: ${(weeklyUsage * 100).toFixed(1)}% of weekly limit used (${model})`,
			);
			this.triggerProactivePause(model as "haiku" | "sonnet" | "opus", "weekly");
			return;
		}

		// Standard warnings
		if (fiveHourUsage >= threshold) {
			console.warn(`⚠️  Rate limit warning: ${(fiveHourUsage * 100).toFixed(1)}% of 5-hour limit used (${model})`);
		}

		if (weeklyUsage >= threshold) {
			console.warn(`⚠️  Rate limit warning: ${(weeklyUsage * 100).toFixed(1)}% of weekly limit used (${model})`);
		}
	}

	/**
	 * Trigger proactive pause to prevent hitting rate limits
	 */
	private triggerProactivePause(model: "haiku" | "sonnet" | "opus", limitType: "5-hour" | "weekly"): void {
		const now = new Date();
		let resumeAt: Date;

		if (limitType === "5-hour") {
			// Calculate when oldest tokens in 5-hour window will expire
			const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
			const oldestRelevantQuest = this.state.quests
				.filter((q) => q.timestamp >= fiveHoursAgo)
				.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];

			if (oldestRelevantQuest) {
				// Resume when oldest quest ages out + 5min buffer
				resumeAt = new Date(oldestRelevantQuest.timestamp.getTime() + 5 * 60 * 60 * 1000 + 5 * 60 * 1000);
			} else {
				// Default to 30 minutes if no quest data
				resumeAt = new Date(now.getTime() + 30 * 60 * 1000);
			}
		} else {
			// Weekly limit - wait until oldest weekly tokens expire
			const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
			const oldestWeeklyQuest = this.state.quests
				.filter((q) => q.timestamp >= weekAgo)
				.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];

			if (oldestWeeklyQuest) {
				// Resume when oldest quest ages out + 30min buffer
				resumeAt = new Date(oldestWeeklyQuest.timestamp.getTime() + 7 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
			} else {
				// Default to 2 hours if no quest data
				resumeAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
			}
		}

		this.pauseForRateLimit(model, `Proactive pause to prevent hitting ${limitType} rate limit`, undefined, undefined);

		// Override the resume time with calculated proactive time
		if (this.state.pause.modelPauses) {
			this.state.pause.modelPauses[model] = {
				...this.state.pause.modelPauses[model],
				resumeAt,
			};
		}
		this.state.pause.resumeAt = resumeAt;

		console.log(`🛡️  Proactive ${limitType} pause for ${model} - resume at ${resumeAt.toISOString()}`);
	}

	/**
	 * Clean up old quest entries beyond the tracking window
	 */
	private cleanupOldEntries(): void {
		const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days (1 week + buffer)

		const originalLength = this.state.quests.length;
		this.state.quests = this.state.quests.filter((quest) => quest.timestamp >= cutoff);

		const cleaned = originalLength - this.state.quests.length;
		if (cleaned > 0) {
			console.log(`🧹 Cleaned up ${cleaned} old quest entries`);
		}

		// Also clean up old rate limit hits
		const originalHits = this.state.rateLimitHits.length;
		this.state.rateLimitHits = this.state.rateLimitHits.filter((hit) => hit.timestamp >= cutoff);

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
		const sonnetEquivalentTokens = modelQuests.reduce((sum, q) => sum + q.tokens.sonnetEquivalentTokens, 0);
		const last24Hours = modelQuests
			.filter((q) => q.timestamp >= yesterday)
			.reduce((sum, q) => sum + q.tokens.totalTokens, 0);
		const rateLimitHits = this.state.rateLimitHits.filter((hit) => hit.model === model).length;

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
		current: {
			last5Hours: number;
			currentWeek: number;
			last5HoursSonnet: number;
			currentWeekSonnet: number;
		};
		percentages: { fiveHour: number; weekly: number };
		modelBreakdown: Record<
			string,
			{
				totalQuests: number;
				totalTokens: number;
				sonnetEquivalentTokens: number;
				last24Hours: number;
				rateLimitHits: number;
			}
		>;
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
			`=${"=".repeat(25)}`,
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
					`${usage.rateLimitHits} rate limit hits`,
			);
		}

		lines.push("", `Total rate limit hits: ${totalRateLimitHits}`);

		if (totalRateLimitHits > 0) {
			lines.push("", "Recent Rate Limit Hits:");
			const recentHits = this.state.rateLimitHits.slice(-3).reverse();

			for (const hit of recentHits) {
				lines.push(
					`  ${hit.timestamp.toISOString()} - ${hit.model} (${hit.currentUsage.last5HoursSonnet.toLocaleString()} tokens)`,
				);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Pause system due to rate limit hit
	 */
	pauseForRateLimit(
		model: "haiku" | "sonnet" | "opus",
		errorMessage?: string,
		pausedAgentCount?: number,
		responseHeaders?: Record<string, string>,
	): void {
		const now = new Date();

		// Try to extract retry-after from headers first
		const retryAfterMs = RateLimitTracker.extractRetryAfter(responseHeaders);
		let resumeAt: Date;

		if (retryAfterMs) {
			// Use API-provided retry-after time
			resumeAt = new Date(now.getTime() + retryAfterMs);
			console.log(`📡 Using API retry-after: ${retryAfterMs / 1000} seconds`);
		} else {
			// Fallback to intelligent estimation based on usage patterns
			resumeAt = this.estimateResumeTime(model, now);
		}

		// Initialize modelPauses if not exists
		if (!this.state.pause.modelPauses) {
			this.state.pause.modelPauses = {
				haiku: { isPaused: false },
				sonnet: { isPaused: false },
				opus: { isPaused: false },
			};
		}

		// Pause the specific model
		this.state.pause.modelPauses[model] = {
			isPaused: true,
			pausedAt: now,
			resumeAt,
			reason: errorMessage || `Rate limit hit for ${model} model`,
		};

		// Update global pause state (backward compatibility)
		this.state.pause = {
			...this.state.pause,
			isPaused: true,
			pausedAt: now,
			resumeAt,
			limitedModel: model,
			pausedAgentCount: pausedAgentCount || 0,
			reason: errorMessage || `Rate limit hit for ${model} model`,
		};

		this.state.lastUpdated = now;

		console.log(`🚨 Rate limit hit for ${model} model - pausing ${model} agents only`);
		this.logPauseStatus();
	}

	/**
	 * Estimate resume time based on usage patterns when no retry-after header
	 */
	private estimateResumeTime(_model: "haiku" | "sonnet" | "opus", now: Date): Date {
		const usage = this.getCurrentUsage();
		const config = this.state.config;

		// Check if we're hitting 5-hour window limit
		const fiveHourUsagePercent = usage.last5HoursSonnet / config.maxTokensPer5Hours;

		if (fiveHourUsagePercent >= 0.95) {
			// Close to 5-hour limit, wait for oldest tokens to age out
			const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
			const oldestRelevantQuest = this.state.quests
				.filter((q) => q.timestamp >= fiveHoursAgo)
				.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];

			if (oldestRelevantQuest) {
				// Resume when oldest quest ages out of 5-hour window + 10min buffer
				return new Date(oldestRelevantQuest.timestamp.getTime() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000);
			}
		}

		// Default fallback - wait 1 hour for temporary limits
		return new Date(now.getTime() + 60 * 60 * 1000);
	}

	/**
	 * Check if system should auto-resume from rate limit pause
	 */
	checkAutoResume(): boolean {
		if (!this.state.pause.isPaused) {
			return false;
		}

		const now = new Date();
		let anyResumed = false;

		// Enhanced monitoring: Check if usage has naturally decreased below limits
		if (this.shouldResumeBasedOnUsage()) {
			console.log("📊 Usage has dropped below limits - resuming all models");
			this.resumeFromRateLimit();
			return true;
		}

		// Check per-model pauses first
		if (this.state.pause.modelPauses) {
			for (const [model, pause] of Object.entries(this.state.pause.modelPauses)) {
				if (pause.isPaused && pause.resumeAt && now >= pause.resumeAt) {
					this.resumeModel(model as "haiku" | "sonnet" | "opus");
					anyResumed = true;
				}
			}
		}

		// Check global pause for backward compatibility
		if (this.state.pause.resumeAt && now >= this.state.pause.resumeAt) {
			this.resumeFromRateLimit();
			anyResumed = true;
		}

		return anyResumed;
	}

	/**
	 * Check if usage has naturally decreased below rate limits
	 */
	private shouldResumeBasedOnUsage(): boolean {
		const usage = this.getCurrentUsage();
		const config = this.state.config;

		// Allow 10% buffer below limit to avoid oscillation
		const resumeThreshold = 0.9;

		const fiveHourUsagePercent = usage.last5HoursSonnet / config.maxTokensPer5Hours;
		const weeklyUsagePercent = usage.currentWeekSonnet / config.maxTokensPerWeek;

		// Resume if both windows are safely below limits
		return fiveHourUsagePercent < resumeThreshold && weeklyUsagePercent < resumeThreshold;
	}

	/**
	 * Enhanced monitoring - call this frequently to check quota resets
	 */
	continuousMonitoring(): {
		shouldResume: boolean;
		currentUsage: ReturnType<RateLimitTracker["getCurrentUsage"]>;
		timeUntilResume?: number;
	} {
		const currentUsage = this.getCurrentUsage();
		const shouldResume = this.checkAutoResume();

		let timeUntilResume: number | undefined;
		if (this.state.pause.isPaused && !shouldResume) {
			timeUntilResume = this.getRemainingPauseTime();
		}

		return {
			shouldResume,
			currentUsage,
			timeUntilResume,
		};
	}

	/**
	 * Resume a specific model from rate limit pause
	 */
	resumeModel(model: "haiku" | "sonnet" | "opus"): void {
		if (!this.state.pause.modelPauses?.[model]?.isPaused) {
			return;
		}

		// Ensure modelPauses exists
		if (!this.state.pause.modelPauses) {
			return;
		}

		// Resume the specific model
		this.state.pause.modelPauses[model] = {
			...this.state.pause.modelPauses[model],
			isPaused: false,
		};

		// Check if all models are now unpaused
		const stillPaused = Object.values(this.state.pause.modelPauses).some((pause) => pause.isPaused);

		if (!stillPaused) {
			// No models are paused, resume globally
			this.state.pause.isPaused = false;
		}

		this.state.lastUpdated = new Date();

		console.log(`✅ ${model} model resumed from rate limit pause`);
		if (!stillPaused) {
			console.log(`✅ All models resumed - squad fully operational`);
		}
	}

	/**
	 * Resume system from rate limit pause (legacy method)
	 */
	resumeFromRateLimit(): void {
		if (!this.state.pause.isPaused) {
			return;
		}

		// Clear all model pauses
		if (this.state.pause.modelPauses) {
			for (const model of Object.keys(this.state.pause.modelPauses) as Array<"haiku" | "sonnet" | "opus">) {
				this.state.pause.modelPauses[model] = {
					...this.state.pause.modelPauses[model],
					isPaused: false,
				};
			}
		}

		this.state.pause = { isPaused: false };
		this.state.lastUpdated = new Date();

		console.log(`✅ Squad resumed from rate limit pause`);
	}

	/**
	 * Get current pause state
	 */
	getPauseState(): RateLimitPause {
		return { ...this.state.pause };
	}

	/**
	 * Check if system is currently paused
	 */
	isPaused(): boolean {
		return this.state.pause.isPaused;
	}

	/**
	 * Check if a specific model is currently paused
	 */
	isModelPaused(model: "haiku" | "sonnet" | "opus"): boolean {
		return this.state.pause.modelPauses?.[model]?.isPaused ?? false;
	}

	/**
	 * Get pause state for a specific model
	 */
	getModelPauseState(model: "haiku" | "sonnet" | "opus") {
		return this.state.pause.modelPauses?.[model];
	}

	/**
	 * Get remaining pause time in milliseconds
	 */
	getRemainingPauseTime(): number {
		if (!this.state.pause.isPaused || !this.state.pause.resumeAt) {
			return 0;
		}

		const now = new Date();
		const remaining = this.state.pause.resumeAt.getTime() - now.getTime();
		return Math.max(0, remaining);
	}

	/**
	 * Format remaining pause time as human-readable string
	 */
	formatRemainingTime(): string {
		const remainingMs = this.getRemainingPauseTime();
		if (remainingMs === 0) {
			return "0:00";
		}

		const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
		const hours = Math.floor(remainingMinutes / 60);
		const minutes = remainingMinutes % 60;

		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, "0")}`;
		} else {
			return `0:${minutes.toString().padStart(2, "0")}`;
		}
	}

	/**
	 * Log current pause status with enhanced countdown
	 */
	logPauseStatus(): void {
		if (!this.state.pause.isPaused) {
			return;
		}

		const remaining = this.formatRemainingTime();
		const agentCount = this.state.pause.pausedAgentCount || 0;
		const model = this.state.pause.limitedModel || "unknown";

		// Enhanced display with actual resume time
		const resumeTime = this.state.pause.resumeAt;
		const resumeTimeStr = resumeTime ? resumeTime.toLocaleString() : "unknown";

		console.log(`⏳ Rate limit pause: ${remaining} remaining (${agentCount} agents paused, ${model} model)`);
		console.log(`🕒 Resume at: ${resumeTimeStr}`);

		// Show per-model status if available
		if (this.state.pause.modelPauses) {
			const pausedModels = Object.entries(this.state.pause.modelPauses)
				.filter(([_, pause]) => pause.isPaused)
				.map(([model, pause]) => {
					const modelResume = pause.resumeAt ? pause.resumeAt.toLocaleString() : "unknown";
					const modelRemaining = pause.resumeAt
						? this.formatTimeRemaining(pause.resumeAt.getTime() - Date.now())
						: "unknown";
					return `  ${model}: ${modelRemaining} (until ${modelResume})`;
				});

			if (pausedModels.length > 0) {
				console.log("📊 Per-model status:");
				for (const status of pausedModels) {
					console.log(status);
				}
			}
		}
	}

	/**
	 * Format time remaining in a human-readable way
	 */
	private formatTimeRemaining(remainingMs: number): string {
		if (remainingMs <= 0) return "0:00";

		const totalMinutes = Math.ceil(remainingMs / (60 * 1000));
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;

		if (hours > 24) {
			const days = Math.floor(hours / 24);
			const remainingHours = hours % 24;
			return `${days}d ${remainingHours}h`;
		} else if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, "0")}`;
		} else {
			return `0:${minutes.toString().padStart(2, "0")}`;
		}
	}

	/**
	 * Check if a 429 error is in the message/response
	 */
	static is429Error(error: unknown): boolean {
		if (!error) return false;

		const errorStr = typeof error === "string" ? error : String(error);
		const lower = errorStr.toLowerCase();

		return (
			lower.includes("429") ||
			lower.includes("rate limit") ||
			lower.includes("quota exceeded") ||
			lower.includes("too many requests")
		);
	}

	/**
	 * Extract retry-after header from 429 response (if available)
	 */
	static extractRetryAfter(responseHeaders?: Record<string, string>): number | null {
		if (!responseHeaders) return null;

		const retryAfter = responseHeaders["retry-after"] || responseHeaders["Retry-After"];
		if (!retryAfter) return null;

		const seconds = parseInt(retryAfter, 10);
		return Number.isNaN(seconds) ? null : seconds * 1000; // Convert to milliseconds
	}

	/**
	 * Enhanced header processing to extract more rate limit metadata
	 */
	static processRateLimitHeaders(responseHeaders?: Record<string, string>): {
		retryAfter?: number; // milliseconds
		limit?: number;
		remaining?: number;
		reset?: Date;
		resetEpoch?: number;
		windowSize?: string;
	} {
		if (!responseHeaders) return {};

		const result: any = {};

		// Retry-After (RFC 7231)
		const retryAfter = responseHeaders["retry-after"] || responseHeaders["Retry-After"];
		if (retryAfter) {
			const seconds = parseInt(retryAfter, 10);
			if (!Number.isNaN(seconds)) {
				result.retryAfter = seconds * 1000;
			}
		}

		// Common rate limit headers (Anthropic/OpenAI style)
		const limit = responseHeaders["x-ratelimit-limit"] || responseHeaders["X-RateLimit-Limit"];
		if (limit) {
			const limitNum = parseInt(limit, 10);
			if (!Number.isNaN(limitNum)) {
				result.limit = limitNum;
			}
		}

		const remaining = responseHeaders["x-ratelimit-remaining"] || responseHeaders["X-RateLimit-Remaining"];
		if (remaining) {
			const remainingNum = parseInt(remaining, 10);
			if (!Number.isNaN(remainingNum)) {
				result.remaining = remainingNum;
			}
		}

		// Rate limit reset time
		const reset = responseHeaders["x-ratelimit-reset"] || responseHeaders["X-RateLimit-Reset"];
		if (reset) {
			const resetEpoch = parseInt(reset, 10);
			if (!Number.isNaN(resetEpoch)) {
				result.resetEpoch = resetEpoch;
				result.reset = new Date(resetEpoch * 1000); // Convert from seconds to milliseconds
			}
		}

		// Window size information
		const window = responseHeaders["x-ratelimit-window"] || responseHeaders["X-RateLimit-Window"];
		if (window) {
			result.windowSize = window;
		}

		return result;
	}

	/**
	 * Log detailed rate limit information from headers
	 */
	private logRateLimitHeaders(headers?: Record<string, string>): void {
		if (!headers) return;

		const metadata = RateLimitTracker.processRateLimitHeaders(headers);

		if (Object.keys(metadata).length > 0) {
			console.log("📡 Rate limit headers received:", {
				limit: metadata.limit,
				remaining: metadata.remaining,
				reset: metadata.reset?.toISOString(),
				windowSize: metadata.windowSize,
				retryAfterMs: metadata.retryAfter,
			});
		}
	}
}
