/**
 * Worker Health Monitoring
 *
 * Monitors active workers for stuck states and attempts recovery.
 * Extracted from Orchestrator for better testability.
 */

import { writeFileSync } from "node:fs";
import { nameFromId } from "../names.js";
import * as output from "../output.js";
import { readTaskAssignment } from "../persistence.js";
import type { ActiveTaskState } from "../types.js";

/**
 * Configuration for worker health monitoring
 */
export interface HealthMonitorConfig {
	/** Enable health monitoring (default: true) */
	enabled: boolean;
	/** How often to check worker health in ms (default: 60000 = 1 min) */
	checkIntervalMs: number;
	/** Max time since last checkpoint before worker is considered stuck (default: 300000 = 5 min) */
	stuckThresholdMs: number;
	/** Whether to attempt recovery intervention before killing (default: true) */
	attemptRecovery: boolean;
	/** Max recovery attempts before giving up (default: 2) */
	maxRecoveryAttempts: number;
}

/**
 * Dependencies required for health monitoring
 */
export interface HealthMonitorDependencies {
	/** Function to scan active tasks */
	scanActiveTasks: () => ActiveTaskState[];
}

/**
 * State maintained by the health monitor
 */
export interface HealthMonitorState {
	/** Active interval handle */
	intervalHandle: ReturnType<typeof setInterval> | null;
	/** Track recovery attempts per task (taskId → attempts) */
	recoveryAttempts: Map<string, number>;
}

/**
 * Create initial health monitor state
 */
export function createHealthMonitorState(): HealthMonitorState {
	return {
		intervalHandle: null,
		recoveryAttempts: new Map(),
	};
}

/**
 * Start health monitoring
 *
 * @param state - Mutable health monitor state
 * @param config - Health monitor configuration
 * @param deps - Dependencies for monitoring
 */
export function startHealthMonitoring(
	state: HealthMonitorState,
	config: HealthMonitorConfig,
	deps: HealthMonitorDependencies,
): void {
	if (!config.enabled) {
		return;
	}

	// Clear any existing interval
	stopHealthMonitoring(state);

	output.debug(
		`Health monitoring started (check every ${config.checkIntervalMs / 1000}s, stuck after ${config.stuckThresholdMs / 1000}s)`,
	);

	state.intervalHandle = setInterval(() => {
		checkWorkerHealth(state, config, deps);
	}, config.checkIntervalMs);
}

/**
 * Stop health monitoring
 *
 * @param state - Mutable health monitor state
 */
export function stopHealthMonitoring(state: HealthMonitorState): void {
	if (state.intervalHandle) {
		clearInterval(state.intervalHandle);
		state.intervalHandle = null;
	}
	// Clear recovery attempts tracking
	state.recoveryAttempts.clear();
}

/**
 * Check health of all active workers
 * Detects stuck workers via stale checkpoints
 *
 * @param state - Mutable health monitor state
 * @param config - Health monitor configuration
 * @param deps - Dependencies for monitoring
 */
export function checkWorkerHealth(
	state: HealthMonitorState,
	config: HealthMonitorConfig,
	deps: HealthMonitorDependencies,
): void {
	const activeTasks = deps.scanActiveTasks();
	const now = Date.now();

	for (const task of activeTasks) {
		// Only check running tasks (not pending)
		if (task.status !== "running") {
			continue;
		}

		// Read the assignment to get checkpoint timestamp
		const assignment = task.worktreePath ? readTaskAssignment(task.worktreePath) : null;
		if (!assignment?.checkpoint?.savedAt) {
			// No checkpoint yet - check if task has been running too long without one
			if (task.startedAt) {
				const startedAtMs = new Date(task.startedAt).getTime();
				const elapsedMs = now - startedAtMs;
				if (elapsedMs > config.stuckThresholdMs) {
					const workerName = nameFromId(task.taskId);
					output.warning(`Worker [${workerName}] has no checkpoint after ${Math.round(elapsedMs / 1000)}s`);
					if (task.worktreePath) {
						handleStuckWorker(state, config, task.taskId, task.worktreePath, "no_checkpoint");
					}
				}
			}
			continue;
		}

		// Check checkpoint staleness
		const checkpointMs = new Date(assignment.checkpoint.savedAt).getTime();
		const staleDurationMs = now - checkpointMs;

		if (staleDurationMs > config.stuckThresholdMs) {
			const phase = assignment.checkpoint.phase;
			const workerName = nameFromId(task.taskId);
			output.warning(`Worker [${workerName}] stuck in '${phase}' phase for ${Math.round(staleDurationMs / 1000)}s`);
			if (task.worktreePath) {
				handleStuckWorker(state, config, task.taskId, task.worktreePath, phase);
			}
		}
	}
}

/**
 * Handle a stuck worker - attempt recovery or log for manual intervention
 *
 * @param state - Mutable health monitor state
 * @param config - Health monitor configuration
 * @param taskId - ID of the stuck task
 * @param worktreePath - Path to the worktree
 * @param stuckPhase - Phase where the worker is stuck
 */
export function handleStuckWorker(
	state: HealthMonitorState,
	config: HealthMonitorConfig,
	taskId: string,
	worktreePath: string,
	stuckPhase: string,
): void {
	const attempts = state.recoveryAttempts.get(taskId) ?? 0;
	const workerName = nameFromId(taskId);

	if (config.attemptRecovery && attempts < config.maxRecoveryAttempts) {
		// Attempt recovery intervention
		state.recoveryAttempts.set(taskId, attempts + 1);
		output.info(`Nudging [${workerName}] (recovery attempt ${attempts + 1}/${config.maxRecoveryAttempts})`);

		// Write a nudge file to the worktree that the worker can detect
		writeNudgeFile(worktreePath, stuckPhase, attempts + 1);
	} else {
		// Max recovery attempts exceeded - log for manual intervention
		// Note: We don't actually kill the process here because we don't have
		// direct control over the worker process. The worker will eventually
		// timeout or complete. This is just alerting.
		output.error(
			`Worker [${workerName}] unresponsive after ${config.maxRecoveryAttempts} recovery attempts. ` +
				`Consider manual intervention or wait for worker timeout.`,
		);

		// Clear recovery attempts since we've given up
		state.recoveryAttempts.delete(taskId);
	}
}

/**
 * Write a nudge file to the worktree for worker detection
 *
 * @param worktreePath - Path to the worktree
 * @param stuckPhase - Phase where the worker is stuck
 * @param attempt - Recovery attempt number
 */
function writeNudgeFile(worktreePath: string, stuckPhase: string, attempt: number): void {
	try {
		const nudgePath = `${worktreePath}/.undercity-nudge`;
		const nudgeContent = JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				reason: `Stuck in ${stuckPhase} phase`,
				attempt,
				message: "Health check detected inactivity. Please continue or report status.",
			},
			null,
			2,
		);
		writeFileSync(nudgePath, nudgeContent, "utf-8");
		output.debug(`Wrote nudge file to ${nudgePath}`);
	} catch (err) {
		output.debug(`Failed to write nudge file: ${err}`);
	}
}
