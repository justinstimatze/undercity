/**
 * Error Escalation System
 *
 * Handles severity classification and escalation paths for failed waypoints.
 * Implements progressive escalation: retry → different agent → human intervention.
 */

import { raidLogger } from "./logger.js";
import type { AgentType, ErrorClassification, FailureSeverity, Waypoint, WaypointStatus } from "./types.js";

/**
 * Escalation level progression
 */
export type EscalationLevel =
	| "none" // No escalation needed
	| "auto_retry" // Automatic retry
	| "agent_change" // Try different agent type
	| "human_review" // Human needs to review
	| "human_intervention" // Human needs to act
	| "abort_raid"; // Abandon the raid

/**
 * Escalation decision context
 */
interface EscalationContext {
	/** Current waypoint */
	waypoint: Waypoint;
	/** Error that caused escalation */
	error: string | Error;
	/** Error classification */
	classification: ErrorClassification;
	/** Number of previous attempts */
	attemptCount: number;
	/** Time since first failure */
	timeSinceFirstFailure: number;
	/** Whether other waypoints are affected */
	affectsOtherWaypoints: boolean;
	/** Raid progress percentage */
	raidProgressPercent: number;
}

/**
 * Escalation decision result
 */
export interface EscalationDecision {
	/** Recommended escalation level */
	level: EscalationLevel;
	/** Reason for escalation */
	reason: string;
	/** Recommended next action */
	nextAction: string;
	/** Whether immediate action is required */
	urgent: boolean;
	/** Estimated impact if not resolved */
	impact: "low" | "medium" | "high" | "critical";
	/** Human-readable summary for notifications */
	summary: string;
}

/**
 * Escalation rules configuration
 */
interface EscalationRules {
	/** Maximum auto-retry attempts before escalation */
	maxAutoRetries: number;
	/** Maximum agent changes before human intervention */
	maxAgentChanges: number;
	/** Time limit before escalating (minutes) */
	timeoutMinutes: number;
	/** Severity threshold for immediate escalation */
	immediateEscalationSeverity: FailureSeverity;
}

/**
 * Default escalation rules by agent type
 */
const DEFAULT_ESCALATION_RULES: Record<AgentType, EscalationRules> = {
	flute: {
		maxAutoRetries: 2,
		maxAgentChanges: 1,
		timeoutMinutes: 10,
		immediateEscalationSeverity: "critical",
	},
	logistics: {
		maxAutoRetries: 3,
		maxAgentChanges: 1,
		timeoutMinutes: 30,
		immediateEscalationSeverity: "critical",
	},
	quester: {
		maxAutoRetries: 5,
		maxAgentChanges: 2,
		timeoutMinutes: 60,
		immediateEscalationSeverity: "high",
	},
	sheriff: {
		maxAutoRetries: 3,
		maxAgentChanges: 1,
		timeoutMinutes: 20,
		immediateEscalationSeverity: "critical",
	},
};

/**
 * Critical error patterns that require immediate escalation
 */
const CRITICAL_ERROR_PATTERNS = [
	/corruption/i,
	/data.?loss/i,
	/security.?breach/i,
	/unauthorized.?access/i,
	/malware/i,
	/virus/i,
	/critical.?system.?error/i,
	/disk.?full/i,
	/filesystem.?error/i,
];

/**
 * Error patterns that suggest raid should be aborted
 */
const ABORT_PATTERNS = [
	/invalid.?goal/i,
	/impossible.?task/i,
	/contradictory.?requirements/i,
	/insufficient.?permissions/i,
	/missing.?dependencies/i,
	/incompatible.?environment/i,
];

/**
 * Manages error escalation and severity classification
 */
export class ErrorEscalationManager {
	private escalationRules: Record<AgentType, EscalationRules>;
	private escalationHistory: Map<string, EscalationDecision[]> = new Map();

	constructor(customRules?: Partial<Record<AgentType, Partial<EscalationRules>>>) {
		this.escalationRules = { ...DEFAULT_ESCALATION_RULES };

		// Apply custom rules
		if (customRules) {
			for (const [agentType, rules] of Object.entries(customRules)) {
				if (rules) {
					this.escalationRules[agentType as AgentType] = {
						...this.escalationRules[agentType as AgentType],
						...rules,
					};
				}
			}
		}
	}

	/**
	 * Determine escalation level for a failed waypoint
	 */
	determineEscalation(context: EscalationContext): EscalationDecision {
		const rules = this.escalationRules[context.waypoint.type];
		const error = context.error instanceof Error ? context.error.message : context.error;

		// Check for critical patterns that require immediate escalation
		if (this.isCriticalError(error)) {
			return this.createCriticalEscalation(context, "Critical system error detected");
		}

		// Check for abort patterns
		if (this.shouldAbortRaid(error, context)) {
			return this.createAbortEscalation(context, "Fundamental issue requires raid abort");
		}

		// Check severity-based escalation
		if (context.classification.severity === rules.immediateEscalationSeverity) {
			return this.createHumanInterventionEscalation(
				context,
				`${context.classification.severity} severity error requires immediate attention`,
			);
		}

		// Check attempt-based escalation
		if (context.attemptCount >= rules.maxAutoRetries + rules.maxAgentChanges) {
			return this.createHumanInterventionEscalation(context, "Maximum recovery attempts exceeded");
		}

		// Check time-based escalation
		if (context.timeSinceFirstFailure > rules.timeoutMinutes * 60 * 1000) {
			return this.createHumanReviewEscalation(context, "Waypoint failure timeout exceeded");
		}

		// Check if affects other waypoints
		if (context.affectsOtherWaypoints && context.classification.severity !== "low") {
			return this.createAgentChangeEscalation(context, "Error affects multiple waypoints");
		}

		// Normal progression based on attempt count
		if (context.attemptCount < rules.maxAutoRetries) {
			return this.createAutoRetryEscalation(context, "Automatic retry attempt");
		}

		if (context.attemptCount < rules.maxAutoRetries + rules.maxAgentChanges) {
			return this.createAgentChangeEscalation(context, "Try different agent type");
		}

		// Fallback to human review
		return this.createHumanReviewEscalation(context, "Standard escalation path");
	}

	/**
	 * Check if error is critical and requires immediate escalation
	 */
	private isCriticalError(error: string): boolean {
		return CRITICAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
	}

	/**
	 * Check if raid should be aborted due to fundamental issues
	 */
	private shouldAbortRaid(error: string, context: EscalationContext): boolean {
		// Check for abort patterns
		if (ABORT_PATTERNS.some((pattern) => pattern.test(error))) {
			return true;
		}

		// Check for repeated failures across different agent types
		const history = this.escalationHistory.get(context.waypoint.id) || [];
		const agentTypesUsed = new Set(history.map((h) => h.summary.includes("agent")));

		if (agentTypesUsed.size >= 3 && context.attemptCount > 10) {
			return true;
		}

		// Check if raid is mostly failed
		if (context.raidProgressPercent < 20 && context.attemptCount > 5) {
			return true;
		}

		return false;
	}

	/**
	 * Create auto-retry escalation decision
	 */
	private createAutoRetryEscalation(context: EscalationContext, reason: string): EscalationDecision {
		return {
			level: "auto_retry",
			reason,
			nextAction: "Retry waypoint with same agent configuration",
			urgent: false,
			impact: "low",
			summary: `Auto-retry #${context.attemptCount + 1} for ${context.waypoint.type} waypoint`,
		};
	}

	/**
	 * Create agent change escalation decision
	 */
	private createAgentChangeEscalation(context: EscalationContext, reason: string): EscalationDecision {
		const alternativeAgent = this.suggestAlternativeAgent(context.waypoint.type);
		return {
			level: "agent_change",
			reason,
			nextAction: `Switch to ${alternativeAgent} agent for waypoint execution`,
			urgent: context.classification.severity === "high",
			impact: "medium",
			summary: `Switching from ${context.waypoint.type} to ${alternativeAgent} agent`,
		};
	}

	/**
	 * Create human review escalation decision
	 */
	private createHumanReviewEscalation(context: EscalationContext, reason: string): EscalationDecision {
		return {
			level: "human_review",
			reason,
			nextAction: "Human should review the waypoint failure and decide next steps",
			urgent: context.classification.severity === "high",
			impact: "medium",
			summary: `Human review needed for ${context.waypoint.type} waypoint failure`,
		};
	}

	/**
	 * Create human intervention escalation decision
	 */
	private createHumanInterventionEscalation(context: EscalationContext, reason: string): EscalationDecision {
		return {
			level: "human_intervention",
			reason,
			nextAction: "Human must take immediate action to resolve the issue",
			urgent: true,
			impact: "high",
			summary: `URGENT: Human intervention required for ${context.waypoint.type} waypoint`,
		};
	}

	/**
	 * Create critical escalation decision
	 */
	private createCriticalEscalation(context: EscalationContext, reason: string): EscalationDecision {
		return {
			level: "human_intervention",
			reason,
			nextAction: "CRITICAL: Immediate human response required",
			urgent: true,
			impact: "critical",
			summary: `CRITICAL: ${context.waypoint.type} waypoint has critical system error`,
		};
	}

	/**
	 * Create abort escalation decision
	 */
	private createAbortEscalation(context: EscalationContext, reason: string): EscalationDecision {
		return {
			level: "abort_raid",
			reason,
			nextAction: "Consider aborting the raid due to fundamental issues",
			urgent: true,
			impact: "critical",
			summary: `Recommend aborting raid due to ${context.waypoint.type} waypoint issues`,
		};
	}

	/**
	 * Suggest alternative agent for recovery
	 */
	private suggestAlternativeAgent(currentAgent: AgentType): AgentType {
		switch (currentAgent) {
			case "flute":
				return "logistics"; // Logistics can do reconnaissance
			case "logistics":
				return "quester"; // Quester can handle planning if needed
			case "quester":
				return "sheriff"; // Sheriff can review and suggest fixes
			case "sheriff":
				return "quester"; // Quester can implement fixes
			default:
				return "quester"; // Default fallback
		}
	}

	/**
	 * Record escalation decision for history tracking
	 */
	recordEscalation(waypointId: string, decision: EscalationDecision): void {
		if (!this.escalationHistory.has(waypointId)) {
			this.escalationHistory.set(waypointId, []);
		}

		const history = this.escalationHistory.get(waypointId)!;
		history.push(decision);

		raidLogger.info(
			{
				waypointId,
				level: decision.level,
				reason: decision.reason,
				urgent: decision.urgent,
				impact: decision.impact,
			},
			"Recorded escalation decision",
		);

		// Keep only last 10 escalations per waypoint
		if (history.length > 10) {
			history.splice(0, history.length - 10);
		}
	}

	/**
	 * Get escalation history for a waypoint
	 */
	getEscalationHistory(waypointId: string): EscalationDecision[] {
		return [...(this.escalationHistory.get(waypointId) || [])];
	}

	/**
	 * Determine waypoint status based on escalation level
	 */
	determineWaypointStatus(level: EscalationLevel): WaypointStatus {
		switch (level) {
			case "none":
			case "auto_retry":
				return "recovering";
			case "agent_change":
				return "recovering";
			case "human_review":
			case "human_intervention":
			case "abort_raid":
				return "escalated";
			default:
				return "failed";
		}
	}

	/**
	 * Check if escalation requires immediate human attention
	 */
	requiresImmediateAttention(level: EscalationLevel): boolean {
		return level === "human_intervention" || level === "abort_raid";
	}

	/**
	 * Get summary of all escalations
	 */
	getEscalationSummary(): {
		totalWaypoints: number;
		escalatedWaypoints: number;
		urgentEscalations: number;
		abortRecommendations: number;
		escalationLevelCounts: Record<EscalationLevel, number>;
	} {
		const levelCounts: Record<EscalationLevel, number> = {
			none: 0,
			auto_retry: 0,
			agent_change: 0,
			human_review: 0,
			human_intervention: 0,
			abort_raid: 0,
		};

		let urgentEscalations = 0;
		let abortRecommendations = 0;

		for (const history of this.escalationHistory.values()) {
			const latestEscalation = history[history.length - 1];
			if (latestEscalation) {
				levelCounts[latestEscalation.level]++;

				if (latestEscalation.urgent) {
					urgentEscalations++;
				}

				if (latestEscalation.level === "abort_raid") {
					abortRecommendations++;
				}
			}
		}

		return {
			totalWaypoints: this.escalationHistory.size,
			escalatedWaypoints: levelCounts.human_review + levelCounts.human_intervention + levelCounts.abort_raid,
			urgentEscalations,
			abortRecommendations,
			escalationLevelCounts: levelCounts,
		};
	}

	/**
	 * Clean up escalation history for completed waypoint
	 */
	cleanup(waypointId: string): void {
		this.escalationHistory.delete(waypointId);
	}

	/**
	 * Get escalation rules for an agent type
	 */
	getEscalationRules(agentType: AgentType): EscalationRules {
		return { ...this.escalationRules[agentType] };
	}

	/**
	 * Update escalation rules for an agent type
	 */
	updateEscalationRules(agentType: AgentType, updates: Partial<EscalationRules>): void {
		this.escalationRules[agentType] = {
			...this.escalationRules[agentType],
			...updates,
		};

		raidLogger.info({ agentType, rules: this.escalationRules[agentType] }, "Updated escalation rules");
	}
}
