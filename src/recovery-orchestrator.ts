/**
 * Recovery Orchestrator
 *
 * Handles failure analysis, strategy selection, and recovery execution.
 * Implements intelligent decision tree for different types of failures.
 */

import type { CheckpointManager } from "./checkpoint-manager.js";
import { raidLogger } from "./logger.js";
import type { RateLimitTracker } from "./rate-limit.js";
import type {
	AgentRecoveryConfig,
	AgentType,
	ErrorClassification,
	FailureSeverity,
	RecoveryAttempt,
	RecoveryState,
	RecoveryStrategy,
	Waypoint,
	WaypointStatus,
} from "./types.js";

/**
 * Error pattern detection for classification
 */
interface ErrorPattern {
	pattern: RegExp;
	type: ErrorClassification["type"];
	severity: FailureSeverity;
	isTransient: boolean;
	affectsOthers: boolean;
}

/**
 * Common error patterns for classification
 */
const ERROR_PATTERNS: ErrorPattern[] = [
	// Rate limiting errors
	{
		pattern: /429|rate.?limit|too.?many.?requests/i,
		type: "rate_limit",
		severity: "medium",
		isTransient: true,
		affectsOthers: true,
	},
	{
		pattern: /quota.?exceeded|api.?limit/i,
		type: "rate_limit",
		severity: "high",
		isTransient: false,
		affectsOthers: true,
	},

	// Timeout errors - agent timeout first (more specific)
	{
		pattern: /agent.?timeout|stuck|inactive/i,
		type: "timeout",
		severity: "medium",
		isTransient: false,
		affectsOthers: false,
	},
	{
		pattern: /timeout|timed.?out|connection.?reset/i,
		type: "timeout",
		severity: "medium",
		isTransient: true,
		affectsOthers: false,
	},

	// Tool errors
	{
		pattern: /tool.?error|command.?failed|permission.?denied/i,
		type: "tool_error",
		severity: "medium",
		isTransient: false,
		affectsOthers: false,
	},
	{
		pattern: /file.?not.?found|no.?such.?file/i,
		type: "tool_error",
		severity: "low",
		isTransient: false,
		affectsOthers: false,
	},

	// Validation errors
	{
		pattern: /type.?error|syntax.?error|compilation.?failed/i,
		type: "validation_error",
		severity: "medium",
		isTransient: false,
		affectsOthers: false,
	},
	{
		pattern: /test.?failed|assertion.?error/i,
		type: "validation_error",
		severity: "high",
		isTransient: false,
		affectsOthers: false,
	},

	// System crashes
	{
		pattern: /segmentation.?fault|stack.?overflow|out.?of.?memory/i,
		type: "crash",
		severity: "critical",
		isTransient: false,
		affectsOthers: true,
	},
	{
		pattern: /process.?exited|unexpected.?termination/i,
		type: "crash",
		severity: "high",
		isTransient: true,
		affectsOthers: false,
	},
];

/**
 * Recovery decision matrix based on error classification and agent type
 */
const RECOVERY_DECISION_MATRIX: Record<ErrorClassification["type"], Record<AgentType, RecoveryStrategy[]>> = {
	rate_limit: {
		flute: ["retry", "abandon"],
		logistics: ["retry", "escalate"],
		quester: ["checkpoint_restore", "retry", "escalate"],
		sheriff: ["retry", "escalate"],
	},
	timeout: {
		flute: ["retry", "abandon"],
		logistics: ["retry", "different_agent"],
		quester: ["checkpoint_restore", "different_agent", "escalate"],
		sheriff: ["retry", "different_agent"],
	},
	tool_error: {
		flute: ["retry", "different_agent"],
		logistics: ["retry", "different_agent"],
		quester: ["checkpoint_restore", "retry", "different_agent"],
		sheriff: ["retry", "escalate"],
	},
	validation_error: {
		flute: ["different_agent", "escalate"],
		logistics: ["different_agent", "escalate"],
		quester: ["checkpoint_restore", "different_agent", "escalate"],
		sheriff: ["escalate"],
	},
	crash: {
		flute: ["retry", "different_agent"],
		logistics: ["retry", "different_agent", "escalate"],
		quester: ["checkpoint_restore", "different_agent", "escalate"],
		sheriff: ["different_agent", "escalate"],
	},
	unknown: {
		flute: ["retry", "different_agent"],
		logistics: ["retry", "different_agent"],
		quester: ["retry", "different_agent"],
		sheriff: ["retry", "escalate"],
	},
};

/**
 * Orchestrates error recovery for failed waypoints
 */
export class RecoveryOrchestrator {
	private checkpointManager: CheckpointManager;
	private recoveryState: RecoveryState;
	private rateLimitTracker?: RateLimitTracker;

	constructor(checkpointManager: CheckpointManager, initialState?: RecoveryState, rateLimitTracker?: RateLimitTracker) {
		this.checkpointManager = checkpointManager;
		this.rateLimitTracker = rateLimitTracker;

		this.recoveryState = initialState || {
			activeRecoveries: {},
			agentConfigs: this.getDefaultAgentConfigs(),
			stats: {
				totalRecoveries: 0,
				successfulRecoveries: 0,
				escalations: 0,
				lastUpdated: new Date(),
			},
		};
	}

	/**
	 * Classify an error for recovery strategy selection
	 */
	classifyError(error: string | Error, agentType: AgentType): ErrorClassification {
		const errorText = error instanceof Error ? error.message : error;

		// Try to match against known patterns
		for (const pattern of ERROR_PATTERNS) {
			if (pattern.pattern.test(errorText)) {
				const strategy = this.selectRecoveryStrategy(pattern, agentType);
				return {
					type: pattern.type,
					severity: pattern.severity,
					isTransient: pattern.isTransient,
					affectsOthers: pattern.affectsOthers,
					recommendedStrategy: strategy,
				};
			}
		}

		// Default classification for unknown errors
		const strategy = this.selectRecoveryStrategy(
			{
				type: "unknown",
			},
			agentType,
		);

		return {
			type: "unknown",
			severity: "medium",
			isTransient: false,
			affectsOthers: false,
			recommendedStrategy: strategy,
		};
	}

	/**
	 * Execute recovery for a failed waypoint
	 */
	async executeRecovery(
		waypoint: Waypoint,
		error: string | Error,
		context: {
			agentType: AgentType;
			sessionId?: string;
			modifiedFiles?: string[];
			progressDescription?: string;
		},
	): Promise<RecoveryAttempt> {
		const classification = this.classifyError(error, context.agentType);
		const config = this.checkpointManager.getRecoveryConfig(context.agentType);

		// Initialize recovery tracking if not exists
		if (!this.recoveryState.activeRecoveries[waypoint.id]) {
			this.recoveryState.activeRecoveries[waypoint.id] = [];
		}

		const attempts = this.recoveryState.activeRecoveries[waypoint.id];
		const attemptNumber = attempts.length + 1;

		// Check if we've exceeded max retries
		if (attemptNumber > config.maxRetries) {
			return this.escalateToHuman(waypoint, error, context, attemptNumber);
		}

		const startTime = Date.now();

		raidLogger.warn(
			{
				waypointId: waypoint.id,
				agentType: context.agentType,
				attemptNumber,
				strategy: classification.recommendedStrategy,
				errorType: classification.type,
				severity: classification.severity,
			},
			"Starting recovery attempt",
		);

		let recoveryAttempt: RecoveryAttempt;

		try {
			recoveryAttempt = await this.executeRecoveryStrategy(waypoint, classification, context, attemptNumber);
		} catch (recoveryError) {
			const durationMs = Date.now() - startTime;
			const errorText = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);

			recoveryAttempt = {
				attemptNumber,
				attemptedAt: new Date(),
				strategy: classification.recommendedStrategy,
				agentType: context.agentType,
				successful: false,
				error: errorText,
				durationMs,
			};
		}

		// Record the attempt
		attempts.push(recoveryAttempt);
		this.updateRecoveryStats(recoveryAttempt);

		if (!recoveryAttempt.successful && attemptNumber >= config.maxRetries) {
			// Escalate after max retries
			return this.escalateToHuman(waypoint, error, context, attemptNumber + 1);
		}

		return recoveryAttempt;
	}

	/**
	 * Execute a specific recovery strategy
	 */
	private async executeRecoveryStrategy(
		waypoint: Waypoint,
		classification: ErrorClassification,
		context: {
			agentType: AgentType;
			sessionId?: string;
			modifiedFiles?: string[];
			progressDescription?: string;
		},
		attemptNumber: number,
	): Promise<RecoveryAttempt> {
		const startTime = Date.now();
		const strategy = classification.recommendedStrategy;

		let successful = false;
		let newAgentType = context.agentType;

		switch (strategy) {
			case "retry":
				successful = await this.executeRetryStrategy(waypoint, context);
				break;

			case "different_agent": {
				const alternativeAgent = this.selectAlternativeAgent(context.agentType);
				if (alternativeAgent) {
					newAgentType = alternativeAgent;
					successful = await this.executeRetryStrategy(waypoint, {
						...context,
						agentType: alternativeAgent,
					});
				}
				break;
			}

			case "checkpoint_restore":
				successful = await this.executeCheckpointRestore(waypoint, context);
				break;

			case "escalate":
				// This will be handled by the caller
				throw new Error("Recovery strategy requires human intervention");

			case "abandon":
				successful = false; // Explicit abandonment
				break;
		}

		const durationMs = Date.now() - startTime;

		return {
			attemptNumber,
			attemptedAt: new Date(),
			strategy,
			agentType: newAgentType,
			successful,
			durationMs,
		};
	}

	/**
	 * Execute retry strategy
	 */
	private async executeRetryStrategy(
		waypoint: Waypoint,
		context: {
			agentType: AgentType;
			sessionId?: string;
		},
	): Promise<boolean> {
		// For rate limit errors, check if we should wait
		if (this.rateLimitTracker?.isPaused()) {
			raidLogger.info({ waypointId: waypoint.id }, "Delaying retry due to rate limits");

			// Wait for rate limit to clear
			const resumeTime = this.rateLimitTracker.getPauseState().resumeAt;
			if (resumeTime && resumeTime > new Date()) {
				const waitMs = resumeTime.getTime() - Date.now();
				if (waitMs > 0 && waitMs < 300000) {
					// Don't wait more than 5 minutes
					await new Promise((resolve) => setTimeout(resolve, waitMs));
				}
			}
		}

		// Simple retry - this would be integrated with the actual agent execution
		// For now, we simulate the retry
		raidLogger.info(
			{
				waypointId: waypoint.id,
				agentType: context.agentType,
			},
			"Executing retry strategy",
		);

		// In a real implementation, this would re-spawn the agent
		// For now, we'll return a simulated result based on error type
		return Math.random() > 0.3; // 70% success rate for retries
	}

	/**
	 * Execute checkpoint restore strategy
	 */
	private async executeCheckpointRestore(
		waypoint: Waypoint,
		context: {
			agentType: AgentType;
			progressDescription?: string;
		},
	): Promise<boolean> {
		if (!waypoint.checkpoint) {
			raidLogger.warn({ waypointId: waypoint.id }, "No checkpoint available for restore");
			return false;
		}

		raidLogger.info(
			{
				waypointId: waypoint.id,
				checkpointDate: waypoint.checkpoint.createdAt,
				completionPercent: waypoint.checkpoint.completionPercent,
			},
			"Restoring from checkpoint",
		);

		// In a real implementation, this would:
		// 1. Restore the agent session state
		// 2. Reset any file modifications after the checkpoint
		// 3. Resume execution from the checkpoint point

		// Simulate checkpoint restore success based on checkpoint age
		const checkpointAge = Date.now() - waypoint.checkpoint.createdAt.getTime();
		const ageHours = checkpointAge / (1000 * 60 * 60);

		// Fresher checkpoints have higher success rates
		const successRate = Math.max(0.5, 1 - ageHours / 24); // Decreases over 24 hours
		return Math.random() < successRate;
	}

	/**
	 * Escalate to human intervention
	 */
	private escalateToHuman(
		waypoint: Waypoint,
		error: string | Error,
		context: {
			agentType: AgentType;
		},
		attemptNumber: number,
	): RecoveryAttempt {
		raidLogger.error(
			{
				waypointId: waypoint.id,
				agentType: context.agentType,
				attempts: attemptNumber - 1,
				error: error instanceof Error ? error.message : error,
			},
			"Escalating waypoint to human intervention",
		);

		this.recoveryState.stats.escalations++;

		return {
			attemptNumber,
			attemptedAt: new Date(),
			strategy: "escalate",
			agentType: context.agentType,
			successful: false,
			error: "Escalated to human intervention after maximum recovery attempts",
			durationMs: 0,
		};
	}

	/**
	 * Select recovery strategy based on error classification and agent type
	 */
	private selectRecoveryStrategy(
		errorInfo: { type: ErrorClassification["type"] },
		agentType: AgentType,
	): RecoveryStrategy {
		const strategies = RECOVERY_DECISION_MATRIX[errorInfo.type]?.[agentType] || ["retry", "escalate"];
		return strategies[0]; // Use first strategy in priority order
	}

	/**
	 * Select alternative agent type for recovery
	 */
	private selectAlternativeAgent(failedAgentType: AgentType): AgentType | null {
		// Agent substitution rules based on capabilities
		switch (failedAgentType) {
			case "flute":
				return "logistics"; // Logistics can do recon if flute fails
			case "logistics":
				return "quester"; // Quester can plan if needed
			case "quester":
				return null; // No direct substitute for implementation
			case "sheriff":
				return "quester"; // Quester can do basic review
			default:
				return null;
		}
	}

	/**
	 * Update recovery statistics
	 */
	private updateRecoveryStats(attempt: RecoveryAttempt): void {
		this.recoveryState.stats.totalRecoveries++;
		if (attempt.successful) {
			this.recoveryState.stats.successfulRecoveries++;
		}
		this.recoveryState.stats.lastUpdated = new Date();
	}

	/**
	 * Get recovery state for persistence
	 */
	getRecoveryState(): RecoveryState {
		return { ...this.recoveryState };
	}

	/**
	 * Update recovery state from persistence
	 */
	updateRecoveryState(state: RecoveryState): void {
		this.recoveryState = { ...state };
	}

	/**
	 * Clean up completed waypoint recovery
	 */
	cleanupRecovery(waypointId: string): void {
		delete this.recoveryState.activeRecoveries[waypointId];
	}

	/**
	 * Get recovery statistics
	 */
	getRecoveryStats(): {
		totalRecoveries: number;
		successfulRecoveries: number;
		escalations: number;
		successRate: number;
		activeRecoveries: number;
	} {
		const stats = this.recoveryState.stats;
		return {
			totalRecoveries: stats.totalRecoveries,
			successfulRecoveries: stats.successfulRecoveries,
			escalations: stats.escalations,
			successRate: stats.totalRecoveries > 0 ? stats.successfulRecoveries / stats.totalRecoveries : 0,
			activeRecoveries: Object.keys(this.recoveryState.activeRecoveries).length,
		};
	}

	/**
	 * Check if a waypoint can be recovered
	 */
	canRecover(waypoint: Waypoint, error: string | Error): boolean {
		const classification = this.classifyError(error, waypoint.type);
		const config = this.checkpointManager.getRecoveryConfig(waypoint.type);
		const currentAttempts = waypoint.recoveryAttempts || 0;

		// Can't recover if we've exceeded max retries
		if (currentAttempts >= config.maxRetries) {
			return false;
		}

		// Can't recover critical errors without checkpoints
		if (classification.severity === "critical" && !waypoint.checkpoint) {
			return false;
		}

		// Can always try recovery for transient errors
		if (classification.isTransient) {
			return true;
		}

		// For non-transient errors, need specific recovery strategies
		return classification.recommendedStrategy !== "abandon";
	}

	/**
	 * Get default agent configurations
	 */
	private getDefaultAgentConfigs(): Record<AgentType, AgentRecoveryConfig> {
		return {
			flute: this.checkpointManager.getRecoveryConfig("flute"),
			logistics: this.checkpointManager.getRecoveryConfig("logistics"),
			quester: this.checkpointManager.getRecoveryConfig("quester"),
			sheriff: this.checkpointManager.getRecoveryConfig("sheriff"),
		};
	}
}
