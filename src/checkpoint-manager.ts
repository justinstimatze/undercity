/**
 * Checkpoint Manager
 *
 * Handles automatic checkpoint creation and restoration for waypoint recovery.
 * Implements smart checkpoint strategy based on time, progress, and risk factors.
 */

import { raidLogger } from "./logger.js";
import type { AgentRecoveryConfig, AgentType, Waypoint, WaypointCheckpoint } from "./types.js";

/**
 * Default checkpoint intervals by agent type
 */
const _DEFAULT_CHECKPOINT_INTERVALS: Record<AgentType, number> = {
	flute: 0, // No checkpoints needed for fast recon
	logistics: 5, // Checkpoint planning progress every 5 minutes
	quester: 2, // Aggressive checkpointing every 2 minutes
	sheriff: 0, // No checkpoints needed for review tasks
};

/**
 * Default recovery configurations by agent type
 */
const DEFAULT_RECOVERY_CONFIGS: Record<AgentType, AgentRecoveryConfig> = {
	flute: {
		maxRetries: 2,
		checkpointsEnabled: false,
		checkpointIntervalMinutes: 0,
		timeoutMinutes: 5,
	},
	logistics: {
		maxRetries: 3,
		checkpointsEnabled: true,
		checkpointIntervalMinutes: 5,
		timeoutMinutes: 15,
	},
	quester: {
		maxRetries: 5,
		checkpointsEnabled: true,
		checkpointIntervalMinutes: 2,
		timeoutMinutes: 20,
	},
	sheriff: {
		maxRetries: 3,
		checkpointsEnabled: false,
		checkpointIntervalMinutes: 0,
		timeoutMinutes: 10,
	},
};

/**
 * Checkpoint creation criteria
 */
interface CheckpointCriteria {
	/** Time-based checkpoint (interval reached) */
	timeElapsed: boolean;
	/** Progress-based checkpoint (significant work done) */
	significantProgress: boolean;
	/** Risk-based checkpoint (before risky operation) */
	beforeRiskyOperation: boolean;
	/** Manual checkpoint request */
	manualRequest: boolean;
}

/**
 * Manages waypoint checkpoints for error recovery
 */
export class CheckpointManager {
	private recoveryConfigs: Record<AgentType, AgentRecoveryConfig>;
	private checkpointTimers: Map<string, NodeJS.Timeout> = new Map();
	private lastCheckpoints: Map<string, Date> = new Map();

	constructor(customConfigs?: Partial<Record<AgentType, Partial<AgentRecoveryConfig>>>) {
		this.recoveryConfigs = { ...DEFAULT_RECOVERY_CONFIGS };

		// Apply custom configurations
		if (customConfigs) {
			for (const [agentType, config] of Object.entries(customConfigs)) {
				if (config) {
					this.recoveryConfigs[agentType as AgentType] = {
						...this.recoveryConfigs[agentType as AgentType],
						...config,
					};
				}
			}
		}
	}

	/**
	 * Start checkpoint monitoring for a waypoint
	 */
	startCheckpointMonitoring(waypoint: Waypoint): void {
		const config = this.recoveryConfigs[waypoint.type];

		if (!config.checkpointsEnabled || config.checkpointIntervalMinutes <= 0) {
			raidLogger.debug(
				{ waypointId: waypoint.id, agentType: waypoint.type },
				"Checkpoints disabled for this agent type",
			);
			return;
		}

		// Clear any existing timer
		this.stopCheckpointMonitoring(waypoint.id);

		// Set up automatic checkpoint timer
		const intervalMs = config.checkpointIntervalMinutes * 60 * 1000;
		const timer = setInterval(() => {
			this.tryCreateCheckpoint(waypoint, { timeElapsed: true });
		}, intervalMs);

		this.checkpointTimers.set(waypoint.id, timer);
		this.lastCheckpoints.set(waypoint.id, new Date());

		raidLogger.info(
			{
				waypointId: waypoint.id,
				agentType: waypoint.type,
				intervalMinutes: config.checkpointIntervalMinutes,
			},
			"Started checkpoint monitoring",
		);
	}

	/**
	 * Stop checkpoint monitoring for a waypoint
	 */
	stopCheckpointMonitoring(waypointId: string): void {
		const timer = this.checkpointTimers.get(waypointId);
		if (timer) {
			clearInterval(timer);
			this.checkpointTimers.delete(waypointId);
		}
		this.lastCheckpoints.delete(waypointId);
	}

	/**
	 * Try to create a checkpoint based on criteria
	 */
	tryCreateCheckpoint(
		waypoint: Waypoint,
		criteria: Partial<CheckpointCriteria>,
		context: {
			progressDescription?: string;
			modifiedFiles?: string[];
			sessionData?: string;
			completionPercent?: number;
		} = {},
	): WaypointCheckpoint | null {
		const config = this.recoveryConfigs[waypoint.type];

		if (!config.checkpointsEnabled) {
			return null;
		}

		const shouldCheckpoint = this.evaluateCheckpointCriteria(waypoint, criteria);

		if (!shouldCheckpoint) {
			return null;
		}

		const checkpoint = this.createCheckpoint(waypoint, context);

		raidLogger.info(
			{
				waypointId: waypoint.id,
				agentType: waypoint.type,
				completionPercent: checkpoint.completionPercent,
				riskLevel: checkpoint.riskLevel,
			},
			"Created waypoint checkpoint",
		);

		this.lastCheckpoints.set(waypoint.id, new Date());
		return checkpoint;
	}

	/**
	 * Create a manual checkpoint
	 */
	createManualCheckpoint(
		waypoint: Waypoint,
		context: {
			progressDescription: string;
			modifiedFiles?: string[];
			sessionData?: string;
			completionPercent?: number;
		},
	): WaypointCheckpoint {
		const checkpoint = this.createCheckpoint(waypoint, {
			...context,
			progressDescription: `[Manual] ${context.progressDescription}`,
		});

		raidLogger.info({ waypointId: waypoint.id, agentType: waypoint.type }, "Created manual checkpoint");

		this.lastCheckpoints.set(waypoint.id, new Date());
		return checkpoint;
	}

	/**
	 * Evaluate whether a checkpoint should be created
	 */
	private evaluateCheckpointCriteria(waypoint: Waypoint, criteria: Partial<CheckpointCriteria>): boolean {
		const config = this.recoveryConfigs[waypoint.type];
		const lastCheckpoint = this.lastCheckpoints.get(waypoint.id);

		// Always checkpoint on manual request
		if (criteria.manualRequest) {
			return true;
		}

		// Always checkpoint before risky operations
		if (criteria.beforeRiskyOperation) {
			return true;
		}

		// Check time-based criteria
		if (criteria.timeElapsed && lastCheckpoint) {
			const timeSinceLastMs = Date.now() - lastCheckpoint.getTime();
			const intervalMs = config.checkpointIntervalMinutes * 60 * 1000;

			if (timeSinceLastMs >= intervalMs) {
				return true;
			}
		}

		// Check progress-based criteria
		if (criteria.significantProgress) {
			return true;
		}

		return false;
	}

	/**
	 * Create a checkpoint object
	 */
	private createCheckpoint(
		waypoint: Waypoint,
		context: {
			progressDescription?: string;
			modifiedFiles?: string[];
			sessionData?: string;
			completionPercent?: number;
		},
	): WaypointCheckpoint {
		const now = new Date();
		const riskLevel = this.assessRiskLevel(waypoint, context);

		return {
			createdAt: now,
			progressDescription: context.progressDescription || "Automatic checkpoint",
			modifiedFiles: context.modifiedFiles || [],
			agentSessionData: context.sessionData,
			completionPercent: context.completionPercent || this.estimateCompletionPercent(waypoint),
			context: this.buildContextString(waypoint, context),
			riskLevel,
		};
	}

	/**
	 * Assess risk level for checkpoint
	 */
	private assessRiskLevel(
		_waypoint: Waypoint,
		context: {
			modifiedFiles?: string[];
			completionPercent?: number;
		},
	): "low" | "medium" | "high" {
		const fileCount = context.modifiedFiles?.length || 0;
		const completion = context.completionPercent || 0;

		// High risk: Many files modified or near completion
		if (fileCount > 10 || completion > 80) {
			return "high";
		}

		// Medium risk: Some files modified or significant progress
		if (fileCount > 3 || completion > 40) {
			return "medium";
		}

		// Low risk: Few or no files modified
		return "low";
	}

	/**
	 * Estimate completion percentage based on waypoint progress
	 */
	private estimateCompletionPercent(waypoint: Waypoint): number {
		const now = new Date();
		const startTime = new Date(waypoint.createdAt);
		const elapsedMinutes = (now.getTime() - startTime.getTime()) / (60 * 1000);

		const config = this.recoveryConfigs[waypoint.type];
		const expectedDurationMinutes = config.timeoutMinutes * 0.8; // 80% of timeout as expected duration

		// Estimate based on time elapsed vs expected duration
		const timeBasedPercent = Math.min(95, (elapsedMinutes / expectedDurationMinutes) * 100);

		// Be conservative - cap at 70% unless we have explicit progress info
		return Math.min(70, timeBasedPercent);
	}

	/**
	 * Build context string for checkpoint
	 */
	private buildContextString(
		waypoint: Waypoint,
		context: {
			progressDescription?: string;
			modifiedFiles?: string[];
		},
	): string {
		const parts: string[] = [];

		parts.push(`Waypoint: ${waypoint.description}`);
		parts.push(`Agent Type: ${waypoint.type}`);

		if (context.progressDescription) {
			parts.push(`Progress: ${context.progressDescription}`);
		}

		if (context.modifiedFiles && context.modifiedFiles.length > 0) {
			parts.push(
				`Modified Files: ${context.modifiedFiles.slice(0, 5).join(", ")}${
					context.modifiedFiles.length > 5 ? ` (+${context.modifiedFiles.length - 5} more)` : ""
				}`,
			);
		}

		return parts.join("\n");
	}

	/**
	 * Get recovery configuration for an agent type
	 */
	getRecoveryConfig(agentType: AgentType): AgentRecoveryConfig {
		return { ...this.recoveryConfigs[agentType] };
	}

	/**
	 * Update recovery configuration for an agent type
	 */
	updateRecoveryConfig(agentType: AgentType, updates: Partial<AgentRecoveryConfig>): void {
		this.recoveryConfigs[agentType] = {
			...this.recoveryConfigs[agentType],
			...updates,
		};

		raidLogger.info({ agentType, config: this.recoveryConfigs[agentType] }, "Updated recovery configuration");
	}

	/**
	 * Check if an agent type supports checkpoints
	 */
	supportsCheckpoints(agentType: AgentType): boolean {
		return this.recoveryConfigs[agentType].checkpointsEnabled;
	}

	/**
	 * Get checkpoint statistics
	 */
	getCheckpointStats(): {
		activeMonitoring: number;
		totalCheckpoints: number;
		configsByAgent: Record<AgentType, AgentRecoveryConfig>;
	} {
		return {
			activeMonitoring: this.checkpointTimers.size,
			totalCheckpoints: this.lastCheckpoints.size,
			configsByAgent: { ...this.recoveryConfigs },
		};
	}

	/**
	 * Clean up resources for completed waypoint
	 */
	cleanup(waypointId: string): void {
		this.stopCheckpointMonitoring(waypointId);
	}

	/**
	 * Clean up all resources
	 */
	cleanupAll(): void {
		for (const waypointId of this.checkpointTimers.keys()) {
			this.stopCheckpointMonitoring(waypointId);
		}
	}
}
