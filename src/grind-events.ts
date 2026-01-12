/**
 * Grind Event Logger
 *
 * Structured event logging for grind operations.
 * Writes to .undercity/grind-events.jsonl for easy consumption by Claude.
 *
 * This module provides observability into grind runs:
 * - What tasks are being processed
 * - Why tasks succeed/fail
 * - Progress through batches
 * - Model routing decisions
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNDERCITY_DIR = ".undercity";
const EVENTS_FILE = "grind-events.jsonl";
const MAX_EVENTS = 1000; // Keep last N events

/**
 * Event types for grind operations
 */
export type GrindEventType =
	| "grind_start"
	| "grind_complete"
	| "batch_start"
	| "batch_complete"
	| "task_queued"
	| "task_decomposed"
	| "task_started"
	| "task_progress"
	| "task_complete"
	| "task_failed"
	| "merge_started"
	| "merge_complete"
	| "merge_failed"
	| "rate_limit_hit"
	| "error";

/**
 * A structured grind event
 */
export interface GrindEvent {
	timestamp: string;
	type: GrindEventType;
	batchId?: string;
	taskId?: string;
	message: string;
	data?: Record<string, unknown>;
}

/**
 * Get the path to the events file
 */
function getEventsPath(): string {
	return join(process.cwd(), UNDERCITY_DIR, EVENTS_FILE);
}

/**
 * Ensure the .undercity directory exists
 */
function ensureDir(): void {
	const dir = join(process.cwd(), UNDERCITY_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Log a grind event
 */
export function logEvent(
	type: GrindEventType,
	message: string,
	options?: {
		batchId?: string;
		taskId?: string;
		data?: Record<string, unknown>;
	},
): void {
	ensureDir();

	const event: GrindEvent = {
		timestamp: new Date().toISOString(),
		type,
		message,
		...options,
	};

	const line = `${JSON.stringify(event)}\n`;
	appendFileSync(getEventsPath(), line);
}

/**
 * Start a new grind session - clears old events and logs start
 */
export function startGrindSession(options: {
	batchId: string;
	taskCount: number;
	maxCount?: number;
	parallelism: number;
	modelDistribution?: Record<string, number>;
}): void {
	ensureDir();

	// Rotate old events if file is too large
	rotateEventsIfNeeded();

	logEvent("grind_start", "Starting grind session", {
		batchId: options.batchId,
		data: {
			taskCount: options.taskCount,
			maxCount: options.maxCount,
			parallelism: options.parallelism,
			modelDistribution: options.modelDistribution,
		},
	});
}

/**
 * Log grind completion
 */
export function endGrindSession(options: {
	batchId: string;
	successful: number;
	failed: number;
	merged: number;
	durationMs: number;
}): void {
	logEvent("grind_complete", "Grind session complete", {
		batchId: options.batchId,
		data: {
			successful: options.successful,
			failed: options.failed,
			merged: options.merged,
			durationMs: options.durationMs,
			durationMinutes: Math.round(options.durationMs / 60000),
		},
	});
}

/**
 * Log task being queued for processing
 */
export function logTaskQueued(options: {
	batchId: string;
	taskId: string;
	objective: string;
	recommendedModel: string;
}): void {
	logEvent("task_queued", `Task queued: ${options.objective.substring(0, 60)}...`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			objective: options.objective,
			recommendedModel: options.recommendedModel,
		},
	});
}

/**
 * Log task decomposition
 */
export function logTaskDecomposed(options: {
	batchId: string;
	taskId: string;
	originalObjective: string;
	subtaskCount: number;
	subtasks: Array<{ objective: string }>;
	reasoning: string;
}): void {
	logEvent("task_decomposed", `Task decomposed into ${options.subtaskCount} subtasks`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			originalObjective: options.originalObjective,
			subtaskCount: options.subtaskCount,
			subtasks: options.subtasks.map((s) => s.objective.substring(0, 80)),
			reasoning: options.reasoning,
		},
	});
}

/**
 * Log task execution started
 */
export function logTaskStarted(options: {
	batchId: string;
	taskId: string;
	objective: string;
	model: string;
	worktreePath?: string;
}): void {
	logEvent("task_started", `Task started with ${options.model}: ${options.objective.substring(0, 60)}...`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			objective: options.objective,
			model: options.model,
			worktreePath: options.worktreePath,
		},
	});
}

/**
 * Log task progress (for long-running tasks)
 */
export function logTaskProgress(options: { batchId: string; taskId: string; stage: string; details?: string }): void {
	logEvent("task_progress", `Task progress: ${options.stage}`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			stage: options.stage,
			details: options.details,
		},
	});
}

/**
 * Log task completion
 */
export function logTaskComplete(options: {
	batchId: string;
	taskId: string;
	objective: string;
	durationMs: number;
	modifiedFiles?: string[];
	commitSha?: string;
}): void {
	logEvent("task_complete", `Task complete: ${options.objective.substring(0, 60)}...`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			objective: options.objective,
			durationMs: options.durationMs,
			durationSeconds: Math.round(options.durationMs / 1000),
			modifiedFiles: options.modifiedFiles,
			fileCount: options.modifiedFiles?.length ?? 0,
			commitSha: options.commitSha,
		},
	});
}

/**
 * Log task failure
 */
export function logTaskFailed(options: {
	batchId: string;
	taskId: string;
	objective: string;
	error: string;
	durationMs?: number;
	stage?: string;
}): void {
	logEvent("task_failed", `Task failed: ${options.error.substring(0, 100)}`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: {
			objective: options.objective,
			error: options.error,
			durationMs: options.durationMs,
			stage: options.stage,
		},
	});
}

/**
 * Log merge started
 */
export function logMergeStarted(options: { batchId: string; taskId: string; branch: string }): void {
	logEvent("merge_started", `Merge started for ${options.taskId}`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: { branch: options.branch },
	});
}

/**
 * Log merge completion
 */
export function logMergeComplete(options: { batchId: string; taskId: string }): void {
	logEvent("merge_complete", `Merge complete for ${options.taskId}`, {
		batchId: options.batchId,
		taskId: options.taskId,
	});
}

/**
 * Log merge failure
 */
export function logMergeFailed(options: { batchId: string; taskId: string; error: string }): void {
	logEvent("merge_failed", `Merge failed for ${options.taskId}: ${options.error.substring(0, 100)}`, {
		batchId: options.batchId,
		taskId: options.taskId,
		data: { error: options.error },
	});
}

/**
 * Log rate limit hit
 */
export function logRateLimitHit(options: { batchId?: string; model: string; details?: string }): void {
	logEvent("rate_limit_hit", `Rate limit hit for ${options.model}`, {
		batchId: options.batchId,
		data: { model: options.model, details: options.details },
	});
}

/**
 * Log general error
 */
export function logError(message: string, options?: { batchId?: string; taskId?: string; error?: string }): void {
	logEvent("error", message, {
		batchId: options?.batchId,
		taskId: options?.taskId,
		data: options?.error ? { error: options.error } : undefined,
	});
}

/**
 * Read recent events from the log
 */
export function readRecentEvents(count = 50): GrindEvent[] {
	const eventsPath = getEventsPath();
	if (!existsSync(eventsPath)) {
		return [];
	}

	const content = readFileSync(eventsPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	// Get last N lines
	const recentLines = lines.slice(-count);

	return recentLines.map((line) => {
		try {
			return JSON.parse(line) as GrindEvent;
		} catch {
			return {
				timestamp: new Date().toISOString(),
				type: "error" as const,
				message: `Failed to parse event: ${line.substring(0, 50)}`,
			};
		}
	});
}

/**
 * Get current grind status from events
 */
export function getCurrentGrindStatus(): {
	isRunning: boolean;
	batchId?: string;
	startedAt?: string;
	tasksQueued: number;
	tasksStarted: number;
	tasksComplete: number;
	tasksFailed: number;
	lastEvent?: GrindEvent;
} {
	const events = readRecentEvents(200);
	if (events.length === 0) {
		return {
			isRunning: false,
			tasksQueued: 0,
			tasksStarted: 0,
			tasksComplete: 0,
			tasksFailed: 0,
		};
	}

	// Find the most recent grind_start
	let lastStartIdx = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "grind_start") {
			lastStartIdx = i;
			break;
		}
	}

	if (lastStartIdx === -1) {
		return {
			isRunning: false,
			tasksQueued: 0,
			tasksStarted: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			lastEvent: events[events.length - 1],
		};
	}

	const currentSessionEvents = events.slice(lastStartIdx);
	const startEvent = currentSessionEvents[0];
	const batchId = startEvent.batchId;

	// Check if session completed
	const isComplete = currentSessionEvents.some((e) => e.type === "grind_complete");

	// Count events for this session
	const tasksQueued = currentSessionEvents.filter((e) => e.type === "task_queued").length;
	const tasksStarted = currentSessionEvents.filter((e) => e.type === "task_started").length;
	const tasksComplete = currentSessionEvents.filter((e) => e.type === "task_complete").length;
	const tasksFailed = currentSessionEvents.filter((e) => e.type === "task_failed").length;

	return {
		isRunning: !isComplete,
		batchId,
		startedAt: startEvent.timestamp,
		tasksQueued,
		tasksStarted,
		tasksComplete,
		tasksFailed,
		lastEvent: currentSessionEvents[currentSessionEvents.length - 1],
	};
}

/**
 * Rotate events file if it's too large
 */
function rotateEventsIfNeeded(): void {
	const eventsPath = getEventsPath();
	if (!existsSync(eventsPath)) {
		return;
	}

	const content = readFileSync(eventsPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	if (lines.length > MAX_EVENTS) {
		// Keep the last MAX_EVENTS/2 events
		const keepLines = lines.slice(-Math.floor(MAX_EVENTS / 2));
		writeFileSync(eventsPath, `${keepLines.join("\n")}\n`);
	}
}

/**
 * Clear all events (for testing)
 */
export function clearEvents(): void {
	const eventsPath = getEventsPath();
	if (existsSync(eventsPath)) {
		writeFileSync(eventsPath, "");
	}
}
