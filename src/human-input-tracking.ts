/**
 * Human Input Tracking
 *
 * Inspired by dlorenc/multiclaude's approach to breaking retry loops.
 *
 * When workers repeatedly fail on the same error pattern:
 * 1. Detect the pattern (via error signature matching)
 * 2. Mark the task as needing human input
 * 3. Allow humans to provide guidance for the error pattern
 * 4. Feed that guidance into future retry attempts
 *
 * This prevents infinite retry loops where AI keeps trying the same
 * failing approach without learning.
 */

import { sessionLogger } from "./logger.js";
import * as output from "./output.js";
import { getDatabase } from "./storage.js";

const DEFAULT_STATE_DIR = ".undercity";

export interface HumanGuidance {
	/** Unique identifier for this guidance */
	id: string;
	/** Error signature this guidance applies to */
	errorSignature: string;
	/** Human-provided guidance text */
	guidance: string;
	/** When the guidance was provided */
	providedAt: string;
	/** Whether this guidance has been used successfully */
	usedSuccessfully: boolean;
	/** Number of times this guidance has been applied */
	timesUsed: number;
}

export interface NeedsHumanInputState {
	/** Task ID that needs input */
	taskId: string;
	/** Task objective */
	objective: string;
	/** Error signature */
	errorSignature: string;
	/** Error category (typecheck, test, lint, etc.) */
	category: string;
	/** Sample error message */
	sampleMessage: string;
	/** Number of failed attempts */
	failedAttempts: number;
	/** Model that was used */
	modelUsed: string;
	/** When this was flagged */
	flaggedAt: string;
	/** Previous guidance that was tried (if any) */
	previousGuidance?: string;
}

/**
 * Initialize the human input tracking tables
 */
export function initHumanInputTables(stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getDatabase(stateDir);

	db.exec(`
		-- Human guidance for error patterns
		CREATE TABLE IF NOT EXISTS human_guidance (
			id TEXT PRIMARY KEY,
			error_signature TEXT NOT NULL,
			guidance TEXT NOT NULL,
			provided_at TEXT NOT NULL,
			used_successfully INTEGER NOT NULL DEFAULT 0,
			times_used INTEGER NOT NULL DEFAULT 0
		);

		CREATE INDEX IF NOT EXISTS idx_human_guidance_signature ON human_guidance(error_signature);

		-- Tasks flagged as needing human input
		CREATE TABLE IF NOT EXISTS needs_human_input (
			task_id TEXT PRIMARY KEY,
			objective TEXT NOT NULL,
			error_signature TEXT NOT NULL,
			category TEXT NOT NULL,
			sample_message TEXT NOT NULL,
			failed_attempts INTEGER NOT NULL,
			model_used TEXT NOT NULL,
			flagged_at TEXT NOT NULL,
			previous_guidance TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_needs_human_input_signature ON needs_human_input(error_signature);
	`);
}

/**
 * Check if there's human guidance available for an error signature
 */
export function getHumanGuidance(errorSignature: string, stateDir: string = DEFAULT_STATE_DIR): HumanGuidance | null {
	try {
		initHumanInputTables(stateDir);
		const db = getDatabase(stateDir);

		const row = db
			.prepare(
				`
			SELECT id, error_signature, guidance, provided_at, used_successfully, times_used
			FROM human_guidance
			WHERE error_signature = ?
		`,
			)
			.get(errorSignature) as
			| {
					id: string;
					error_signature: string;
					guidance: string;
					provided_at: string;
					used_successfully: number;
					times_used: number;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			id: row.id,
			errorSignature: row.error_signature,
			guidance: row.guidance,
			providedAt: row.provided_at,
			usedSuccessfully: row.used_successfully === 1,
			timesUsed: row.times_used,
		};
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to get human guidance");
		return null;
	}
}

/**
 * Save human guidance for an error pattern
 */
export function saveHumanGuidance(
	errorSignature: string,
	guidance: string,
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	initHumanInputTables(stateDir);
	const db = getDatabase(stateDir);

	const id = `hg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
	const now = new Date().toISOString();

	db.prepare(
		`
		INSERT OR REPLACE INTO human_guidance (id, error_signature, guidance, provided_at, used_successfully, times_used)
		VALUES (?, ?, ?, ?, 0, 0)
	`,
	).run(id, errorSignature, guidance, now);

	sessionLogger.info({ id, errorSignature }, "Saved human guidance for error pattern");
	return id;
}

/**
 * Mark that human guidance was used (successfully or not)
 */
export function markGuidanceUsed(errorSignature: string, success: boolean, stateDir: string = DEFAULT_STATE_DIR): void {
	try {
		initHumanInputTables(stateDir);
		const db = getDatabase(stateDir);

		if (success) {
			db.prepare(
				`
				UPDATE human_guidance
				SET used_successfully = 1, times_used = times_used + 1
				WHERE error_signature = ?
			`,
			).run(errorSignature);
		} else {
			db.prepare(
				`
				UPDATE human_guidance
				SET times_used = times_used + 1
				WHERE error_signature = ?
			`,
			).run(errorSignature);
		}
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to mark guidance used");
	}
}

/**
 * Flag a task as needing human input
 */
export function flagNeedsHumanInput(
	taskId: string,
	objective: string,
	errorSignature: string,
	category: string,
	sampleMessage: string,
	failedAttempts: number,
	modelUsed: string,
	previousGuidance?: string,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	initHumanInputTables(stateDir);
	const db = getDatabase(stateDir);

	const now = new Date().toISOString();

	db.prepare(
		`
		INSERT OR REPLACE INTO needs_human_input
		(task_id, objective, error_signature, category, sample_message, failed_attempts, model_used, flagged_at, previous_guidance)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
	).run(
		taskId,
		objective,
		errorSignature,
		category,
		sampleMessage.substring(0, 2000), // Truncate long messages
		failedAttempts,
		modelUsed,
		now,
		previousGuidance ?? null,
	);

	sessionLogger.info({ taskId, errorSignature, category }, "Task flagged as needing human input");

	output.warning(`Task ${taskId} needs human input to proceed`);
	output.info(`Error pattern: ${errorSignature.substring(0, 100)}`);
	output.info("Run 'undercity human-input' to provide guidance");
}

/**
 * Get all tasks that need human input
 */
export function getTasksNeedingInput(stateDir: string = DEFAULT_STATE_DIR): NeedsHumanInputState[] {
	try {
		initHumanInputTables(stateDir);
		const db = getDatabase(stateDir);

		const rows = db
			.prepare(
				`
			SELECT task_id, objective, error_signature, category, sample_message,
				   failed_attempts, model_used, flagged_at, previous_guidance
			FROM needs_human_input
			ORDER BY flagged_at DESC
		`,
			)
			.all() as Array<{
			task_id: string;
			objective: string;
			error_signature: string;
			category: string;
			sample_message: string;
			failed_attempts: number;
			model_used: string;
			flagged_at: string;
			previous_guidance: string | null;
		}>;

		return rows.map((row) => ({
			taskId: row.task_id,
			objective: row.objective,
			errorSignature: row.error_signature,
			category: row.category,
			sampleMessage: row.sample_message,
			failedAttempts: row.failed_attempts,
			modelUsed: row.model_used,
			flaggedAt: row.flagged_at,
			previousGuidance: row.previous_guidance ?? undefined,
		}));
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to get tasks needing input");
		return [];
	}
}

/**
 * Clear a task from the needs human input list (after guidance provided or task completed)
 */
export function clearNeedsHumanInput(taskId: string, stateDir: string = DEFAULT_STATE_DIR): void {
	try {
		initHumanInputTables(stateDir);
		const db = getDatabase(stateDir);

		db.prepare("DELETE FROM needs_human_input WHERE task_id = ?").run(taskId);
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to clear needs human input");
	}
}

/**
 * Check if an error pattern has failed too many times and should request human input
 *
 * Returns true if:
 * 1. The same error signature has failed 2+ times across different tasks
 * 2. AND no human guidance exists for this pattern
 * 3. AND the task hasn't already been flagged
 */
export function shouldRequestHumanInput(
	errorSignature: string,
	taskId: string,
	stateDir: string = DEFAULT_STATE_DIR,
): boolean {
	try {
		initHumanInputTables(stateDir);

		// Check if guidance already exists
		const guidance = getHumanGuidance(errorSignature, stateDir);
		if (guidance) {
			return false; // Guidance exists, don't request again
		}

		// Check if task already flagged
		const db = getDatabase(stateDir);
		const alreadyFlagged = db.prepare("SELECT 1 FROM needs_human_input WHERE task_id = ?").get(taskId);
		if (alreadyFlagged) {
			return false; // Already flagged
		}

		// Check failure count for this signature in permanent_failures table
		const failureCount = db
			.prepare("SELECT COUNT(*) as count FROM permanent_failures WHERE signature = ?")
			.get(errorSignature) as { count: number } | undefined;

		// If 2+ different tasks have failed with this pattern, request human input
		return (failureCount?.count ?? 0) >= 2;
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to check if should request human input");
		return false;
	}
}

/**
 * Get formatted human guidance prompt for a worker
 * Returns a string to inject into the agent's context
 */
export function formatGuidanceForWorker(errorSignature: string, stateDir: string = DEFAULT_STATE_DIR): string | null {
	const guidance = getHumanGuidance(errorSignature, stateDir);
	if (!guidance) {
		return null;
	}

	return `
## Human Guidance for This Error

A human has provided the following guidance for errors like this:

${guidance.guidance}

Please apply this guidance when attempting to fix the issue.
`;
}

/**
 * Get stats about human input tracking
 */
export function getHumanInputStats(stateDir: string = DEFAULT_STATE_DIR): {
	guidanceCount: number;
	successfulGuidance: number;
	tasksNeedingInput: number;
	topPatterns: Array<{ signature: string; timesUsed: number; successful: boolean }>;
} {
	try {
		initHumanInputTables(stateDir);
		const db = getDatabase(stateDir);

		const guidanceCount = (db.prepare("SELECT COUNT(*) as count FROM human_guidance").get() as { count: number }).count;

		const successfulGuidance = (
			db.prepare("SELECT COUNT(*) as count FROM human_guidance WHERE used_successfully = 1").get() as { count: number }
		).count;

		const tasksNeedingInput = (db.prepare("SELECT COUNT(*) as count FROM needs_human_input").get() as { count: number })
			.count;

		const topPatterns = db
			.prepare(
				`
			SELECT error_signature, times_used, used_successfully
			FROM human_guidance
			ORDER BY times_used DESC
			LIMIT 10
		`,
			)
			.all() as Array<{
			error_signature: string;
			times_used: number;
			used_successfully: number;
		}>;

		return {
			guidanceCount,
			successfulGuidance,
			tasksNeedingInput,
			topPatterns: topPatterns.map((p) => ({
				signature: p.error_signature,
				timesUsed: p.times_used,
				successful: p.used_successfully === 1,
			})),
		};
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to get human input stats");
		return {
			guidanceCount: 0,
			successfulGuidance: 0,
			tasksNeedingInput: 0,
			topPatterns: [],
		};
	}
}
