/**
 * Quest Board Module
 *
 * Manages the quest board - a queue of quests for undercity to work through.
 * Quests are processed sequentially in full-auto mode.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Quest {
	id: string;
	objective: string;
	status: "pending" | "in_progress" | "complete" | "failed";
	priority?: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	raidId?: string;
	error?: string;
}

export interface QuestBoard {
	quests: Quest[];
	lastUpdated: Date;
}

const DEFAULT_QUEST_BOARD_PATH = ".undercity/quests.json";

/**
 * Generate a unique quest ID
 */
function generateQuestId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `quest-${timestamp}-${random}`;
}

/**
 * Load quest board from disk
 */
export function loadQuestBoard(path: string = DEFAULT_QUEST_BOARD_PATH): QuestBoard {
	if (!existsSync(path)) {
		return { quests: [], lastUpdated: new Date() };
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as QuestBoard;
	} catch {
		return { quests: [], lastUpdated: new Date() };
	}
}

/**
 * Save quest board to disk
 */
export function saveQuestBoard(board: QuestBoard, path: string = DEFAULT_QUEST_BOARD_PATH): void {
	board.lastUpdated = new Date();
	writeFileSync(path, JSON.stringify(board, null, 2));
}

/**
 * Add a quest to the board
 */
export function addQuest(objective: string, priority?: number): Quest {
	const board = loadQuestBoard();
	const quest: Quest = {
		id: generateQuestId(),
		objective,
		status: "pending",
		priority: priority ?? board.quests.length,
		createdAt: new Date(),
	};
	board.quests.push(quest);
	saveQuestBoard(board);
	return quest;
}

/**
 * Add multiple quests to the board
 */
export function addQuests(objectives: string[]): Quest[] {
	const board = loadQuestBoard();
	const quests: Quest[] = objectives.map((objective, i) => ({
		id: generateQuestId(),
		objective,
		status: "pending" as const,
		priority: board.quests.length + i,
		createdAt: new Date(),
	}));
	board.quests.push(...quests);
	saveQuestBoard(board);
	return quests;
}

/**
 * Get the next pending quest
 */
export function getNextQuest(): Quest | undefined {
	const board = loadQuestBoard();
	return board.quests
		.filter((quest) => quest.status === "pending")
		.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
}

/**
 * Mark a quest as in progress
 */
export function markQuestInProgress(id: string, raidId: string): void {
	const board = loadQuestBoard();
	const quest = board.quests.find((q) => q.id === id);
	if (quest) {
		quest.status = "in_progress";
		quest.startedAt = new Date();
		quest.raidId = raidId;
		saveQuestBoard(board);
	}
}

/**
 * Mark a quest as complete
 */
export function markQuestComplete(id: string): void {
	const board = loadQuestBoard();
	const quest = board.quests.find((q) => q.id === id);
	if (quest) {
		quest.status = "complete";
		quest.completedAt = new Date();
		saveQuestBoard(board);
	}
}

/**
 * Mark a quest as failed
 */
export function markQuestFailed(id: string, error: string): void {
	const board = loadQuestBoard();
	const quest = board.quests.find((q) => q.id === id);
	if (quest) {
		quest.status = "failed";
		quest.completedAt = new Date();
		quest.error = error;
		saveQuestBoard(board);
	}
}

/**
 * Get quest board summary
 */
export function getQuestBoardSummary(): { pending: number; inProgress: number; complete: number; failed: number } {
	const board = loadQuestBoard();
	return {
		pending: board.quests.filter((q) => q.status === "pending").length,
		inProgress: board.quests.filter((q) => q.status === "in_progress").length,
		complete: board.quests.filter((q) => q.status === "complete").length,
		failed: board.quests.filter((q) => q.status === "failed").length,
	};
}

/**
 * Clear completed quests from the board
 */
export function clearCompletedQuests(): number {
	const board = loadQuestBoard();
	const before = board.quests.length;
	board.quests = board.quests.filter((q) => q.status !== "complete");
	saveQuestBoard(board);
	return before - board.quests.length;
}

/**
 * Get all quests
 */
export function getAllQuests(): Quest[] {
	return loadQuestBoard().quests;
}

// Legacy aliases for backwards compatibility during migration
export const BacklogItem = {} as Quest;
export const Backlog = {} as QuestBoard;
export const loadBacklog = loadQuestBoard;
export const saveBacklog = saveQuestBoard;
export const addGoal = addQuest;
export const addGoals = addQuests;
export const getNextGoal = getNextQuest;
export const markInProgress = markQuestInProgress;
export const markComplete = markQuestComplete;
export const markFailed = markQuestFailed;
export const getBacklogSummary = getQuestBoardSummary;
export const clearCompleted = clearCompletedQuests;
export const getAllItems = getAllQuests;
