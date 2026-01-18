/**
 * Visualization Data Extraction
 *
 * Reads grind-events.jsonl and tasks.json to build visualization data structures.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./task.js";

const UNDERCITY_DIR = ".undercity";
const EVENTS_FILE = "grind-events.jsonl";
const TASKS_FILE = "tasks.json";

/**
 * Task data for visualization
 */
export interface VisualizationTask {
	id: string;
	objective: string;
	parentId?: string;
	subtaskIds?: string[];
	status: "complete" | "failed" | "escalated" | "in_progress" | "pending";
	model: string;
	startedAt: Date;
	completedAt?: Date;
	durationSecs: number;
	tokens: number;
	attempts: number;
	escalations?: string[];
	error?: string;
}

/**
 * Session data for visualization
 */
export interface VisualizationSession {
	batchId: string;
	startedAt: Date;
	endedAt?: Date;
	durationMins: number;
	parallelism: number;
	tasks: VisualizationTask[];
	stats: {
		total: number;
		successful: number;
		failed: number;
		merged: number;
		totalTokens: number;
		modelDistribution: Record<string, number>;
	};
}

/**
 * Raw event types from grind-events.jsonl
 */
interface GrindStartEvent {
	ts: string;
	type: "grind_start";
	batch: string;
	tasks: number;
	parallelism: number;
	models: Record<string, number>;
}

interface GrindEndEvent {
	ts: string;
	type: "grind_end";
	batch: string;
	ok: number;
	fail: number;
	merged: number;
	mins: number;
	tokens?: number;
}

interface TaskStartEvent {
	ts: string;
	type: "task_start";
	batch: string;
	task: string;
	model: string;
	obj: string;
}

interface TaskCompleteEvent {
	ts: string;
	type: "task_complete";
	batch: string;
	task: string;
	model: string;
	attempts: number;
	files: number;
	tokens: number;
	secs: number;
	sha?: string;
}

interface TaskFailedEvent {
	ts: string;
	type: "task_failed";
	batch: string;
	task: string;
	reason: string;
	model: string;
	attempts: number;
	escalations?: string[];
	tokens: number;
	secs: number;
	error?: string;
}

interface TaskEscalatedEvent {
	ts: string;
	type: "task_escalated";
	batch: string;
	task: string;
	from: string;
	to: string;
	attempt: number;
	why: string;
}

type GrindEvent =
	| GrindStartEvent
	| GrindEndEvent
	| TaskStartEvent
	| TaskCompleteEvent
	| TaskFailedEvent
	| TaskEscalatedEvent
	| { ts: string; type: string; batch?: string; [key: string]: unknown };

/**
 * Read all events from grind-events.jsonl
 */
function readAllEvents(): GrindEvent[] {
	const path = join(process.cwd(), UNDERCITY_DIR, EVENTS_FILE);
	if (!existsSync(path)) return [];

	const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
	return lines
		.map((line) => {
			try {
				return JSON.parse(line) as GrindEvent;
			} catch {
				return null;
			}
		})
		.filter((e): e is GrindEvent => e !== null);
}

/**
 * Load tasks from tasks.json
 */
function loadTasks(): Task[] {
	const path = join(process.cwd(), UNDERCITY_DIR, TASKS_FILE);
	if (!existsSync(path)) return [];

	try {
		const content = readFileSync(path, "utf-8");
		const board = JSON.parse(content) as { tasks: Task[] };
		return board.tasks || [];
	} catch {
		return [];
	}
}

/**
 * List available grind sessions (batch IDs)
 */
export function listGrindSessions(limit = 20): string[] {
	const events = readAllEvents();
	const batchIds = new Set<string>();

	// Collect batch IDs from grind_start events (most recent first)
	for (let i = events.length - 1; i >= 0 && batchIds.size < limit; i--) {
		const event = events[i];
		if (event.type === "grind_start" && event.batch) {
			batchIds.add(event.batch);
		}
	}

	return Array.from(batchIds);
}

/**
 * Get session data for a specific batch ID
 */
export function getSessionData(batchId: string): VisualizationSession | null {
	const events = readAllEvents();
	const tasks = loadTasks();

	// Find events for this batch
	const batchEvents = events.filter((e) => e.batch === batchId);
	if (batchEvents.length === 0) return null;

	// Find grind_start and grind_end events
	const startEvent = batchEvents.find((e) => e.type === "grind_start") as GrindStartEvent | undefined;
	const endEvent = batchEvents.find((e) => e.type === "grind_end") as GrindEndEvent | undefined;

	if (!startEvent) return null;

	// Collect task events
	const taskStarts = new Map<string, TaskStartEvent>();
	const taskCompletes = new Map<string, TaskCompleteEvent>();
	const taskFailures = new Map<string, TaskFailedEvent>();
	const taskEscalations = new Map<string, TaskEscalatedEvent[]>();

	for (const event of batchEvents) {
		if (event.type === "task_start" && "task" in event) {
			const taskEvent = event as TaskStartEvent;
			taskStarts.set(taskEvent.task, taskEvent);
		} else if (event.type === "task_complete" && "task" in event) {
			const taskEvent = event as TaskCompleteEvent;
			taskCompletes.set(taskEvent.task, taskEvent);
		} else if (event.type === "task_failed" && "task" in event) {
			const taskEvent = event as TaskFailedEvent;
			taskFailures.set(taskEvent.task, taskEvent);
		} else if (event.type === "task_escalated" && "task" in event) {
			const escalated = event as TaskEscalatedEvent;
			const existing = taskEscalations.get(escalated.task) || [];
			existing.push(escalated);
			taskEscalations.set(escalated.task, existing);
		}
	}

	// Build task map from task board for parent/subtask relationships
	const taskMap = new Map<string, Task>();
	for (const task of tasks) {
		taskMap.set(task.id, task);
	}

	// Build visualization tasks
	const vizTasks: VisualizationTask[] = [];
	const modelDistribution: Record<string, number> = {};
	let totalTokens = 0;
	let successful = 0;
	let failed = 0;

	// Process all task IDs that appeared in events
	const allTaskIds = new Set<string>([...taskStarts.keys(), ...taskCompletes.keys(), ...taskFailures.keys()]);

	for (const taskId of allTaskIds) {
		const start = taskStarts.get(taskId);
		const complete = taskCompletes.get(taskId);
		const failure = taskFailures.get(taskId);
		const escalations = taskEscalations.get(taskId) || [];
		const boardTask = taskMap.get(taskId);

		// Determine status
		let status: VisualizationTask["status"] = "in_progress";
		if (complete) {
			status = "complete";
			successful++;
		} else if (failure) {
			status = escalations.length > 0 ? "escalated" : "failed";
			failed++;
		}

		// Get model (final model used)
		const model = complete?.model || failure?.model || start?.model || "unknown";

		// Track model distribution
		modelDistribution[model] = (modelDistribution[model] || 0) + 1;

		// Calculate duration and tokens
		const tokens = complete?.tokens || failure?.tokens || 0;
		totalTokens += tokens;
		const durationSecs = complete?.secs || failure?.secs || 0;

		// Build escalation strings
		const escalationStrings = escalations.map((e) => `${e.from}→${e.to}@${e.attempt}`);

		const vizTask: VisualizationTask = {
			id: taskId,
			objective: start?.obj || boardTask?.objective || `Task ${taskId}`,
			parentId: boardTask?.parentId,
			subtaskIds: boardTask?.subtaskIds,
			status,
			model,
			startedAt: new Date(start?.ts || startEvent.ts),
			completedAt: complete ? new Date(complete.ts) : failure ? new Date(failure.ts) : undefined,
			durationSecs,
			tokens,
			attempts: complete?.attempts || failure?.attempts || 1,
			escalations: escalationStrings.length > 0 ? escalationStrings : undefined,
			error: failure?.error,
		};

		vizTasks.push(vizTask);
	}

	// Sort tasks by start time
	vizTasks.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

	// Calculate session duration
	const startTime = new Date(startEvent.ts);
	const endTime = endEvent ? new Date(endEvent.ts) : new Date();
	const durationMins = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

	return {
		batchId,
		startedAt: startTime,
		endedAt: endEvent ? new Date(endEvent.ts) : undefined,
		durationMins: endEvent?.mins ?? durationMins,
		parallelism: startEvent.parallelism,
		tasks: vizTasks,
		stats: {
			total: allTaskIds.size,
			successful,
			failed,
			merged: endEvent?.merged ?? 0,
			totalTokens,
			modelDistribution,
		},
	};
}

/**
 * Get the latest grind session
 */
export function getLatestSession(): VisualizationSession | null {
	const sessions = listGrindSessions(1);
	if (sessions.length === 0) return null;
	return getSessionData(sessions[0]);
}

/**
 * Format duration for display
 */
export function formatDuration(secs: number): string {
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainingSecs = secs % 60;
	if (mins < 60) return `${mins}m ${remainingSecs}s`;
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	return `${hours}h ${remainingMins}m`;
}

/**
 * Format token count for display
 */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1000000).toFixed(2)}M`;
}
