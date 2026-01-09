/**
 * Backlog Module
 *
 * Manages a queue of goals for undercity to work through.
 * Goals are processed sequentially in full-auto mode.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BacklogItem {
	id: string;
	goal: string;
	status: "pending" | "in_progress" | "complete" | "failed";
	priority?: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	raidId?: string;
	error?: string;
}

export interface Backlog {
	items: BacklogItem[];
	lastUpdated: Date;
}

const DEFAULT_BACKLOG_PATH = ".undercity/backlog.json";

/**
 * Generate a unique backlog item ID
 */
function generateItemId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `goal-${timestamp}-${random}`;
}

/**
 * Load backlog from disk
 */
export function loadBacklog(path: string = DEFAULT_BACKLOG_PATH): Backlog {
	if (!existsSync(path)) {
		return { items: [], lastUpdated: new Date() };
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as Backlog;
	} catch {
		return { items: [], lastUpdated: new Date() };
	}
}

/**
 * Save backlog to disk
 */
export function saveBacklog(backlog: Backlog, path: string = DEFAULT_BACKLOG_PATH): void {
	backlog.lastUpdated = new Date();
	writeFileSync(path, JSON.stringify(backlog, null, 2));
}

/**
 * Add a goal to the backlog
 */
export function addGoal(goal: string, priority?: number): BacklogItem {
	const backlog = loadBacklog();
	const item: BacklogItem = {
		id: generateItemId(),
		goal,
		status: "pending",
		priority: priority ?? backlog.items.length,
		createdAt: new Date(),
	};
	backlog.items.push(item);
	saveBacklog(backlog);
	return item;
}

/**
 * Add multiple goals to the backlog
 */
export function addGoals(goals: string[]): BacklogItem[] {
	const backlog = loadBacklog();
	const items: BacklogItem[] = goals.map((goal, i) => ({
		id: generateItemId(),
		goal,
		status: "pending" as const,
		priority: backlog.items.length + i,
		createdAt: new Date(),
	}));
	backlog.items.push(...items);
	saveBacklog(backlog);
	return items;
}

/**
 * Get the next pending goal
 */
export function getNextGoal(): BacklogItem | undefined {
	const backlog = loadBacklog();
	return backlog.items
		.filter((item) => item.status === "pending")
		.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
}

/**
 * Mark a goal as in progress
 */
export function markInProgress(id: string, raidId: string): void {
	const backlog = loadBacklog();
	const item = backlog.items.find((i) => i.id === id);
	if (item) {
		item.status = "in_progress";
		item.startedAt = new Date();
		item.raidId = raidId;
		saveBacklog(backlog);
	}
}

/**
 * Mark a goal as complete
 */
export function markComplete(id: string): void {
	const backlog = loadBacklog();
	const item = backlog.items.find((i) => i.id === id);
	if (item) {
		item.status = "complete";
		item.completedAt = new Date();
		saveBacklog(backlog);
	}
}

/**
 * Mark a goal as failed
 */
export function markFailed(id: string, error: string): void {
	const backlog = loadBacklog();
	const item = backlog.items.find((i) => i.id === id);
	if (item) {
		item.status = "failed";
		item.completedAt = new Date();
		item.error = error;
		saveBacklog(backlog);
	}
}

/**
 * Get backlog summary
 */
export function getBacklogSummary(): { pending: number; inProgress: number; complete: number; failed: number } {
	const backlog = loadBacklog();
	return {
		pending: backlog.items.filter((i) => i.status === "pending").length,
		inProgress: backlog.items.filter((i) => i.status === "in_progress").length,
		complete: backlog.items.filter((i) => i.status === "complete").length,
		failed: backlog.items.filter((i) => i.status === "failed").length,
	};
}

/**
 * Clear completed items from backlog
 */
export function clearCompleted(): number {
	const backlog = loadBacklog();
	const before = backlog.items.length;
	backlog.items = backlog.items.filter((i) => i.status !== "complete");
	saveBacklog(backlog);
	return before - backlog.items.length;
}

/**
 * Get all backlog items
 */
export function getAllItems(): BacklogItem[] {
	return loadBacklog().items;
}
