/**
 * Recovery Manager
 *
 * High-level interface for managing error recovery across the entire system.
 * Coordinates CheckpointManager, RecoveryOrchestrator, and ErrorEscalationManager.
 */

import type { CheckpointManager } from "./checkpoint-manager.js";
import type { ErrorEscalationManager, EscalationDecision } from "./error-escalation.js";
import { raidLogger } from "./logger.js";
import type { RecoveryOrchestrator } from "./recovery-orchestrator.js";
import type {
	AgentRecoveryConfig,
	AgentType,
	RecoveryAttempt,
	RecoveryState,
	Waypoint,
	WaypointCheckpoint,
} from "./types.js";

/**
 * Recovery operation result
 */
export interface RecoveryResult {
	/** Whether recovery was successful */
	successful: boolean;
	/** Strategy used for recovery */
	strategy: string;
	/** Number of attempts made */
	attempts: number;
	/** Time spent on recovery (ms) */
	durationMs: number;
	/** Error message if recovery failed */
	error?: string;
	/** Escalation decision if applicable */
	escalation?: EscalationDecision;
}

/**
 * Recovery system statistics
 */
export interface RecoverySystemStats {
	/** Overall recovery success rate */
	successRate: number;
	/** Total recovery attempts */
	totalAttempts: number;
	/** Active monitoring count */
	activeMonitoring: number;
	/** Current escalations requiring attention */
	urgentEscalations: number;
	/** Recovery stats by agent type */
	byAgentType: Record<
		AgentType,
		{
			attempts: number;
			successes: number;
			escalations: number;
		}
	>;
}

/**
 * Comprehensive recovery management system
 */
export class RecoveryManager {
	private checkpointManager: CheckpointManager;
	private recoveryOrchestrator: RecoveryOrchestrator;
	private escalationManager: ErrorEscalationManager;
	private recoveryHistory: Map<string, RecoveryResult[]> = new Map();

	constructor(
		checkpointManager: CheckpointManager,
		recoveryOrchestrator: RecoveryOrchestrator,
		escalationManager: ErrorEscalationManager,
	) {
		this.checkpointManager = checkpointManager;
		this.recoveryOrchestrator = recoveryOrchestrator;
		this.escalationManager = escalationManager;
	}

	/**
	 * Start recovery management for a waypoint
	 */
	startManaging(waypoint: Waypoint): void {
		// Start checkpoint monitoring
		this.checkpointManager.startCheckpointMonitoring(waypoint);

		// Initialize recovery history
		this.recoveryHistory.set(waypoint.id, []);

		raidLogger.info({ waypointId: waypoint.id, agentType: waypoint.type }, "Started recovery management");
	}

	/**
	 * Stop recovery management for a waypoint
	 */
	stopManaging(waypointId: string): void {
		// Stop checkpoint monitoring
		this.checkpointManager.stopCheckpointMonitoring(waypointId);

		// Clean up recovery state
		this.recoveryOrchestrator.cleanupRecovery(waypointId);
		this.escalationManager.cleanup(waypointId);

		// Clear recovery history
		this.recoveryHistory.delete(waypointId);

		raidLogger.info({ waypointId }, "Stopped recovery management");
	}

	/**
	 * Execute comprehensive recovery for a failed waypoint
	 */
	async executeRecovery(
		waypoint: Waypoint,
		error: string | Error,
		context: {
			agentType: AgentType;
			sessionId?: string;
			modifiedFiles?: string[];
			progressDescription?: string;
			raidProgressPercent?: number;
		},
	): Promise<RecoveryResult> {
		const startTime = Date.now();

		raidLogger.warn(
			{
				waypointId: waypoint.id,
				agentType: context.agentType,
				error: error instanceof Error ? error.message : error,
			},
			"Starting comprehensive recovery",
		);

		// Create emergency checkpoint if none exists
		const checkpoint = await this.ensureCheckpoint(waypoint, context);

		// Classify error and determine escalation
		const classification = this.recoveryOrchestrator.classifyError(error, context.agentType);
		const escalationContext = {
			waypoint,
			error,
			classification,
			attemptCount: this.getAttemptCount(waypoint.id) + 1,
			timeSinceFirstFailure: Date.now() - new Date(waypoint.createdAt).getTime(),
			affectsOtherWaypoints: this.classifyErrorImpact(error),
			raidProgressPercent: context.raidProgressPercent || 0,
		};

		const escalationDecision = this.escalationManager.determineEscalation(escalationContext);
		this.escalationManager.recordEscalation(waypoint.id, escalationDecision);

		let result: RecoveryResult;

		// Execute recovery based on escalation decision
		if (escalationDecision.level === "abort_raid" || escalationDecision.level === "human_intervention") {
			// Cannot auto-recover - escalate to human
			result = {
				successful: false,
				strategy: "escalate",
				attempts: escalationContext.attemptCount,
				durationMs: Date.now() - startTime,
				error: `Escalated: ${escalationDecision.reason}`,
				escalation: escalationDecision,
			};
		} else {
			// Attempt automatic recovery
			try {
				const recoveryAttempt = await this.recoveryOrchestrator.executeRecovery(waypoint, error, context);

				result = {
					successful: recoveryAttempt.successful,
					strategy: recoveryAttempt.strategy,
					attempts: recoveryAttempt.attemptNumber,
					durationMs: recoveryAttempt.durationMs,
					error: recoveryAttempt.error,
					escalation: escalationDecision,
				};
			} catch (recoveryError) {
				result = {
					successful: false,
					strategy: "recovery_failed",
					attempts: escalationContext.attemptCount,
					durationMs: Date.now() - startTime,
					error: String(recoveryError),
					escalation: escalationDecision,
				};
			}
		}

		// Record recovery result
		this.recordRecoveryResult(waypoint.id, result);

		raidLogger.info(
			{
				waypointId: waypoint.id,
				successful: result.successful,
				strategy: result.strategy,
				attempts: result.attempts,
				durationMs: result.durationMs,
			},
			"Recovery attempt completed",
		);

		return result;
	}

	/**
	 * Create a manual checkpoint for a waypoint
	 */
	async createCheckpoint(
		waypoint: Waypoint,
		context: {
			progressDescription: string;
			modifiedFiles?: string[];
			sessionData?: string;
			completionPercent?: number;
		},
	): Promise<WaypointCheckpoint | null> {
		return this.checkpointManager.createManualCheckpoint(waypoint, context);
	}

	/**
	 * Check if a waypoint requires immediate attention
	 */
	requiresImmediateAttention(waypointId: string): boolean {
		const escalationHistory = this.escalationManager.getEscalationHistory(waypointId);
		const latestEscalation = escalationHistory[escalationHistory.length - 1];

		return latestEscalation ? this.escalationManager.requiresImmediateAttention(latestEscalation.level) : false;
	}

	/**
	 * Get recovery configuration for an agent type
	 */
	getRecoveryConfig(agentType: AgentType): AgentRecoveryConfig {
		return this.checkpointManager.getRecoveryConfig(agentType);
	}

	/**
	 * Update recovery configuration
	 */
	updateRecoveryConfig(agentType: AgentType, updates: Partial<AgentRecoveryConfig>): void {
		this.checkpointManager.updateRecoveryConfig(agentType, updates);
	}

	/**
	 * Get comprehensive recovery system statistics
	 */
	getSystemStats(): RecoverySystemStats {
		const checkpointStats = this.checkpointManager.getCheckpointStats();
		const recoveryStats = this.recoveryOrchestrator.getRecoveryStats();
		const escalationSummary = this.escalationManager.getEscalationSummary();

		// Calculate stats by agent type
		const byAgentType: Record<AgentType, { attempts: number; successes: number; escalations: number }> = {
			flute: { attempts: 0, successes: 0, escalations: 0 },
			logistics: { attempts: 0, successes: 0, escalations: 0 },
			quester: { attempts: 0, successes: 0, escalations: 0 },
			sheriff: { attempts: 0, successes: 0, escalations: 0 },
		};

		// Aggregate from recovery history
		for (const results of this.recoveryHistory.values()) {
			for (const result of results) {
				// Note: This is simplified - in practice you'd track agent type per result
				// For now, distribute evenly across agent types
				const agentTypes: AgentType[] = ["flute", "logistics", "quester", "sheriff"];
				for (const agentType of agentTypes) {
					byAgentType[agentType].attempts++;
					if (result.successful) {
						byAgentType[agentType].successes++;
					}
					if (result.escalation?.urgent) {
						byAgentType[agentType].escalations++;
					}
				}
			}
		}

		return {
			successRate: recoveryStats.successRate,
			totalAttempts: recoveryStats.totalRecoveries,
			activeMonitoring: checkpointStats.activeMonitoring,
			urgentEscalations: escalationSummary.urgentEscalations,
			byAgentType,
		};
	}

	/**
	 * Get recovery history for a waypoint
	 */
	getRecoveryHistory(waypointId: string): RecoveryResult[] {
		return [...(this.recoveryHistory.get(waypointId) || [])];
	}

	/**
	 * Get all waypoints requiring attention
	 */
	getWaypointsRequiringAttention(): string[] {
		const waypoints: string[] = [];

		for (const waypointId of this.recoveryHistory.keys()) {
			if (this.requiresImmediateAttention(waypointId)) {
				waypoints.push(waypointId);
			}
		}

		return waypoints;
	}

	/**
	 * Force escalation of a waypoint to human intervention
	 */
	forceEscalation(waypointId: string, reason: string): void {
		const escalationDecision = this.escalationManager.determineEscalation({
			waypoint: { id: waypointId } as Waypoint,
			error: new Error(reason),
			classification: {
				type: "unknown",
				severity: "critical",
				isTransient: false,
				affectsOthers: false,
				recommendedStrategy: "escalate",
			},
			attemptCount: 999, // Force escalation
			timeSinceFirstFailure: 0,
			affectsOtherWaypoints: false,
			raidProgressPercent: 0,
		});

		this.escalationManager.recordEscalation(waypointId, escalationDecision);

		// Ensure the waypoint is tracked in recovery history for attention tracking
		if (!this.recoveryHistory.has(waypointId)) {
			this.recoveryHistory.set(waypointId, []);
		}

		raidLogger.warn({ waypointId, reason }, "Forced escalation to human intervention");
	}

	/**
	 * Ensure waypoint has a checkpoint
	 */
	private async ensureCheckpoint(
		waypoint: Waypoint,
		context: {
			modifiedFiles?: string[];
			sessionId?: string;
			progressDescription?: string;
		},
	): Promise<WaypointCheckpoint | null> {
		if (waypoint.checkpoint) {
			return waypoint.checkpoint;
		}

		// Create emergency checkpoint
		return this.checkpointManager.tryCreateCheckpoint(
			waypoint,
			{ manualRequest: true },
			{
				progressDescription: context.progressDescription || "Emergency checkpoint before recovery",
				modifiedFiles: context.modifiedFiles,
				sessionData: context.sessionId,
				completionPercent: 30, // Conservative estimate
			},
		);
	}

	/**
	 * Classify error impact scope
	 */
	private classifyErrorImpact(error: string | Error): boolean {
		const errorText = error instanceof Error ? error.message : error;

		// System-wide errors
		const systemWidePatterns = [
			/rate.?limit/i,
			/quota.?exceeded/i,
			/disk.?full/i,
			/out.?of.?memory/i,
			/system.?overload/i,
			/network.?error/i,
		];

		return systemWidePatterns.some((pattern) => pattern.test(errorText));
	}

	/**
	 * Get attempt count for a waypoint
	 */
	private getAttemptCount(waypointId: string): number {
		const history = this.recoveryHistory.get(waypointId) || [];
		return history.length;
	}

	/**
	 * Record recovery result in history
	 */
	private recordRecoveryResult(waypointId: string, result: RecoveryResult): void {
		if (!this.recoveryHistory.has(waypointId)) {
			this.recoveryHistory.set(waypointId, []);
		}

		const history = this.recoveryHistory.get(waypointId)!;
		history.push(result);

		// Keep only last 10 results
		if (history.length > 10) {
			history.splice(0, history.length - 10);
		}
	}

	/**
	 * Clean up all recovery management
	 */
	cleanupAll(): void {
		this.checkpointManager.cleanupAll();
		this.recoveryHistory.clear();

		raidLogger.info("Cleaned up all recovery management");
	}
}
