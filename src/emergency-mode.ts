/**
 * Emergency Fix Mode
 *
 * Inspired by dlorenc/multiclaude's merge-queue emergency handling.
 *
 * When the main branch CI fails:
 * 1. Halt all merge operations
 * 2. Spawn an investigation worker
 * 3. Resume only after main is healthy
 *
 * Prevents wasted work when main is broken - no point merging
 * branches that will all fail verification anyway.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionLogger } from "./logger.js";
import * as output from "./output.js";
import { verifyWork } from "./verification.js";

const STATE_DIR = ".undercity";
const EMERGENCY_STATE_FILE = "emergency-mode.json";

export interface EmergencyModeState {
	/** Whether emergency mode is active */
	isActive: boolean;
	/** When emergency mode was activated */
	activatedAt?: string;
	/** Reason for activation */
	reason?: string;
	/** Last verification error */
	lastError?: string;
	/** Number of fix attempts */
	fixAttempts: number;
	/** When last health check was performed */
	lastHealthCheck?: string;
	/** Whether a fix worker is currently active */
	fixWorkerActive: boolean;
	/** Fix worker task ID if active */
	fixWorkerTaskId?: string;
}

const DEFAULT_STATE: EmergencyModeState = {
	isActive: false,
	fixAttempts: 0,
	fixWorkerActive: false,
};

/**
 * Get path to emergency mode state file
 */
function getStatePath(stateDir: string = STATE_DIR): string {
	return join(stateDir, EMERGENCY_STATE_FILE);
}

/**
 * Load emergency mode state
 */
export function loadEmergencyState(stateDir: string = STATE_DIR): EmergencyModeState {
	const statePath = getStatePath(stateDir);
	try {
		if (existsSync(statePath)) {
			const content = readFileSync(statePath, "utf-8");
			return { ...DEFAULT_STATE, ...JSON.parse(content) };
		}
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to load emergency mode state");
	}
	return { ...DEFAULT_STATE };
}

/**
 * Save emergency mode state
 */
export function saveEmergencyState(state: EmergencyModeState, stateDir: string = STATE_DIR): void {
	const statePath = getStatePath(stateDir);
	try {
		const tempPath = `${statePath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
		const { renameSync } = require("node:fs");
		renameSync(tempPath, statePath);
	} catch (error) {
		sessionLogger.error({ error: String(error) }, "Failed to save emergency mode state");
	}
}

/**
 * Check if main branch is healthy (passes verification)
 */
export async function checkMainBranchHealth(workingDirectory: string = process.cwd()): Promise<{
	healthy: boolean;
	error?: string;
}> {
	sessionLogger.debug("Checking main branch health");

	try {
		const result = await verifyWork({
			runTypecheck: true,
			runTests: true,
			workingDirectory,
			skipAutoFix: true, // Don't auto-fix, just check
		});

		if (result.passed) {
			sessionLogger.debug("Main branch is healthy");
			return { healthy: true };
		}

		// Truncate feedback for summary
		const errorSummary = result.feedback.slice(0, 200) + (result.feedback.length > 200 ? "..." : "");
		sessionLogger.warn({ issues: result.issues?.length, feedback: errorSummary }, "Main branch verification failed");
		return { healthy: false, error: errorSummary };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		sessionLogger.error({ error: errorMsg }, "Failed to check main branch health");
		return { healthy: false, error: errorMsg };
	}
}

/**
 * Activate emergency mode
 */
export function activateEmergencyMode(reason: string, error?: string, stateDir: string = STATE_DIR): void {
	const state = loadEmergencyState(stateDir);

	if (state.isActive) {
		sessionLogger.debug("Emergency mode already active");
		return;
	}

	state.isActive = true;
	state.activatedAt = new Date().toISOString();
	state.reason = reason;
	state.lastError = error;
	state.fixAttempts = 0;

	saveEmergencyState(state, stateDir);

	output.error(`EMERGENCY MODE ACTIVATED: ${reason}`);
	sessionLogger.error({ reason, error }, "Emergency mode activated - halting all merges");
}

/**
 * Deactivate emergency mode
 */
export function deactivateEmergencyMode(stateDir: string = STATE_DIR): void {
	const state = loadEmergencyState(stateDir);

	if (!state.isActive) {
		return;
	}

	const duration = state.activatedAt ? Math.round((Date.now() - new Date(state.activatedAt).getTime()) / 1000 / 60) : 0;

	state.isActive = false;
	state.fixWorkerActive = false;
	state.fixWorkerTaskId = undefined;

	saveEmergencyState(state, stateDir);

	output.success(`Emergency mode deactivated (was active for ${duration} minutes)`);
	sessionLogger.info({ durationMinutes: duration, fixAttempts: state.fixAttempts }, "Emergency mode deactivated");
}

/**
 * Check if emergency mode is active
 */
export function isEmergencyModeActive(stateDir: string = STATE_DIR): boolean {
	return loadEmergencyState(stateDir).isActive;
}

/**
 * Get emergency mode status for display
 */
export function getEmergencyModeStatus(stateDir: string = STATE_DIR): {
	active: boolean;
	reason?: string;
	duration?: number;
	fixAttempts: number;
	fixWorkerActive: boolean;
} {
	const state = loadEmergencyState(stateDir);

	let duration: number | undefined;
	if (state.isActive && state.activatedAt) {
		duration = Math.round((Date.now() - new Date(state.activatedAt).getTime()) / 1000 / 60);
	}

	return {
		active: state.isActive,
		reason: state.reason,
		duration,
		fixAttempts: state.fixAttempts,
		fixWorkerActive: state.fixWorkerActive,
	};
}

/**
 * Record that a fix worker has been spawned
 */
export function recordFixWorkerSpawned(taskId: string, stateDir: string = STATE_DIR): void {
	const state = loadEmergencyState(stateDir);
	state.fixWorkerActive = true;
	state.fixWorkerTaskId = taskId;
	state.fixAttempts++;
	saveEmergencyState(state, stateDir);

	sessionLogger.info({ taskId, attempt: state.fixAttempts }, "Emergency fix worker spawned");
}

/**
 * Record that fix worker has completed
 */
export function recordFixWorkerCompleted(success: boolean, stateDir: string = STATE_DIR): void {
	const state = loadEmergencyState(stateDir);
	state.fixWorkerActive = false;

	if (success) {
		// Don't auto-deactivate - let health check confirm
		sessionLogger.info("Fix worker completed successfully, awaiting health check confirmation");
	} else {
		sessionLogger.warn({ fixAttempts: state.fixAttempts }, "Fix worker failed");
	}

	saveEmergencyState(state, stateDir);
}

/**
 * Generate a fix task description for the emergency
 */
export function generateFixTaskDescription(state: EmergencyModeState): string {
	const errorContext = state.lastError ? `\n\nLast error: ${state.lastError}` : "";
	const attemptNote = state.fixAttempts > 0 ? `\n\nThis is fix attempt #${state.fixAttempts + 1}.` : "";

	return `[emergency] Fix main branch CI failure

The main branch is failing verification. Investigate and fix the issue.

Reason: ${state.reason || "Unknown"}${errorContext}${attemptNote}

Steps:
1. Run \`pnpm typecheck\` and \`pnpm test\` to reproduce the failure
2. Identify the root cause
3. Fix the issue with minimal changes
4. Verify the fix works locally before committing

IMPORTANT: Focus only on fixing the immediate CI failure. Do not add features or refactor.`;
}

/**
 * Pre-merge health check - call before processing merge queue
 *
 * Returns true if safe to proceed, false if emergency mode should block
 */
export async function preMergeHealthCheck(
	workingDirectory: string = process.cwd(),
	stateDir: string = STATE_DIR,
): Promise<{ proceed: boolean; emergencyActive: boolean; error?: string }> {
	// First check if emergency mode is already active
	const state = loadEmergencyState(stateDir);
	if (state.isActive) {
		// If a fix worker is active, wait for it
		if (state.fixWorkerActive) {
			output.warning("Emergency mode active - fix worker in progress, skipping merge queue");
			return { proceed: false, emergencyActive: true, error: "Fix worker in progress" };
		}

		// Check if main is healthy now
		const healthResult = await checkMainBranchHealth(workingDirectory);
		if (healthResult.healthy) {
			deactivateEmergencyMode(stateDir);
			return { proceed: true, emergencyActive: false };
		}

		output.warning("Emergency mode active - main branch still unhealthy");
		return { proceed: false, emergencyActive: true, error: healthResult.error };
	}

	// Not in emergency mode - do a quick health check
	// Update last health check time
	state.lastHealthCheck = new Date().toISOString();
	saveEmergencyState(state, stateDir);

	const healthResult = await checkMainBranchHealth(workingDirectory);
	if (!healthResult.healthy) {
		activateEmergencyMode("Main branch CI failure detected", healthResult.error, stateDir);
		return { proceed: false, emergencyActive: true, error: healthResult.error };
	}

	return { proceed: true, emergencyActive: false };
}

/**
 * Should a fix worker be spawned?
 * Returns true if emergency mode is active but no fix worker is running
 */
export function shouldSpawnFixWorker(stateDir: string = STATE_DIR): boolean {
	const state = loadEmergencyState(stateDir);
	return state.isActive && !state.fixWorkerActive;
}

/**
 * Get the current fix attempt count
 */
export function getFixAttemptCount(stateDir: string = STATE_DIR): number {
	return loadEmergencyState(stateDir).fixAttempts;
}

/**
 * Maximum fix attempts before requiring human intervention
 */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Check if we've exceeded max fix attempts
 */
export function hasExceededMaxFixAttempts(stateDir: string = STATE_DIR): boolean {
	return loadEmergencyState(stateDir).fixAttempts >= MAX_FIX_ATTEMPTS;
}
