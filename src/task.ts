/**
 * Task Board Module
 *
 * Task queue management for undercity with file-based persistence.
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
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const LOCK_TIMEOUT_MS = 30000; // 30 seconds - lock considered stale after this
const LOCK_RETRY_DELAY_MS = 50; // Initial retry delay
const LOCK_MAX_RETRIES = 100; // Max retries (with backoff, ~10 seconds total)

interface LockInfo {
	pid: number;
	timestamp: number;
}

/**
 * Check if a lock file is stale (process dead or timeout exceeded)
 */
function isLockStale(lockPath: string): boolean {
	try {
		const content = readFileSync(lockPath, "utf-8");
		const lockInfo: LockInfo = JSON.parse(content);

		// Check if lock has timed out
		if (Date.now() - lockInfo.timestamp > LOCK_TIMEOUT_MS) {
			return true;
		}

		// Check if process is still alive (Unix-specific, but safe fallback)
		try {
			process.kill(lockInfo.pid, 0); // Signal 0 = check if process exists
			return false; // Process is alive
		} catch {
			return true; // Process is dead
		}
	} catch {
		return true; // Can't read lock = stale
	}
}

/**
 * Acquire a file lock with retry and exponential backoff
 */
function acquireLock(lockPath: string): boolean {
	const lockInfo: LockInfo = {
		pid: process.pid,
		timestamp: Date.now(),
	};

	for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
		try {
			// Try to create lock file exclusively (fails if exists)
			const fd = openSync(lockPath, "wx");
			writeFileSync(fd, JSON.stringify(lockInfo));
			closeSync(fd);
			return true;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				// Lock exists - check if stale
				if (isLockStale(lockPath)) {
					try {
						unlinkSync(lockPath);
						continue; // Try again immediately
					} catch {
						// Someone else cleaned it up, try again
					}
				}

				// Wait with exponential backoff (capped at 500ms)
				const delay = Math.min(LOCK_RETRY_DELAY_MS * 1.5 ** attempt, 500);
				const start = Date.now();
				while (Date.now() - start < delay) {
					// Busy wait (synchronous delay)
				}
			} else {
				throw err; // Unexpected error
			}
		}
	}

	return false; // Failed to acquire lock
}

/**
 * Release a file lock
 */
function releaseLock(lockPath: string): void {
	try {
		// Verify we own the lock before releasing
		const content = readFileSync(lockPath, "utf-8");
		const lockInfo: LockInfo = JSON.parse(content);
		if (lockInfo.pid === process.pid) {
			unlinkSync(lockPath);
		}
	} catch {
		// Lock already gone or not ours - that's fine
	}
}

/**
 * Execute a function while holding a file lock
 */
function withLock<T>(lockPath: string, fn: () => T): T {
	if (!acquireLock(lockPath)) {
		throw new Error(`Failed to acquire lock on ${lockPath} after ${LOCK_MAX_RETRIES} attempts`);
	}
	try {
		return fn();
	} finally {
		releaseLock(lockPath);
	}
}

export interface Task {
	id: string;
	objective: string;
	status:
		| "pending"
		| "in_progress"
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
	dependsOn?: string[]; // Task IDs this task depends on
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

	// Handoff context from Claude Code session
	handoffContext?: HandoffContext;
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
}

export interface TaskBoard {
	tasks: Task[];
	lastUpdated: Date;
}

const DEFAULT_TASK_BOARD_PATH = ".undercity/tasks.json";

/**
 * Get the lock file path for a task board file
 */
function getLockPath(taskBoardPath: string): string {
	return `${taskBoardPath}.lock`;
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
 * Load task board from disk
 */
export function loadTaskBoard(path: string = DEFAULT_TASK_BOARD_PATH): TaskBoard {
	if (!existsSync(path)) {
		return { tasks: [], lastUpdated: new Date() };
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as TaskBoard;
	} catch {
		return { tasks: [], lastUpdated: new Date() };
	}
}

/**
 * Save task board to disk
 */
export function saveTaskBoard(board: TaskBoard, path: string = DEFAULT_TASK_BOARD_PATH): void {
	board.lastUpdated = new Date();
	const tempPath = `${path}.tmp`;

	try {
		// Write to temporary file first
		writeFileSync(tempPath, JSON.stringify(board, null, 2), {
			encoding: "utf-8",
			flag: "w",
		});

		// Atomically rename temporary file to target file
		// This ensures the file is never in a partially written state
		renameSync(tempPath, path);
	} catch (error) {
		// Clean up temporary file if it exists
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		throw error;
	}
}

/**
 * Options for adding a task
 */
export interface AddTaskOptions {
	priority?: number;
	handoffContext?: HandoffContext;
	path?: string;
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
 * Add a task to the board
 */
export function addTask(
	objective: string,
	priorityOrOptions?: number | AddTaskOptions,
	path: string = DEFAULT_TASK_BOARD_PATH,
): Task {
	// Support both old signature (priority, path) and new signature (options)
	let priority: number | undefined;
	let handoffContext: HandoffContext | undefined;
	let taskPath = path;

	if (typeof priorityOrOptions === "number") {
		priority = priorityOrOptions;
	} else if (priorityOrOptions) {
		priority = priorityOrOptions.priority;
		handoffContext = priorityOrOptions.handoffContext;
		taskPath = priorityOrOptions.path ?? path;
	}

	return withLock(getLockPath(taskPath), () => {
		const board = loadTaskBoard(taskPath);
		const task: Task = {
			id: generateTaskId(),
			objective,
			status: "pending",
			priority: priority ?? board.tasks.length,
			createdAt: new Date(),
			handoffContext,
		};
		board.tasks.push(task);
		saveTaskBoard(board, taskPath);
		return task;
	});
}

/**
 * Add multiple tasks to the board
 */
export function addTasks(objectives: string[], path: string = DEFAULT_TASK_BOARD_PATH): Task[] {
	return withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const tasks: Task[] = objectives.map((objective, i) => ({
			id: generateTaskId(),
			objective,
			status: "pending" as const,
			priority: board.tasks.length + i,
			createdAt: new Date(),
		}));
		board.tasks.push(...tasks);
		saveTaskBoard(board, path);
		return tasks;
	});
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
	path?: string,
): Task | undefined {
	let id: string;
	let objective: string | undefined;
	let priority: number | undefined;
	let tags: string[] | undefined;
	let status: Task["status"] | undefined;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, objective, priority, tags, status, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		objective = updates?.objective;
		priority = updates?.priority;
		tags = updates?.tags;
		status = updates?.status;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	return withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const task = board.tasks.find((t) => t.id === id);

		if (!task) {
			return undefined;
		}

		if (objective !== undefined) {
			task.objective = objective;
		}
		if (priority !== undefined) {
			task.priority = priority;
		}
		if (tags !== undefined) {
			task.tags = tags;
		}
		if (status !== undefined) {
			task.status = status;
			if (status === "complete" || status === "failed" || status === "canceled" || status === "obsolete") {
				task.completedAt = new Date();
			}
		}

		saveTaskBoard(board, actualPath);
		return task;
	});
}

/**
 * Get the next pending task
 */
export function getNextTask(): Task | undefined {
	const board = loadTaskBoard();
	const pendingTasks = board.tasks.filter(
		(task) =>
			task.status === "pending" &&
			!task.isDecomposed && // Skip decomposed tasks - execute subtasks instead
			(!task.dependsOn ||
				task.dependsOn.every((depId) => board.tasks.find((q) => q.id === depId && q.status === "complete"))),
	);

	// Compute priority with more sophisticated scoring
	const scoredTasks = pendingTasks.map((task) => {
		let score = task.priority ?? 999;

		// Boost and penalize based on various factors
		const boostTags: { [key: string]: number } = {
			critical: -50, // Highest priority
			bugfix: -30,
			security: -25,
			performance: -20,
			refactor: -10,
		};

		// Complexity-based scoring
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
				// Boost/penalize based on tags
				if (boostTags[tagLower]) {
					score += boostTags[tagLower];
				}
				// Boost/penalize based on complexity
				if (complexityScore[tagLower]) {
					score += complexityScore[tagLower];
				}
			}
		}

		// Penalize old tasks
		const daysSinceCreation = (Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24);
		score += Math.min(daysSinceCreation * 0.5, 30);

		// Consider dependencies
		if (task.dependsOn && task.dependsOn.length > 0) {
			score += task.dependsOn.length * 5; // Slight penalty for more dependencies
		}

		return { task, score };
	});

	return scoredTasks.sort((a, b) => a.score - b.score)[0]?.task;
}

/**
 * Helper function to update a task with proper locking
 */
function updateTask(id: string, updates: (task: Task) => void, path: string = DEFAULT_TASK_BOARD_PATH): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task = board.tasks.find((q) => q.id === id);
		if (task) {
			updates(task);
			saveTaskBoard(board, path);
		}
	});
}

/**
 * Mark a task as in progress
 */
export function markTaskInProgress(params: MarkTaskInProgressParams): void;
export function markTaskInProgress(id: string, sessionId: string, path?: string): void;
export function markTaskInProgress(
	paramsOrId: MarkTaskInProgressParams | string,
	sessionId?: string,
	path?: string,
): void {
	let id: string;
	let actualSessionId: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, sessionId: actualSessionId, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualSessionId = sessionId!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "in_progress";
			task.startedAt = new Date();
			task.sessionId = actualSessionId;
		},
		actualPath,
	);
}

/**
 * Mark a task as complete
 */
export function markTaskComplete(params: MarkTaskCompleteParams): void;
export function markTaskComplete(id: string, path?: string): void;
export function markTaskComplete(paramsOrId: MarkTaskCompleteParams | string, path?: string): void {
	let id: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "complete";
			task.completedAt = new Date();
		},
		actualPath,
	);
}

/**
 * Mark a task as failed
 */
export function markTaskFailed(params: MarkTaskFailedParams): void;
export function markTaskFailed(id: string, error: string, path?: string): void;
export function markTaskFailed(paramsOrId: MarkTaskFailedParams | string, error?: string, path?: string): void {
	let id: string;
	let actualError: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, error: actualError, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualError = error!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "failed";
			task.completedAt = new Date();
			task.error = actualError;
		},
		actualPath,
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
	path?: string,
): void {
	let id: string;
	let actualCommitSha: string;
	let actualResolution: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({
			id,
			commitSha: actualCommitSha,
			resolution: actualResolution,
			path: actualPath = DEFAULT_TASK_BOARD_PATH,
		} = paramsOrId);
	} else {
		id = paramsOrId;
		actualCommitSha = commitSha!;
		actualResolution = resolution!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "duplicate";
			task.completedAt = new Date();
			task.duplicateOfCommit = actualCommitSha;
			task.resolution = actualResolution;
			delete task.error; // Clear any error since this isn't a failure
		},
		actualPath,
	);
}

/**
 * Mark a task as canceled (won't do)
 */
export function markTaskCanceled(params: MarkTaskCanceledParams): void;
export function markTaskCanceled(id: string, reason: string, path?: string): void;
export function markTaskCanceled(paramsOrId: MarkTaskCanceledParams | string, reason?: string, path?: string): void {
	let id: string;
	let actualReason: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, reason: actualReason, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualReason = reason!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "canceled";
			task.completedAt = new Date();
			task.resolution = actualReason;
			delete task.error;
		},
		actualPath,
	);
}

/**
 * Mark a task as obsolete (no longer needed)
 */
export function markTaskObsolete(params: MarkTaskObsoleteParams): void;
export function markTaskObsolete(id: string, reason: string, path?: string): void;
export function markTaskObsolete(paramsOrId: MarkTaskObsoleteParams | string, reason?: string, path?: string): void {
	let id: string;
	let actualReason: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, reason: actualReason, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualReason = reason!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			task.status = "obsolete";
			task.completedAt = new Date();
			task.resolution = actualReason;
			delete task.error;
		},
		actualPath,
	);
}

/**
 * Get task board summary
 */
export function getTaskBoardSummary(): {
	pending: number;
	inProgress: number;
	complete: number;
	failed: number;
	blocked: number;
	duplicate: number;
	canceled: number;
	obsolete: number;
} {
	const board = loadTaskBoard();
	return {
		pending: board.tasks.filter((q) => q.status === "pending").length,
		inProgress: board.tasks.filter((q) => q.status === "in_progress").length,
		complete: board.tasks.filter((q) => q.status === "complete").length,
		failed: board.tasks.filter((q) => q.status === "failed").length,
		blocked: board.tasks.filter((q) => q.status === "blocked").length,
		duplicate: board.tasks.filter((q) => q.status === "duplicate").length,
		canceled: board.tasks.filter((q) => q.status === "canceled").length,
		obsolete: board.tasks.filter((q) => q.status === "obsolete").length,
	};
}

/**
 * Block a task (prevent it from being picked up)
 */
export function blockTask(params: BlockTaskParams): void;
export function blockTask(id: string, path?: string): void;
export function blockTask(paramsOrId: BlockTaskParams | string, path?: string): void {
	let id: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			if (task.status === "pending") {
				task.status = "blocked";
			}
		},
		actualPath,
	);
}

/**
 * Unblock a task (allow it to be picked up again)
 */
export function unblockTask(params: BlockTaskParams): void;
export function unblockTask(id: string, path?: string): void;
export function unblockTask(paramsOrId: BlockTaskParams | string, path?: string): void {
	let id: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	updateTask(
		id,
		(task) => {
			if (task.status === "blocked") {
				task.status = "pending";
			}
		},
		actualPath,
	);
}

/**
 * Clear completed tasks from the board
 */
export function clearCompletedTasks(params: ClearCompletedTasksParams): number;
export function clearCompletedTasks(path?: string): number;
export function clearCompletedTasks(paramsOrPath?: ClearCompletedTasksParams | string): number {
	let actualPath: string;

	if (typeof paramsOrPath === "object") {
		actualPath = paramsOrPath.path ?? DEFAULT_TASK_BOARD_PATH;
	} else {
		actualPath = paramsOrPath ?? DEFAULT_TASK_BOARD_PATH;
	}

	return withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const before = board.tasks.length;
		board.tasks = board.tasks.filter((q) => q.status !== "complete");
		saveTaskBoard(board, actualPath);
		return before - board.tasks.length;
	});
}

/**
 * Remove a task by ID (permanent deletion)
 */
export function removeTask(params: RemoveTaskParams): boolean;
export function removeTask(id: string, path?: string): boolean;
export function removeTask(paramsOrId: RemoveTaskParams | string, path?: string): boolean {
	let id: string;
	let actualPath: string;

	if (typeof paramsOrId === "object") {
		({ id, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrId);
	} else {
		id = paramsOrId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	return withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const before = board.tasks.length;
		board.tasks = board.tasks.filter((t) => t.id !== id);
		if (board.tasks.length < before) {
			saveTaskBoard(board, actualPath);
			return true;
		}
		return false;
	});
}

/**
 * Remove multiple tasks by ID (permanent deletion)
 */
export function removeTasks(params: RemoveTasksParams): number;
export function removeTasks(ids: string[], path?: string): number;
export function removeTasks(paramsOrIds: RemoveTasksParams | string[], path?: string): number {
	let ids: string[];
	let actualPath: string;

	if (Array.isArray(paramsOrIds)) {
		ids = paramsOrIds;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	} else {
		({ ids, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrIds);
	}

	return withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const before = board.tasks.length;
		const idSet = new Set(ids);
		board.tasks = board.tasks.filter((t) => !idSet.has(t.id));
		const removed = before - board.tasks.length;
		if (removed > 0) {
			saveTaskBoard(board, actualPath);
		}
		return removed;
	});
}

/**
 * Get all tasks
 */
export function getAllTasks(): Task[] {
	return loadTaskBoard().tasks;
}

/**
 * Get ready tasks for parallel execution
 * Returns pending tasks sorted by priority, limited to the specified count
 */
export function getReadyTasksForBatch(params: GetReadyTasksParams): Task[];
export function getReadyTasksForBatch(count?: number): Task[];
export function getReadyTasksForBatch(paramsOrCount?: GetReadyTasksParams | number): Task[] {
	let count: number;
	let actualPath: string;

	if (typeof paramsOrCount === "object") {
		count = paramsOrCount.count ?? 3;
		actualPath = paramsOrCount.path ?? DEFAULT_TASK_BOARD_PATH;
	} else {
		count = paramsOrCount ?? 3;
		actualPath = DEFAULT_TASK_BOARD_PATH;
	}

	const board = loadTaskBoard(actualPath);
	const pendingTasks = board.tasks.filter(
		(task) =>
			task.status === "pending" &&
			!task.isDecomposed && // Skip decomposed tasks - execute subtasks instead
			(!task.dependsOn ||
				task.dependsOn.every((depId) => board.tasks.find((t) => t.id === depId && t.status === "complete"))),
	);

	// Compute priority with more sophisticated scoring
	const scoredTasks = pendingTasks.map((task) => {
		let score = task.priority ?? 999;

		// Boost priority based on tags
		const boostTags: { [key: string]: number } = {
			critical: -50, // Highest priority
			bugfix: -30,
			security: -25,
			performance: -20,
			refactor: -10,
		};

		if (task.tags) {
			for (const tag of task.tags) {
				if (boostTags[tag.toLowerCase()]) {
					score += boostTags[tag.toLowerCase()];
				}
			}
		}

		// Penalize old tasks
		const daysSinceCreation = (Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24);
		score += Math.min(daysSinceCreation * 0.5, 30);

		return { task, score };
	});

	// Sort by score
	const sortedTasks = scoredTasks.sort((a, b) => a.score - b.score);

	// Select compatible tasks with minimal file/package overlap
	const selectedTasks: Task[] = [];
	const usedPackages = new Set<string>();
	const usedFiles = new Set<string>();

	for (const { task } of sortedTasks) {
		if (selectedTasks.length >= count) break;

		// Check package and file conflicts
		const taskPackages = task.computedPackages ?? task.packageHints ?? [];
		const taskFiles = task.estimatedFiles ?? [];

		const hasConflict =
			taskPackages.some((pkg) => usedPackages.has(pkg)) || taskFiles.some((file) => usedFiles.has(file));

		if (!hasConflict) {
			selectedTasks.push(task);

			// Mark packages and files as used
			for (const pkg of taskPackages) usedPackages.add(pkg);
			for (const file of taskFiles) usedFiles.add(file);
		}
	}

	return selectedTasks;
}

/**
 * Mark multiple tasks as in progress
 */
export function markTaskSetInProgress(params: MarkTaskSetInProgressParams): void;
export function markTaskSetInProgress(taskIds: string[], sessionIds: string[], path?: string): void;
export function markTaskSetInProgress(
	paramsOrTaskIds: MarkTaskSetInProgressParams | string[],
	sessionIds?: string[],
	path?: string,
): void {
	let taskIds: string[];
	let actualSessionIds: string[];
	let actualPath: string;

	if (Array.isArray(paramsOrTaskIds)) {
		taskIds = paramsOrTaskIds;
		actualSessionIds = sessionIds!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	} else {
		({ taskIds, sessionIds: actualSessionIds, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrTaskIds);
	}

	withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		for (let i = 0; i < taskIds.length; i++) {
			const taskId = taskIds[i];
			const sessionId = actualSessionIds[i];
			const task = board.tasks.find((q) => q.id === taskId);
			if (task) {
				task.status = "in_progress";
				task.startedAt = new Date();
				task.sessionId = sessionId;
			}
		}
		saveTaskBoard(board, actualPath);
	});
}

/**
 * Get status of a set of tasks
 */
export function getTaskSetStatus(taskIds: string[]): {
	pending: number;
	inProgress: number;
	complete: number;
	failed: number;
	blocked: number;
} {
	const board = loadTaskBoard();
	const tasks = board.tasks.filter((q) => taskIds.includes(q.id));

	return {
		pending: tasks.filter((q) => q.status === "pending").length,
		inProgress: tasks.filter((q) => q.status === "in_progress").length,
		complete: tasks.filter((q) => q.status === "complete").length,
		failed: tasks.filter((q) => q.status === "failed").length,
		blocked: 0, // Will be computed by dependency analysis
	};
}

/**
 * Get task board analytics for optimization insights
 */
export function getTaskBoardAnalytics(): {
	totalTasks: number;
	averageCompletionTime: number;
	parallelizationOpportunities: number;
	topConflictingPackages: string[];
} {
	const board = loadTaskBoard();
	const completedTasks = board.tasks.filter((q) => q.status === "complete");

	// Calculate average completion time
	let totalTime = 0;
	let validTimes = 0;
	for (const task of completedTasks) {
		if (task.startedAt && task.completedAt) {
			const duration = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
			totalTime += duration;
			validTimes++;
		}
	}
	const averageCompletionTime = validTimes > 0 ? totalTime / validTimes : 0;

	// Count pending tasks as parallelization opportunities
	const pendingTasks = board.tasks.filter((q) => q.status === "pending").length;

	// Collect package hints for conflict analysis
	const packageCounts = new Map<string, number>();
	for (const task of board.tasks) {
		const packages = task.computedPackages || task.packageHints || [];
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
		totalTasks: board.tasks.length,
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
	path?: string,
): void {
	let taskId: string;
	let actualAnalysis: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	};
	let actualPath: string;

	if (typeof paramsOrTaskId === "object") {
		({ taskId, analysis: actualAnalysis, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrTaskId);
	} else {
		taskId = paramsOrTaskId;
		actualAnalysis = analysis!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const task = board.tasks.find((q) => q.id === taskId);
		if (task) {
			if (actualAnalysis.computedPackages) task.computedPackages = actualAnalysis.computedPackages;
			if (actualAnalysis.riskScore !== undefined) task.riskScore = actualAnalysis.riskScore;
			if (actualAnalysis.estimatedFiles) task.estimatedFiles = actualAnalysis.estimatedFiles;
			if (actualAnalysis.tags) task.tags = actualAnalysis.tags;
			saveTaskBoard(board, actualPath);
		}
	});
}

/**
 * Decompose a task into subtasks
 *
 * Marks the parent task as decomposed and creates subtask entries.
 * Subtasks inherit priority from parent (with small increments for ordering).
 *
 * @returns Array of created subtask IDs
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
	path?: string,
): string[] {
	let parentTaskId: string;
	let actualSubtasks: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>;
	let actualPath: string;

	if (typeof paramsOrParentTaskId === "object") {
		({ parentTaskId, subtasks: actualSubtasks, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrParentTaskId);
	} else {
		parentTaskId = paramsOrParentTaskId;
		actualSubtasks = subtasks!;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}
	return withLock(getLockPath(actualPath), () => {
		const board = loadTaskBoard(actualPath);
		const parentTask = board.tasks.find((t) => t.id === parentTaskId);

		if (!parentTask) {
			throw new Error(`Parent task not found: ${parentTaskId}`);
		}

		// Mark parent as decomposed (no longer directly executable)
		parentTask.isDecomposed = true;
		parentTask.status = "pending"; // Keep pending but won't be picked up due to isDecomposed

		// Create subtasks
		const subtaskIds: string[] = [];
		const basePriority = parentTask.priority ?? 999;

		for (const subtask of actualSubtasks) {
			const subtaskId = generateTaskId();
			const newTask: Task = {
				id: subtaskId,
				objective: subtask.objective,
				status: "pending",
				priority: basePriority + subtask.order * 0.1, // Preserve order within parent's priority
				createdAt: new Date(),
				parentId: parentTaskId,
				estimatedFiles: subtask.estimatedFiles,
				// Inherit some properties from parent
				tags: parentTask.tags,
				packageHints: parentTask.packageHints,
			};
			board.tasks.push(newTask);
			subtaskIds.push(subtaskId);
		}

		// Update parent with subtask references
		parentTask.subtaskIds = subtaskIds;

		saveTaskBoard(board, actualPath);
		return subtaskIds;
	});
}

/**
 * Check if all subtasks of a parent are complete
 */
export function areAllSubtasksComplete(params: SubtaskCheckParams): boolean;
export function areAllSubtasksComplete(parentTaskId: string, path?: string): boolean;
export function areAllSubtasksComplete(paramsOrParentTaskId: SubtaskCheckParams | string, path?: string): boolean {
	let parentTaskId: string;
	let actualPath: string;

	if (typeof paramsOrParentTaskId === "object") {
		({ parentTaskId, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrParentTaskId);
	} else {
		parentTaskId = paramsOrParentTaskId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	const board = loadTaskBoard(actualPath);
	const parentTask = board.tasks.find((t) => t.id === parentTaskId);

	if (!parentTask || !parentTask.subtaskIds || parentTask.subtaskIds.length === 0) {
		return false;
	}

	return parentTask.subtaskIds.every((subtaskId) => {
		const subtask = board.tasks.find((t) => t.id === subtaskId);
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
	path?: string,
): boolean {
	let parentTaskId: string;
	let actualPath: string;

	if (typeof paramsOrParentTaskId === "object") {
		({ parentTaskId, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrParentTaskId);
	} else {
		parentTaskId = paramsOrParentTaskId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	if (areAllSubtasksComplete(parentTaskId, actualPath)) {
		markTaskComplete(parentTaskId, actualPath);
		return true;
	}
	return false;
}

/**
 * Get task by ID
 */
export function getTaskById(params: GetTaskByIdParams): Task | undefined;
export function getTaskById(taskId: string, path?: string): Task | undefined;
export function getTaskById(paramsOrTaskId: GetTaskByIdParams | string, path?: string): Task | undefined {
	let taskId: string;
	let actualPath: string;

	if (typeof paramsOrTaskId === "object") {
		({ taskId, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrTaskId);
	} else {
		taskId = paramsOrTaskId;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}

	const board = loadTaskBoard(actualPath);
	return board.tasks.find((t) => t.id === taskId);
}

/**
 * Check if a task is too similar to any in-progress tasks
 * Returns the similar task if similarity > threshold, null otherwise
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
	path?: string,
): { task: Task; similarity: number } | null {
	let objective: string;
	let actualThreshold: number;
	let actualPath: string;

	if (typeof paramsOrObjective === "object") {
		({ objective, threshold: actualThreshold = 0.7, path: actualPath = DEFAULT_TASK_BOARD_PATH } = paramsOrObjective);
	} else {
		objective = paramsOrObjective;
		actualThreshold = threshold ?? 0.7;
		actualPath = path ?? DEFAULT_TASK_BOARD_PATH;
	}
	const board = loadTaskBoard(actualPath);
	const inProgress = board.tasks.filter((t) => t.status === "in_progress");

	if (inProgress.length === 0) {
		return null;
	}

	// Simple keyword extraction (stop words filtered)
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

		// Jaccard similarity
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
 * Scans recent commits and checks actual diffs to find completed work
 */
export async function reconcileTasks(options: { lookbackCommits?: number; dryRun?: boolean; path?: string }): Promise<{
	duplicatesFound: number;
	tasksMarked: Array<{ taskId: string; commitSha: string; message: string; confidence: string }>;
}> {
	const { lookbackCommits = 100, dryRun = false, path = DEFAULT_TASK_BOARD_PATH } = options;
	const board = loadTaskBoard(path);
	const { execSync } = await import("node:child_process");

	// Get recent commits with stats
	const commits = execSync(`git log --oneline --stat -${lookbackCommits}`, { encoding: "utf-8" })
		.trim()
		.split("\n\n") // Commits separated by blank lines
		.map((block) => {
			const lines = block.trim().split("\n");
			const [sha, ...messageParts] = lines[0].split(" ");
			const message = messageParts.join(" ");

			// Extract changed files from stat lines (ignore last line which is summary)
			const files = lines
				.slice(1, -1)
				.map((line) => line.trim().split("|")[0]?.trim())
				.filter(Boolean);

			return { sha, message, files };
		});

	const tasksToReconcile = board.tasks.filter(
		(t) => t.status === "pending" || t.status === "failed" || t.status === "in_progress",
	);

	const tasksMarked: Array<{ taskId: string; commitSha: string; message: string; confidence: string }> = [];

	for (const task of tasksToReconcile) {
		// Extract keywords from task objective
		const keywords = task.objective
			.toLowerCase()
			.replace(/[[\]]/g, "") // Remove brackets
			.split(/\s+/)
			.filter((word) => word.length > 3 && !["task", "this", "that", "with", "from", "should"].includes(word));

		// Extract file hints from task objective (e.g., "fix src/task.ts" -> ["src/task.ts"])
		const fileHints = task.objective.match(/[\w-]+\/[\w.-]+\.[\w]+/g) || [];

		// Find commits that match
		for (const commit of commits) {
			const commitLower = commit.message.toLowerCase();
			const keywordMatches = keywords.filter((keyword) => commitLower.includes(keyword)).length;
			const keywordScore = keywordMatches / Math.max(keywords.length, 1);

			// Check if any files in task hints match changed files
			const fileMatches = fileHints.filter((hint) => commit.files.some((file) => file.includes(hint))).length;
			const fileScore = fileHints.length > 0 ? fileMatches / fileHints.length : 0;

			// Combined confidence: both keywords and files must match
			const confidence = fileHints.length > 0 ? keywordScore * 0.6 + fileScore * 0.4 : keywordScore;

			// Only mark as duplicate if high confidence (>70%)
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
						path,
					});
				}
				break; // Found match, move to next task
			}
		}
	}

	return {
		duplicatesFound: tasksMarked.length,
		tasksMarked,
	};
}

// Legacy aliases for backwards compatibility during migration
export const BacklogItem = {} as Task;
export const Backlog = {} as TaskBoard;
export const loadBacklog = loadTaskBoard;
export const saveBacklog = saveTaskBoard;
export const addGoal = addTask;
export const addGoals = addTasks;
export const getNextGoal = getNextTask;
export const markInProgress = markTaskInProgress;
export const markComplete = markTaskComplete;
export const markFailed = markTaskFailed;
export const getBacklogSummary = getTaskBoardSummary;
export const clearCompleted = clearCompletedTasks;
export const getAllItems = getAllTasks;
