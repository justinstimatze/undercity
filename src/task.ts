/**
 * Task Board Module
 *
 * Task queue management for undercity with SQLite persistence.
 *
 * | Operation        | Function                                   |
 * |------------------|--------------------------------------------|
 * | Add              | addTask(), addTasks()                      |
 * | Query            | getNextTask(), getAllTasks(), getTaskById()|
 * | Status update    | markTaskInProgress/Complete/Failed/...     |
 * | Decomposition    | decomposeTaskIntoSubtasks()                |
 * | Reconciliation   | reconcileTasks() - sync with git history   |
 */

import { randomBytes } from "node:crypto";
import { sessionLogger } from "./logger.js";
import {
	clearCompletedTasksDB,
	getAllTasksDB,
	getReadyTasksDB,
	getTaskBoardSummaryDB,
	getTaskByIdDB,
	getTasksByStatusDB,
	insertTask,
	markTaskDecomposedDB,
	removeTaskDB,
	removeTasksDB,
	type HandoffContext as StorageHandoffContext,
	type TaskRecord,
	type TaskStatus,
	updateTaskAnalysisDB,
	updateTaskFieldsDB,
	updateTaskStatusDB,
} from "./storage.js";
import { isTaskObjectiveSafe, validateTaskObjective } from "./task-security.js";
import type { ResearchConclusion, TicketContent } from "./types.js";

const DEFAULT_STATE_DIR = ".undercity";

/**
 * Get the state directory from a path parameter
 * Extracts .undercity directory from paths like "/tmp/test/.undercity/tasks.json"
 */
function getStateDirFromPath(pathParam?: string): string {
	if (!pathParam) {
		return DEFAULT_STATE_DIR;
	}
	// Path could be like "/tmp/test/.undercity/tasks.json" or "/tmp/test/.undercity"
	// Extract the .undercity directory
	const parts = pathParam.split("/");
	const undercityIndex = parts.indexOf(".undercity");
	if (undercityIndex !== -1) {
		return parts.slice(0, undercityIndex + 1).join("/");
	}
	// If path doesn't contain .undercity, use path as directory
	return pathParam.endsWith(".json") ? pathParam.replace(/\/[^/]+$/, "") : pathParam;
}

export interface Task {
	id: string;
	objective: string;
	status:
		| "pending"
		| "in_progress"
		| "decomposed" // Parent task split into subtasks (waiting for subtasks to complete)
		| "complete"
		| "failed"
		| "blocked"
		| "duplicate" // Already completed in another commit
		| "canceled" // User decided not to do this
		| "obsolete"; // No longer relevant/needed
	priority?: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	sessionId?: string;
	error?: string;

	// For duplicate/canceled/obsolete tasks
	resolution?: string; // Why it was marked this way
	duplicateOfCommit?: string; // SHA of commit that completed this work

	// NEW: Task Matchmaking Fields
	packageHints?: string[]; // Manual package hints
	dependsOn?: string[]; // Task IDs this task depends on (blocking)
	relatedTo?: string[]; // Task IDs this task is related to (non-blocking, for context)
	conflicts?: string[]; // Task IDs that conflict with this one
	estimatedFiles?: string[]; // Expected files to be modified
	tags?: string[]; // Categorization tags (feature, bugfix, refactor)

	// Computed during matchmaking
	computedPackages?: string[]; // Auto-detected package boundaries
	riskScore?: number; // File overlap risk (0-1)

	// Task decomposition fields
	parentId?: string; // ID of parent task (if this is a subtask)
	subtaskIds?: string[]; // IDs of subtasks (if this was decomposed)
	isDecomposed?: boolean; // True if this task was decomposed into subtasks
	decompositionDepth?: number; // How many levels of decomposition from root (0 = top-level)

	// Handoff context from Claude Code session
	handoffContext?: HandoffContext;

	// Last attempt context for retry tasks
	lastAttempt?: LastAttemptContext;

	// Research conclusion (for research tasks)
	researchConclusion?: ResearchConclusion;

	// Rich ticket content (description, acceptance criteria, test plan, etc.)
	ticket?: TicketContent;
}

/**
 * Context from a task's last failed attempt
 * Used to help agents avoid repeating the same mistakes on retry
 */
export interface LastAttemptContext {
	/** Model used during last attempt */
	model: string;
	/** Error category (typecheck, lint, test, build) */
	category: string;
	/** Error message from verification */
	error: string;
	/** Files that were modified during the attempt */
	filesModified: string[];
	/** When the attempt was made */
	attemptedAt: Date;
	/** Total attempts before giving up */
	attemptCount: number;
}

/**
 * Context passed from Claude Code session when dispatching tasks
 * Allows workers to start with relevant context instead of cold
 */
export interface HandoffContext {
	/** Files the caller already read/analyzed */
	filesRead?: string[];
	/** Key decisions or constraints the caller established */
	decisions?: string[];
	/** Relevant code snippets or context */
	codeContext?: string;
	/** Free-form notes from the caller */
	notes?: string;
	/** Context from previous failed attempt (for retry tasks) */
	lastAttempt?: LastAttemptContext;
	/** Whether this is a retry with human guidance */
	isRetry?: boolean;
	/** Human-provided guidance for this retry */
	humanGuidance?: string;
	/** The error that triggered the human input request */
	previousError?: string;
	/** Number of previous failed attempts */
	previousAttempts?: number;
}

export interface TaskBoard {
	tasks: Task[];
	lastUpdated: Date;
}

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
	const timestamp = Date.now().toString(36);
	const random = randomBytes(3).toString("hex");
	return `task-${timestamp}-${random}`;
}

/**
 * Convert TaskRecord (SQLite) to Task (API)
 */
function recordToTask(record: TaskRecord): Task {
	return {
		id: record.id,
		objective: record.objective,
		status: record.status,
		priority: record.priority,
		createdAt: new Date(record.createdAt),
		startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
		completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
		sessionId: record.sessionId,
		error: record.error,
		resolution: record.resolution,
		duplicateOfCommit: record.duplicateOfCommit,
		packageHints: record.packageHints,
		dependsOn: record.dependsOn,
		relatedTo: record.relatedTo,
		conflicts: record.conflicts,
		estimatedFiles: record.estimatedFiles,
		tags: record.tags,
		computedPackages: record.computedPackages,
		riskScore: record.riskScore,
		parentId: record.parentId,
		subtaskIds: record.subtaskIds,
		isDecomposed: record.isDecomposed,
		decompositionDepth: record.decompositionDepth,
		handoffContext: record.handoffContext as HandoffContext | undefined,
		lastAttempt: record.lastAttempt
			? {
					...record.lastAttempt,
					attemptedAt: new Date(record.lastAttempt.attemptedAt),
				}
			: undefined,
		researchConclusion: record.researchConclusion,
		ticket: record.ticket,
	};
}

/**
 * Convert Task (API) to TaskRecord (SQLite)
 */
function taskToRecord(task: Task): TaskRecord {
	return {
		id: task.id,
		objective: task.objective,
		status: task.status,
		priority: task.priority,
		createdAt: task.createdAt.toISOString(),
		startedAt: task.startedAt?.toISOString(),
		completedAt: task.completedAt?.toISOString(),
		sessionId: task.sessionId,
		error: task.error,
		resolution: task.resolution,
		duplicateOfCommit: task.duplicateOfCommit,
		packageHints: task.packageHints,
		dependsOn: task.dependsOn,
		relatedTo: task.relatedTo,
		conflicts: task.conflicts,
		estimatedFiles: task.estimatedFiles,
		tags: task.tags,
		computedPackages: task.computedPackages,
		riskScore: task.riskScore,
		parentId: task.parentId,
		subtaskIds: task.subtaskIds,
		isDecomposed: task.isDecomposed,
		decompositionDepth: task.decompositionDepth,
		handoffContext: task.handoffContext as StorageHandoffContext | undefined,
		lastAttempt: task.lastAttempt
			? {
					...task.lastAttempt,
					attemptedAt: task.lastAttempt.attemptedAt.toISOString(),
				}
			: undefined,
		researchConclusion: task.researchConclusion,
		ticket: task.ticket,
	};
}

/**
 * Options for adding a task
 */
export interface AddTaskOptions {
	priority?: number;
	handoffContext?: HandoffContext;
	path?: string;
	/** If true, skip duplicate detection (for internal use, e.g., decomposition) */
	skipDuplicateCheck?: boolean;
	/** Task IDs this task depends on (blocking) */
	dependsOn?: string[];
	/** Task IDs this task is related to (non-blocking, for context) */
	relatedTo?: string[];
	/** Tags for categorization */
	tags?: string[];
	/** Rich ticket content (description, acceptance criteria, etc.) */
	ticket?: TicketContent;
}

/**
 * Parameters for marking a task in progress
 */
export interface MarkTaskInProgressParams {
	id: string;
	sessionId: string;
	path?: string;
}

/**
 * Parameters for marking a task as failed
 */
export interface MarkTaskFailedParams {
	id: string;
	error: string;
	path?: string;
	/** Context from the failed attempt for future retry */
	lastAttempt?: LastAttemptContext;
}

/**
 * Parameters for marking a task as duplicate
 */
export interface MarkTaskDuplicateParams {
	id: string;
	commitSha: string;
	resolution: string;
	path?: string;
}

/**
 * Parameters for marking a task as canceled
 */
export interface MarkTaskCanceledParams {
	id: string;
	reason: string;
	path?: string;
}

/**
 * Parameters for marking a task as obsolete
 */
export interface MarkTaskObsoleteParams {
	id: string;
	reason: string;
	path?: string;
}

/**
 * Parameters for marking a task as complete
 */
export interface MarkTaskCompleteParams {
	id: string;
	path?: string;
}

/**
 * Parameters for blocking/unblocking a task
 */
export interface BlockTaskParams {
	id: string;
	path?: string;
}

/**
 * Parameters for removing a task
 */
export interface RemoveTaskParams {
	id: string;
	path?: string;
}

/**
 * Parameters for removing multiple tasks
 */
export interface RemoveTasksParams {
	ids: string[];
	path?: string;
}

/**
 * Parameters for checking subtask completion
 */
export interface SubtaskCheckParams {
	parentTaskId: string;
	path?: string;
}

/**
 * Parameters for getting a task by ID
 */
export interface GetTaskByIdParams {
	taskId: string;
	path?: string;
}

/**
 * Parameters for getting ready tasks for batch execution
 */
export interface GetReadyTasksParams {
	count?: number;
	path?: string;
}

/**
 * Parameters for updating task analysis
 */
export interface UpdateTaskAnalysisParams {
	taskId: string;
	analysis: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	};
	path?: string;
}

/**
 * Parameters for marking a set of tasks as in progress
 */
export interface MarkTaskSetInProgressParams {
	taskIds: string[];
	sessionIds: string[];
	path?: string;
}

/**
 * Parameters for finding similar in-progress tasks
 */
export interface FindSimilarTaskParams {
	objective: string;
	threshold?: number;
	path?: string;
}

/**
 * Parameters for decomposing a task into subtasks
 */
export interface DecomposeTaskParams {
	parentTaskId: string;
	subtasks: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>;
	path?: string;
}

/**
 * Parameters for clearing completed tasks
 */
export interface ClearCompletedTasksParams {
	path?: string;
}

/**
 * Parameters for updating a task
 */
export interface UpdateTaskParams {
	id: string;
	objective?: string;
	priority?: number;
	tags?: string[];
	status?: Task["status"];
	path?: string;
}

/**
 * Normalize objective text for comparison
 * Strips prefixes, lowercases, normalizes whitespace
 */
function normalizeObjective(objective: string): string {
	return objective
		.toLowerCase()
		.replace(/^\[[\w:]+\]\s*/i, "") // Remove [plan], [meta:triage], etc.
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extract significant words from objective (skip common words)
 */
function extractKeywords(objective: string): Set<string> {
	const stopWords = new Set([
		"a",
		"an",
		"the",
		"to",
		"in",
		"on",
		"at",
		"for",
		"of",
		"and",
		"or",
		"is",
		"it",
		"be",
		"as",
		"with",
		"that",
		"this",
		"from",
	]);
	const normalized = normalizeObjective(objective);
	const words = normalized.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
	return new Set(words);
}

/**
 * Calculate Jaccard similarity between two sets
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	const intersection = new Set([...a].filter((x) => b.has(x)));
	const union = new Set([...a, ...b]);
	return intersection.size / union.size;
}

/**
 * Check if a task is a duplicate of an existing pending/in_progress task
 * Returns the duplicate task if found, undefined otherwise
 */
export function findDuplicateTask(objective: string, stateDir: string = DEFAULT_STATE_DIR): Task | undefined {
	const normalized = normalizeObjective(objective);
	const keywords = extractKeywords(objective);

	// Only check pending and in_progress tasks
	const pendingTasks = getTasksByStatusDB("pending", stateDir).map(recordToTask);
	const inProgressTasks = getTasksByStatusDB("in_progress", stateDir).map(recordToTask);
	const activeTasks = [...pendingTasks, ...inProgressTasks];

	for (const task of activeTasks) {
		const taskNormalized = normalizeObjective(task.objective);

		// Exact match (after normalization)
		if (normalized === taskNormalized) {
			return task;
		}

		// Keyword-based similarity check
		const taskKeywords = extractKeywords(task.objective);

		// Skip similarity check if either task is too short (< 3 keywords)
		if (keywords.size < 3 || taskKeywords.size < 3) {
			continue;
		}

		// Check for high keyword overlap
		const intersection = new Set([...keywords].filter((k) => taskKeywords.has(k)));
		const similarity = jaccardSimilarity(keywords, taskKeywords);

		// Require 80% similarity AND at least 2 shared keywords
		if (similarity >= 0.8 && intersection.size >= 2) {
			return task;
		}
	}

	return undefined;
}

/**
 * Add a task to the board
 * Returns existing task if duplicate is detected (unless skipDuplicateCheck is set)
 */
export function addTask(objective: string, priorityOrOptions?: number | AddTaskOptions, pathParam?: string): Task {
	// Support both old signature (priority, path) and new signature (options)
	let priority: number | undefined;
	let handoffContext: HandoffContext | undefined;
	let skipDuplicateCheck = false;
	let dependsOn: string[] | undefined;
	let relatedTo: string[] | undefined;
	let tags: string[] | undefined;
	let ticket: TicketContent | undefined;
	let pathArg = pathParam;

	if (typeof priorityOrOptions === "number") {
		priority = priorityOrOptions;
	} else if (priorityOrOptions) {
		priority = priorityOrOptions.priority;
		handoffContext = priorityOrOptions.handoffContext;
		skipDuplicateCheck = priorityOrOptions.skipDuplicateCheck ?? false;
		dependsOn = priorityOrOptions.dependsOn;
		relatedTo = priorityOrOptions.relatedTo;
		tags = priorityOrOptions.tags;
		ticket = priorityOrOptions.ticket;
		pathArg = priorityOrOptions.path ?? pathArg;
	}

	const stateDir = getStateDirFromPath(pathArg);

	// Check for duplicate task unless skipped
	if (!skipDuplicateCheck) {
		const duplicate = findDuplicateTask(objective, stateDir);
		if (duplicate) {
			return duplicate;
		}
	}

	// Security validation: reject unsafe task objectives
	const securityValidation = validateTaskObjective(objective);
	if (!securityValidation.isSafe) {
		sessionLogger.warn(
			{
				objective: objective.slice(0, 100),
				rejectionReasons: securityValidation.rejectionReasons,
			},
			"Rejected unsafe task objective",
		);
		throw new Error(`Task objective rejected for security reasons: ${securityValidation.rejectionReasons.join(", ")}`);
	}

	// Log warnings for suspicious but allowed objectives
	if (securityValidation.warnings.length > 0) {
		sessionLogger.info(
			{
				objective: objective.slice(0, 100),
				warnings: securityValidation.warnings,
			},
			"Task objective has security warnings",
		);
	}

	// Get current task count for default priority
	const allTasks = getAllTasksDB(stateDir);

	const task: Task = {
		id: generateTaskId(),
		objective,
		status: "pending",
		priority: priority ?? allTasks.length,
		createdAt: new Date(),
		handoffContext,
		dependsOn,
		relatedTo,
		tags,
		ticket,
	};

	insertTask(taskToRecord(task), stateDir);
	return task;
}

/**
 * Add multiple tasks to the board
 * Skips duplicates automatically
 */
export function addTasks(objectives: string[], pathParam?: string): Task[] {
	const stateDir = getStateDirFromPath(pathParam);

	const results: Task[] = [];
	const allTasks = getAllTasksDB(stateDir);
	let currentCount = allTasks.length;

	for (const objective of objectives) {
		// Check for duplicate
		const duplicate = findDuplicateTask(objective, stateDir);
		if (duplicate) {
			results.push(duplicate);
			continue;
		}

		// Security validation: skip unsafe task objectives
		if (!isTaskObjectiveSafe(objective)) {
			sessionLogger.warn({ objective: objective.slice(0, 100) }, "Skipping unsafe task objective in batch add");
			continue;
		}

		const task: Task = {
			id: generateTaskId(),
			objective,
			status: "pending",
			priority: currentCount++,
			createdAt: new Date(),
		};

		insertTask(taskToRecord(task), stateDir);
		results.push(task);
	}

	return results;
}

/**
 * Update task fields (objective, priority, tags, status)
 */
export function updateTaskFields(params: UpdateTaskParams): Task | undefined;
export function updateTaskFields(
	id: string,
	updates: { objective?: string; priority?: number; tags?: string[]; status?: Task["status"] },
	path?: string,
): Task | undefined;
export function updateTaskFields(
	paramsOrId: UpdateTaskParams | string,
	updates?: { objective?: string; priority?: number; tags?: string[]; status?: Task["status"] },
	pathParam?: string,
): Task | undefined {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let objective: string | undefined;
	let priority: number | undefined;
	let tags: string[] | undefined;
	let status: Task["status"] | undefined;

	if (typeof paramsOrId === "object") {
		({ id, objective, priority, tags, status } = paramsOrId);
	} else {
		id = paramsOrId;
		objective = updates?.objective;
		priority = updates?.priority;
		tags = updates?.tags;
		status = updates?.status;
	}

	const updated = updateTaskFieldsDB(
		id,
		{ objective, priority, tags, status: status as TaskStatus | undefined },
		stateDir,
	);

	if (!updated) {
		return undefined;
	}

	const record = getTaskByIdDB(id, stateDir);
	return record ? recordToTask(record) : undefined;
}

/**
 * Get the next pending task
 */
export function getNextTask(path?: string): Task | undefined {
	const stateDir = getStateDirFromPath(path);

	// Fetch more tasks to account for dependency filtering
	// (getReadyTasksDB filters dependencies after SQL LIMIT)
	const readyTasks = getReadyTasksDB(100, stateDir);
	if (readyTasks.length === 0) {
		return undefined;
	}

	// Apply priority scoring
	const allTasks = getAllTasksDB(stateDir).map(recordToTask);
	const pendingTasks = allTasks.filter((task) => task.status === "pending" && !task.isDecomposed);

	// Filter for tasks with satisfied dependencies
	const completedIds = new Set(allTasks.filter((t) => t.status === "complete").map((t) => t.id));

	const eligibleTasks = pendingTasks.filter((task) => {
		if (!task.dependsOn || task.dependsOn.length === 0) return true;
		return task.dependsOn.every((depId) => completedIds.has(depId));
	});

	// Compute priority with more sophisticated scoring
	const scoredTasks = eligibleTasks.map((task) => {
		let score = task.priority ?? 999;

		// Boost and penalize based on various factors
		const boostTags: { [key: string]: number } = {
			critical: -50,
			bugfix: -30,
			security: -25,
			performance: -20,
			refactor: -10,
		};

		const complexityScore: { [key: string]: number } = {
			trivial: -20,
			low: -10,
			medium: 0,
			high: 10,
			critical: 20,
		};

		if (task.tags) {
			for (const tag of task.tags) {
				const tagLower = tag.toLowerCase();
				if (boostTags[tagLower]) {
					score += boostTags[tagLower];
				}
				if (complexityScore[tagLower]) {
					score += complexityScore[tagLower];
				}
			}
		}

		// Penalize old tasks
		const daysSinceCreation = (Date.now() - task.createdAt.getTime()) / (1000 * 60 * 60 * 24);
		score += Math.min(daysSinceCreation * 0.5, 30);

		// Consider dependencies
		if (task.dependsOn && task.dependsOn.length > 0) {
			score += task.dependsOn.length * 5;
		}

		return { task, score };
	});

	return scoredTasks.sort((a, b) => a.score - b.score)[0]?.task;
}

/**
 * Mark a task as in progress
 */
export function markTaskInProgress(params: MarkTaskInProgressParams): void;
export function markTaskInProgress(id: string, sessionId: string, path?: string): void;
export function markTaskInProgress(
	paramsOrId: MarkTaskInProgressParams | string,
	sessionId?: string,
	pathParam?: string,
): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualSessionId: string;

	if (typeof paramsOrId === "object") {
		({ id, sessionId: actualSessionId } = paramsOrId);
	} else {
		id = paramsOrId;
		actualSessionId = sessionId!;
	}

	updateTaskStatusDB(
		id,
		"in_progress",
		{
			startedAt: new Date().toISOString(),
			sessionId: actualSessionId,
		},
		stateDir,
	);
}

/**
 * Mark a task as complete
 */
export function markTaskComplete(params: MarkTaskCompleteParams): void;
export function markTaskComplete(id: string, path?: string): void;
export function markTaskComplete(paramsOrId: MarkTaskCompleteParams | string, pathParam?: string): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const id = typeof paramsOrId === "object" ? paramsOrId.id : paramsOrId;

	updateTaskStatusDB(
		id,
		"complete",
		{
			completedAt: new Date().toISOString(),
		},
		stateDir,
	);
}

/**
 * Mark a task as failed
 */
export function markTaskFailed(params: MarkTaskFailedParams): void;
export function markTaskFailed(id: string, error: string, path?: string): void;
export function markTaskFailed(paramsOrId: MarkTaskFailedParams | string, error?: string, pathParam?: string): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualError: string;
	let lastAttempt: LastAttemptContext | undefined;

	if (typeof paramsOrId === "object") {
		({ id, error: actualError, lastAttempt } = paramsOrId);
	} else {
		id = paramsOrId;
		actualError = error!;
	}

	updateTaskStatusDB(
		id,
		"failed",
		{
			completedAt: new Date().toISOString(),
			error: actualError,
			lastAttempt: lastAttempt
				? {
						...lastAttempt,
						attemptedAt: lastAttempt.attemptedAt.toISOString(),
					}
				: undefined,
		},
		stateDir,
	);
}

/**
 * Mark a task as duplicate (work already done)
 */
export function markTaskDuplicate(params: MarkTaskDuplicateParams): void;
export function markTaskDuplicate(id: string, commitSha: string, resolution: string, path?: string): void;
export function markTaskDuplicate(
	paramsOrId: MarkTaskDuplicateParams | string,
	commitSha?: string,
	resolution?: string,
	pathParam?: string,
): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualCommitSha: string;
	let actualResolution: string;

	if (typeof paramsOrId === "object") {
		({ id, commitSha: actualCommitSha, resolution: actualResolution } = paramsOrId);
	} else {
		id = paramsOrId;
		actualCommitSha = commitSha!;
		actualResolution = resolution!;
	}

	updateTaskStatusDB(
		id,
		"duplicate",
		{
			completedAt: new Date().toISOString(),
			duplicateOfCommit: actualCommitSha,
			resolution: actualResolution,
		},
		stateDir,
	);
}

/**
 * Mark a task as canceled (won't do)
 */
export function markTaskCanceled(params: MarkTaskCanceledParams): void;
export function markTaskCanceled(id: string, reason: string, path?: string): void;
export function markTaskCanceled(
	paramsOrId: MarkTaskCanceledParams | string,
	reason?: string,
	pathParam?: string,
): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualReason: string;

	if (typeof paramsOrId === "object") {
		({ id, reason: actualReason } = paramsOrId);
	} else {
		id = paramsOrId;
		actualReason = reason!;
	}

	updateTaskStatusDB(
		id,
		"canceled",
		{
			completedAt: new Date().toISOString(),
			resolution: actualReason,
		},
		stateDir,
	);
}

/**
 * Mark a task as obsolete (no longer needed)
 */
export function markTaskObsolete(params: MarkTaskObsoleteParams): void;
export function markTaskObsolete(id: string, reason: string, path?: string): void;
export function markTaskObsolete(
	paramsOrId: MarkTaskObsoleteParams | string,
	reason?: string,
	pathParam?: string,
): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualReason: string;

	if (typeof paramsOrId === "object") {
		({ id, reason: actualReason } = paramsOrId);
	} else {
		id = paramsOrId;
		actualReason = reason!;
	}

	updateTaskStatusDB(
		id,
		"obsolete",
		{
			completedAt: new Date().toISOString(),
			resolution: actualReason,
		},
		stateDir,
	);
}

/**
 * Mark a task as blocked (needs clarification or waiting on dependency)
 */
export interface MarkTaskBlockedParams {
	id: string;
	reason: string;
	path?: string;
}
export function markTaskBlocked(params: MarkTaskBlockedParams): void;
export function markTaskBlocked(id: string, reason: string, path?: string): void;
export function markTaskBlocked(paramsOrId: MarkTaskBlockedParams | string, reason?: string, pathParam?: string): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let id: string;
	let actualReason: string;

	if (typeof paramsOrId === "object") {
		({ id, reason: actualReason } = paramsOrId);
	} else {
		id = paramsOrId;
		actualReason = reason!;
	}

	updateTaskStatusDB(
		id,
		"blocked",
		{
			error: actualReason,
		},
		stateDir,
	);
}

/**
 * Get task board summary
 */
export function getTaskBoardSummary(pathParam?: string): {
	pending: number;
	inProgress: number;
	complete: number;
	failed: number;
	blocked: number;
	duplicate: number;
	canceled: number;
	obsolete: number;
} {
	const stateDir = getStateDirFromPath(pathParam);

	const summary = getTaskBoardSummaryDB(stateDir);
	return {
		pending: summary.pending,
		inProgress: summary.in_progress,
		complete: summary.complete,
		failed: summary.failed,
		blocked: summary.blocked,
		duplicate: summary.duplicate,
		canceled: summary.canceled,
		obsolete: summary.obsolete,
	};
}

/**
 * Block a task (prevent it from being picked up)
 */
export function blockTask(params: BlockTaskParams): void;
export function blockTask(id: string, path?: string): void;
export function blockTask(paramsOrId: BlockTaskParams | string, pathParam?: string): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const id = typeof paramsOrId === "object" ? paramsOrId.id : paramsOrId;
	const task = getTaskByIdDB(id, stateDir);

	if (task && task.status === "pending") {
		updateTaskStatusDB(id, "blocked", {}, stateDir);
	}
}

/**
 * Unblock a task (allow it to be picked up again)
 */
export function unblockTask(params: BlockTaskParams): void;
export function unblockTask(id: string, path?: string): void;
export function unblockTask(paramsOrId: BlockTaskParams | string, pathParam?: string): void {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const id = typeof paramsOrId === "object" ? paramsOrId.id : paramsOrId;
	const task = getTaskByIdDB(id, stateDir);

	if (task && task.status === "blocked") {
		updateTaskStatusDB(id, "pending", {}, stateDir);
	}
}

/**
 * Clear completed tasks from the board
 */
export function clearCompletedTasks(params: ClearCompletedTasksParams): number;
export function clearCompletedTasks(path?: string): number;
export function clearCompletedTasks(paramsOrPath?: ClearCompletedTasksParams | string): number {
	const pathArg = typeof paramsOrPath === "object" ? paramsOrPath.path : paramsOrPath;
	const stateDir = getStateDirFromPath(pathArg);
	return clearCompletedTasksDB(stateDir);
}

/**
 * Remove a task by ID (permanent deletion)
 */
export function removeTask(params: RemoveTaskParams): boolean;
export function removeTask(id: string, path?: string): boolean;
export function removeTask(paramsOrId: RemoveTaskParams | string, pathParam?: string): boolean {
	const pathArg = typeof paramsOrId === "object" ? paramsOrId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const id = typeof paramsOrId === "object" ? paramsOrId.id : paramsOrId;
	return removeTaskDB(id, stateDir);
}

/**
 * Remove multiple tasks by ID (permanent deletion)
 */
export function removeTasks(params: RemoveTasksParams): number;
export function removeTasks(ids: string[], path?: string): number;
export function removeTasks(paramsOrIds: RemoveTasksParams | string[], pathParam?: string): number {
	const pathArg = Array.isArray(paramsOrIds) ? pathParam : paramsOrIds.path;
	const stateDir = getStateDirFromPath(pathArg);

	const ids = Array.isArray(paramsOrIds) ? paramsOrIds : paramsOrIds.ids;
	return removeTasksDB(ids, stateDir);
}

/**
 * Get all tasks
 */
export function getAllTasks(pathParam?: string): Task[] {
	const stateDir = getStateDirFromPath(pathParam);
	return getAllTasksDB(stateDir).map(recordToTask);
}

/**
 * Get ready tasks for parallel execution
 * Returns pending tasks sorted by priority, limited to the specified count
 */
export function getReadyTasksForBatch(params: GetReadyTasksParams): Task[];
export function getReadyTasksForBatch(count?: number): Task[];
export function getReadyTasksForBatch(paramsOrCount?: GetReadyTasksParams | number, pathParam?: string): Task[] {
	const pathArg = typeof paramsOrCount === "object" ? paramsOrCount.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const count = typeof paramsOrCount === "object" ? (paramsOrCount.count ?? 3) : (paramsOrCount ?? 3);
	return getReadyTasksDB(count, stateDir).map(recordToTask);
}

/**
 * Mark multiple tasks as in progress
 */
export function markTaskSetInProgress(params: MarkTaskSetInProgressParams): void;
export function markTaskSetInProgress(taskIds: string[], sessionIds: string[], path?: string): void;
export function markTaskSetInProgress(
	paramsOrTaskIds: MarkTaskSetInProgressParams | string[],
	sessionIds?: string[],
	pathParam?: string,
): void {
	const pathArg = Array.isArray(paramsOrTaskIds) ? pathParam : paramsOrTaskIds.path;
	const stateDir = getStateDirFromPath(pathArg);

	let taskIds: string[];
	let actualSessionIds: string[];

	if (Array.isArray(paramsOrTaskIds)) {
		taskIds = paramsOrTaskIds;
		actualSessionIds = sessionIds!;
	} else {
		({ taskIds, sessionIds: actualSessionIds } = paramsOrTaskIds);
	}

	for (let i = 0; i < taskIds.length; i++) {
		const taskId = taskIds[i];
		const sessionId = actualSessionIds[i];
		updateTaskStatusDB(
			taskId,
			"in_progress",
			{
				startedAt: new Date().toISOString(),
				sessionId,
			},
			stateDir,
		);
	}
}

/**
 * Get status of a set of tasks
 */
export function getTaskSetStatus(
	taskIds: string[],
	pathParam?: string,
): {
	pending: number;
	inProgress: number;
	complete: number;
	failed: number;
	blocked: number;
} {
	const stateDir = getStateDirFromPath(pathParam);

	const idSet = new Set(taskIds);
	const tasks = getAllTasksDB(stateDir).filter((t) => idSet.has(t.id));

	return {
		pending: tasks.filter((t) => t.status === "pending").length,
		inProgress: tasks.filter((t) => t.status === "in_progress").length,
		complete: tasks.filter((t) => t.status === "complete").length,
		failed: tasks.filter((t) => t.status === "failed").length,
		blocked: 0,
	};
}

/**
 * Get task board analytics for optimization insights
 */
export function getTaskBoardAnalytics(pathParam?: string): {
	totalTasks: number;
	averageCompletionTime: number;
	parallelizationOpportunities: number;
	topConflictingPackages: string[];
} {
	const stateDir = getStateDirFromPath(pathParam);

	const allTasks = getAllTasksDB(stateDir).map(recordToTask);
	const completedTasks = allTasks.filter((t) => t.status === "complete");

	// Calculate average completion time
	let totalTime = 0;
	let validTimes = 0;
	for (const task of completedTasks) {
		if (task.startedAt && task.completedAt) {
			const duration = task.completedAt.getTime() - task.startedAt.getTime();
			totalTime += duration;
			validTimes++;
		}
	}
	const averageCompletionTime = validTimes > 0 ? totalTime / validTimes : 0;

	// Count pending tasks as parallelization opportunities
	const pendingTasks = allTasks.filter((t) => t.status === "pending").length;

	// Get top conflicting packages (simplified - just count by computed packages)
	const packageCounts: Record<string, number> = {};
	for (const task of allTasks) {
		if (task.computedPackages) {
			for (const pkg of task.computedPackages) {
				packageCounts[pkg] = (packageCounts[pkg] || 0) + 1;
			}
		}
	}
	const topConflictingPackages = Object.entries(packageCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([pkg]) => pkg);

	return {
		totalTasks: allTasks.length,
		averageCompletionTime,
		parallelizationOpportunities: pendingTasks,
		topConflictingPackages,
	};
}

/**
 * Update task with computed analysis results
 */
export function updateTaskAnalysis(params: UpdateTaskAnalysisParams): void;
export function updateTaskAnalysis(
	taskId: string,
	analysis: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	},
	path?: string,
): void;
export function updateTaskAnalysis(
	paramsOrTaskId: UpdateTaskAnalysisParams | string,
	analysis?: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	},
	pathParam?: string,
): void {
	const pathArg = typeof paramsOrTaskId === "object" ? paramsOrTaskId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let taskId: string;
	let actualAnalysis: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	};

	if (typeof paramsOrTaskId === "object") {
		({ taskId, analysis: actualAnalysis } = paramsOrTaskId);
	} else {
		taskId = paramsOrTaskId;
		actualAnalysis = analysis!;
	}

	updateTaskAnalysisDB(taskId, actualAnalysis, stateDir);
}

/**
 * Decompose a task into subtasks
 */
export function decomposeTaskIntoSubtasks(params: DecomposeTaskParams): string[];
export function decomposeTaskIntoSubtasks(
	parentTaskId: string,
	subtasks: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>,
	path?: string,
): string[];
export function decomposeTaskIntoSubtasks(
	paramsOrParentTaskId: DecomposeTaskParams | string,
	subtasks?: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>,
	pathParam?: string,
): string[] {
	const pathArg = typeof paramsOrParentTaskId === "object" ? paramsOrParentTaskId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let parentTaskId: string;
	let actualSubtasks: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>;

	if (typeof paramsOrParentTaskId === "object") {
		({ parentTaskId, subtasks: actualSubtasks } = paramsOrParentTaskId);
	} else {
		parentTaskId = paramsOrParentTaskId;
		actualSubtasks = subtasks!;
	}

	const parentTask = getTaskByIdDB(parentTaskId, stateDir);
	if (!parentTask) {
		throw new Error(`Parent task not found: ${parentTaskId}`);
	}

	const basePriority = parentTask.priority ?? 999;
	const subtaskDepth = (parentTask.decompositionDepth ?? 0) + 1;
	const subtaskIds: string[] = [];

	// Create subtasks
	for (const subtask of actualSubtasks) {
		const subtaskId = generateTaskId();
		const newTask: TaskRecord = {
			id: subtaskId,
			objective: subtask.objective,
			status: "pending",
			priority: basePriority + subtask.order * 0.1,
			createdAt: new Date().toISOString(),
			parentId: parentTaskId,
			decompositionDepth: subtaskDepth,
			estimatedFiles: subtask.estimatedFiles,
			tags: parentTask.tags,
			packageHints: parentTask.packageHints,
		};
		insertTask(newTask, stateDir);
		subtaskIds.push(subtaskId);
	}

	// Mark parent as decomposed
	markTaskDecomposedDB(parentTaskId, subtaskIds, stateDir);

	return subtaskIds;
}

/**
 * Check if all subtasks of a parent are complete
 */
export function areAllSubtasksComplete(params: SubtaskCheckParams): boolean;
export function areAllSubtasksComplete(parentTaskId: string, path?: string): boolean;
export function areAllSubtasksComplete(paramsOrParentTaskId: SubtaskCheckParams | string, pathParam?: string): boolean {
	const pathArg = typeof paramsOrParentTaskId === "object" ? paramsOrParentTaskId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const parentTaskId =
		typeof paramsOrParentTaskId === "object" ? paramsOrParentTaskId.parentTaskId : paramsOrParentTaskId;
	const parentTask = getTaskByIdDB(parentTaskId, stateDir);

	if (!parentTask || !parentTask.subtaskIds || parentTask.subtaskIds.length === 0) {
		return false;
	}

	return parentTask.subtaskIds.every((subtaskId) => {
		const subtask = getTaskByIdDB(subtaskId, stateDir);
		return subtask?.status === "complete";
	});
}

/**
 * Mark a decomposed parent task as complete if all subtasks are done
 */
export function completeParentIfAllSubtasksDone(params: SubtaskCheckParams): boolean;
export function completeParentIfAllSubtasksDone(parentTaskId: string, path?: string): boolean;
export function completeParentIfAllSubtasksDone(
	paramsOrParentTaskId: SubtaskCheckParams | string,
	pathParam?: string,
): boolean {
	const pathArg = typeof paramsOrParentTaskId === "object" ? paramsOrParentTaskId.path : pathParam;
	const parentTaskId =
		typeof paramsOrParentTaskId === "object" ? paramsOrParentTaskId.parentTaskId : paramsOrParentTaskId;

	if (areAllSubtasksComplete(parentTaskId, pathArg)) {
		markTaskComplete(parentTaskId, pathArg);
		return true;
	}
	return false;
}

/**
 * Get task by ID
 */
export function getTaskById(params: GetTaskByIdParams): Task | undefined;
export function getTaskById(taskId: string, path?: string): Task | undefined;
export function getTaskById(paramsOrTaskId: GetTaskByIdParams | string, pathParam?: string): Task | undefined {
	const pathArg = typeof paramsOrTaskId === "object" ? paramsOrTaskId.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	const taskId = typeof paramsOrTaskId === "object" ? paramsOrTaskId.taskId : paramsOrTaskId;
	const record = getTaskByIdDB(taskId, stateDir);
	return record ? recordToTask(record) : undefined;
}

/**
 * Check if a task is too similar to any in-progress tasks
 */
export function findSimilarInProgressTask(params: FindSimilarTaskParams): { task: Task; similarity: number } | null;
export function findSimilarInProgressTask(
	objective: string,
	threshold?: number,
	path?: string,
): { task: Task; similarity: number } | null;
export function findSimilarInProgressTask(
	paramsOrObjective: FindSimilarTaskParams | string,
	threshold?: number,
	pathParam?: string,
): { task: Task; similarity: number } | null {
	const pathArg = typeof paramsOrObjective === "object" ? paramsOrObjective.path : pathParam;
	const stateDir = getStateDirFromPath(pathArg);

	let objective: string;
	let actualThreshold: number;

	if (typeof paramsOrObjective === "object") {
		({ objective, threshold: actualThreshold = 0.7 } = paramsOrObjective);
	} else {
		objective = paramsOrObjective;
		actualThreshold = threshold ?? 0.7;
	}

	const inProgress = getTasksByStatusDB("in_progress", stateDir).map(recordToTask);

	if (inProgress.length === 0) {
		return null;
	}

	const stopWords = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"through",
		"and",
		"or",
		"but",
		"if",
		"then",
		"than",
		"so",
		"that",
		"this",
		"these",
		"those",
		"it",
		"its",
	]);

	const extractKeywords = (text: string): Set<string> => {
		return new Set(
			text
				.toLowerCase()
				.replace(/[[\](){}:,."'`]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length > 2 && !stopWords.has(w)),
		);
	};

	const targetKeywords = extractKeywords(objective);
	if (targetKeywords.size === 0) {
		return null;
	}

	for (const task of inProgress) {
		const taskKeywords = extractKeywords(task.objective);

		const intersection = [...targetKeywords].filter((k) => taskKeywords.has(k)).length;
		const union = new Set([...targetKeywords, ...taskKeywords]).size;
		const similarity = union > 0 ? intersection / union : 0;

		if (similarity >= actualThreshold) {
			return { task, similarity };
		}
	}

	return null;
}

/**
 * Reconcile tasks with git history to detect duplicates
 */
export async function reconcileTasks(options: { lookbackCommits?: number; dryRun?: boolean; path?: string }): Promise<{
	duplicatesFound: number;
	tasksMarked: Array<{ taskId: string; commitSha: string; message: string; confidence: string }>;
}> {
	const { lookbackCommits = 100, dryRun = false, path: pathArg } = options;
	const stateDir = getStateDirFromPath(pathArg);

	const { execSync } = await import("node:child_process");

	// Get recent commits with stats
	const commits = execSync(`git log --oneline --stat -${lookbackCommits}`, { encoding: "utf-8" })
		.trim()
		.split("\n\n")
		.map((block) => {
			const lines = block.trim().split("\n");
			const [sha, ...messageParts] = lines[0].split(" ");
			const message = messageParts.join(" ");

			const files = lines
				.slice(1, -1)
				.map((line) => line.trim().split("|")[0]?.trim())
				.filter(Boolean);

			return { sha, message, files };
		});

	const allTasks = getAllTasksDB(stateDir).map(recordToTask);
	const tasksToReconcile = allTasks.filter(
		(t) => t.status === "pending" || t.status === "failed" || t.status === "in_progress",
	);

	const tasksMarked: Array<{ taskId: string; commitSha: string; message: string; confidence: string }> = [];

	for (const task of tasksToReconcile) {
		const keywords = task.objective
			.toLowerCase()
			.replace(/[[\]]/g, "")
			.split(/\s+/)
			.filter((word) => word.length > 3 && !["task", "this", "that", "with", "from", "should"].includes(word));

		const fileHints = task.objective.match(/[\w-]+\/[\w.-]+\.[\w]+/g) || [];

		for (const commit of commits) {
			const commitLower = commit.message.toLowerCase();
			const keywordMatches = keywords.filter((keyword) => commitLower.includes(keyword)).length;
			const keywordScore = keywordMatches / Math.max(keywords.length, 1);

			const fileMatches = fileHints.filter((hint) => commit.files.some((file) => file.includes(hint))).length;
			const fileScore = fileHints.length > 0 ? fileMatches / fileHints.length : 0;

			const confidence = fileHints.length > 0 ? keywordScore * 0.6 + fileScore * 0.4 : keywordScore;

			if (confidence > 0.7 && keywordMatches >= 2) {
				const confidenceLabel = confidence > 0.9 ? "high" : confidence > 0.8 ? "medium" : "low";

				tasksMarked.push({
					taskId: task.id,
					commitSha: commit.sha,
					message: commit.message,
					confidence: confidenceLabel,
				});

				if (!dryRun) {
					markTaskDuplicate({
						id: task.id,
						commitSha: commit.sha,
						resolution: `Auto-detected (${confidenceLabel} confidence): work completed in commit ${commit.sha}`,
					});
				}
				break;
			}
		}
	}

	return {
		duplicatesFound: tasksMarked.length,
		tasksMarked,
	};
}
