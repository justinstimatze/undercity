/**
 * Enhanced Metrics Integration
 *
 * Integration points for the enhanced metrics system with the existing
 * raid orchestrator, error escalation, and agent spawning systems.
 */

import { getEnhancedMetricsCollector } from "./enhanced-metrics.js";
import { raidLogger } from "./logger.js";
import type { AgentType, AttemptRecord } from "./types.js";

/**
 * Integration wrapper for tracking enhanced metrics in existing systems
 */
export class EnhancedMetricsIntegration {
	private static instance: EnhancedMetricsIntegration;

	static getInstance(): EnhancedMetricsIntegration {
		if (!this.instance) {
			this.instance = new EnhancedMetricsIntegration();
		}
		return this.instance;
	}

	/**
	 * Hook into quest start to begin enhanced tracking
	 */
	onQuestStart(questId: string, objective: string, raidId: string): void {
		const collector = getEnhancedMetricsCollector();
		collector.startQuest(questId, objective, raidId);

		raidLogger.debug({
			questId,
			objective: objective.slice(0, 100) + (objective.length > 100 ? "..." : ""),
			raidId
		}, "Enhanced metrics tracking started");
	}

	/**
	 * Hook into agent spawning to track token usage and model choices
	 */
	onAgentActivity(
		agentType: AgentType,
		model: "haiku" | "sonnet" | "opus",
		inputTokens: number,
		outputTokens: number,
		operation: "planning" | "execution" | "review" | "rework" | "escalation",
		successful: boolean
	): void {
		const collector = getEnhancedMetricsCollector();
		collector.recordTokenUsage(model, inputTokens, outputTokens, operation, agentType, successful);
		collector.recordAttemptOutcome(model, successful);

		raidLogger.debug({
			agentType,
			model,
			inputTokens,
			outputTokens,
			operation,
			successful
		}, "Agent activity tracked");
	}

	/**
	 * Hook into error escalation to track model escalations
	 */
	onModelEscalation(
		questId: string,
		from: "haiku" | "sonnet" | "opus",
		to: "haiku" | "sonnet" | "opus",
		reason: string,
		previousAttempts: number,
		tokensBeforeEscalation: number,
		triggerError?: string
	): void {
		const collector = getEnhancedMetricsCollector();
		collector.recordModelEscalation(from, to, reason, previousAttempts, tokensBeforeEscalation, triggerError);

		raidLogger.info({
			questId,
			escalation: `${from} → ${to}`,
			reason,
			previousAttempts,
			tokensBeforeEscalation
		}, "Model escalation tracked");
	}

	/**
	 * Hook into timing tracking for quest phases
	 */
	onPhaseComplete(phase: "planning" | "execution" | "review" | "idle", durationMs: number): void {
		const collector = getEnhancedMetricsCollector();
		collector.recordTiming(phase, durationMs);

		raidLogger.debug({ phase, durationMs }, "Phase timing tracked");
	}

	/**
	 * Hook into quest completion to generate enhanced metrics
	 */
	onQuestComplete(
		questId: string,
		success: boolean,
		totalTokens: number,
		agentTypes: AgentType[],
		attempts: AttemptRecord[] = [],
		finalModel?: "haiku" | "sonnet" | "opus"
	): void {
		const collector = getEnhancedMetricsCollector();

		// Create base metrics that match the existing QuestMetrics interface
		const baseMetrics = {
			questId,
			raidId: "", // Will be filled by the collector
			objective: "", // Will be filled by the collector
			success,
			durationMs: 0, // Will be calculated by the collector
			totalTokens,
			agentsSpawned: agentTypes.length,
			agentTypes,
			startedAt: new Date(), // Will be overridden by the collector
			completedAt: new Date(),
			attempts,
			finalModel,
		};

		const enhancedMetrics = collector.completeQuest(baseMetrics);

		if (enhancedMetrics) {
			raidLogger.info({
				questId,
				success,
				totalTokens,
				escalations: enhancedMetrics.escalation.escalationCount,
				efficiencyRatio: enhancedMetrics.tokenUsage.efficiency.efficiencyRatio,
				modelChain: enhancedMetrics.escalation.modelChain
			}, "Enhanced quest metrics generated");
		} else {
			raidLogger.warn({ questId }, "Failed to generate enhanced quest metrics");
		}
	}

	/**
	 * Extract token usage from Claude SDK response messages
	 */
	extractTokensFromResponse(response: any): { inputTokens: number; outputTokens: number } | null {
		try {
			// Handle different Claude SDK response formats
			if (response?.usage) {
				return {
					inputTokens: response.usage.input_tokens || response.usage.inputTokens || 0,
					outputTokens: response.usage.output_tokens || response.usage.outputTokens || 0,
				};
			}

			if (response?.metadata?.usage) {
				return {
					inputTokens: response.metadata.usage.input_tokens || response.metadata.usage.inputTokens || 0,
					outputTokens: response.metadata.usage.output_tokens || response.metadata.usage.outputTokens || 0,
				};
			}

			if (response?.meta?.usage) {
				return {
					inputTokens: response.meta.usage.input_tokens || response.meta.usage.inputTokens || 0,
					outputTokens: response.meta.usage.output_tokens || response.meta.usage.outputTokens || 0,
				};
			}

			// Direct token properties
			if (response?.inputTokens !== undefined && response?.outputTokens !== undefined) {
				return {
					inputTokens: response.inputTokens,
					outputTokens: response.outputTokens,
				};
			}

			if (response?.input_tokens !== undefined && response?.output_tokens !== undefined) {
				return {
					inputTokens: response.input_tokens,
					outputTokens: response.output_tokens,
				};
			}

			return null;
		} catch (error) {
			raidLogger.warn({ error: String(error) }, "Failed to extract tokens from response");
			return null;
		}
	}

	/**
	 * Helper to determine operation type based on context
	 */
	determineOperationType(
		agentType: AgentType,
		isRetry: boolean = false,
		isEscalation: boolean = false
	): "planning" | "execution" | "review" | "rework" | "escalation" {
		if (isEscalation) return "escalation";
		if (isRetry) return "rework";

		switch (agentType) {
			case "flute":
			case "logistics":
				return "planning";
			case "quester":
				return "execution";
			case "sheriff":
				return "review";
			default:
				return "execution";
		}
	}

	/**
	 * Helper to determine if a model change represents an escalation
	 */
	isModelEscalation(from: "haiku" | "sonnet" | "opus", to: "haiku" | "sonnet" | "opus"): boolean {
		const modelTiers = { haiku: 1, sonnet: 2, opus: 3 };
		return modelTiers[to] > modelTiers[from];
	}

	/**
	 * Helper to infer escalation reason from error context
	 */
	inferEscalationReason(error?: string | Error, attemptCount: number = 1): string {
		const errorMessage = error instanceof Error ? error.message : (error || "");
		const lowerError = errorMessage.toLowerCase();

		if (lowerError.includes("rate limit") || lowerError.includes("429")) {
			return "Rate limit exceeded";
		}

		if (lowerError.includes("timeout") || lowerError.includes("time out")) {
			return "Request timeout";
		}

		if (lowerError.includes("complexity") || lowerError.includes("complex")) {
			return "Task complexity too high";
		}

		if (lowerError.includes("context") || lowerError.includes("length")) {
			return "Context length exceeded";
		}

		if (lowerError.includes("quality") || lowerError.includes("review")) {
			return "Quality review failure";
		}

		if (attemptCount > 3) {
			return "Multiple attempt failures";
		}

		if (attemptCount > 1) {
			return "Retry escalation";
		}

		return "General error escalation";
	}
}

/**
 * Convenience function to get the integration instance
 */
export function getEnhancedMetricsIntegration(): EnhancedMetricsIntegration {
	return EnhancedMetricsIntegration.getInstance();
}