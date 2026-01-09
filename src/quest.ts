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

	// NEW: Quest Matchmaking Fields
	packageHints?: string[];           // Manual package hints
	dependsOn?: string[];              // Quest IDs this quest depends on
	conflicts?: string[];              // Quest IDs that conflict with this one
	estimatedFiles?: string[];         // Expected files to be modified
	tags?: string[];                   // Categorization tags (feature, bugfix, refactor)

	// Computed during matchmaking
	computedPackages?: string[];       // Auto-detected package boundaries
	riskScore?: number;                // File overlap risk (0-1)
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

/**
 * Get ready quests for parallel execution
 * Returns pending quests sorted by priority, limited to the specified count
 */
export function getReadyQuestsForBatch(count: number = 3): Quest[] {
	const board = loadQuestBoard();
	return board.quests
		.filter((quest) => quest.status === "pending")
		.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
		.slice(0, count);
}

/**
 * Mark multiple quests as in progress
 */
export function markQuestSetInProgress(questIds: string[], raidIds: string[]): void {
	const board = loadQuestBoard();
	for (let i = 0; i < questIds.length; i++) {
		const questId = questIds[i];
		const raidId = raidIds[i];
		const quest = board.quests.find((q) => q.id === questId);
		if (quest) {
			quest.status = "in_progress";
			quest.startedAt = new Date();
			quest.raidId = raidId;
		}
	}
	saveQuestBoard(board);
}

/**
 * Get status of a set of quests
 */
export function getQuestSetStatus(questIds: string[]): {
	pending: number;
	inProgress: number;
	complete: number;
	failed: number;
	blocked: number;
} {
	const board = loadQuestBoard();
	const quests = board.quests.filter(q => questIds.includes(q.id));

	return {
		pending: quests.filter(q => q.status === "pending").length,
		inProgress: quests.filter(q => q.status === "in_progress").length,
		complete: quests.filter(q => q.status === "complete").length,
		failed: quests.filter(q => q.status === "failed").length,
		blocked: 0, // Will be computed by dependency analysis
	};
}

/**
 * Get quest board analytics for optimization insights
 */
export function getQuestBoardAnalytics(): {
	totalQuests: number;
	averageCompletionTime: number;
	parallelizationOpportunities: number;
	topConflictingPackages: string[];
} {
	const board = loadQuestBoard();
	const completedQuests = board.quests.filter(q => q.status === "complete");

	// Calculate average completion time
	let totalTime = 0;
	let validTimes = 0;
	for (const quest of completedQuests) {
		if (quest.startedAt && quest.completedAt) {
			const duration = new Date(quest.completedAt).getTime() - new Date(quest.startedAt).getTime();
			totalTime += duration;
			validTimes++;
		}
	}
	const averageCompletionTime = validTimes > 0 ? totalTime / validTimes : 0;

	// Count pending quests as parallelization opportunities
	const pendingQuests = board.quests.filter(q => q.status === "pending").length;

	// Collect package hints for conflict analysis
	const packageCounts = new Map<string, number>();
	for (const quest of board.quests) {
		const packages = quest.computedPackages || quest.packageHints || [];
		for (const pkg of packages) {
			packageCounts.set(pkg, (packageCounts.get(pkg) || 0) + 1);
		}
	}

	// Get top conflicting packages (most frequently touched)
	const topConflictingPackages = Array.from(packageCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([pkg]) => pkg);

	return {
		totalQuests: board.quests.length,
		averageCompletionTime,
		parallelizationOpportunities: pendingQuests,
		topConflictingPackages,
	};
}

/**
 * Update quest with computed analysis results
 */
export function updateQuestAnalysis(questId: string, analysis: {
	computedPackages?: string[];
	riskScore?: number;
	estimatedFiles?: string[];
	tags?: string[];
}): void {
	const board = loadQuestBoard();
	const quest = board.quests.find(q => q.id === questId);
	if (quest) {
		if (analysis.computedPackages) quest.computedPackages = analysis.computedPackages;
		if (analysis.riskScore !== undefined) quest.riskScore = analysis.riskScore;
		if (analysis.estimatedFiles) quest.estimatedFiles = analysis.estimatedFiles;
		if (analysis.tags) quest.tags = analysis.tags;
		saveQuestBoard(board);
	}
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
