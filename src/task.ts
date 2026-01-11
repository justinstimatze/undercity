/**
 * Task Board Module
 *
 * Manages the task board - a queue of tasks for undercity to work through.
 * Tasks are processed sequentially in full-auto mode.
 */

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
	status: "pending" | "in_progress" | "complete" | "failed";
	priority?: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	sessionId?: string;
	error?: string;

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
	const random = Math.random().toString(36).substring(2, 6);
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
 * Add a task to the board
 */
export function addTask(objective: string, priority?: number, path: string = DEFAULT_TASK_BOARD_PATH): Task {
	return withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task: Task = {
			id: generateTaskId(),
			objective,
			status: "pending",
			priority: priority ?? board.tasks.length,
			createdAt: new Date(),
		};
		board.tasks.push(task);
		saveTaskBoard(board, path);
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
 * Mark a task as in progress
 */
export function markTaskInProgress(id: string, sessionId: string, path: string = DEFAULT_TASK_BOARD_PATH): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task = board.tasks.find((q) => q.id === id);
		if (task) {
			task.status = "in_progress";
			task.startedAt = new Date();
			task.sessionId = sessionId;
			saveTaskBoard(board, path);
		}
	});
}

/**
 * Mark a task as complete
 */
export function markTaskComplete(id: string, path: string = DEFAULT_TASK_BOARD_PATH): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task = board.tasks.find((q) => q.id === id);
		if (task) {
			task.status = "complete";
			task.completedAt = new Date();
			saveTaskBoard(board, path);
		}
	});
}

/**
 * Mark a task as failed
 */
export function markTaskFailed(id: string, error: string, path: string = DEFAULT_TASK_BOARD_PATH): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task = board.tasks.find((q) => q.id === id);
		if (task) {
			task.status = "failed";
			task.completedAt = new Date();
			task.error = error;
			saveTaskBoard(board, path);
		}
	});
}

/**
 * Get task board summary
 */
export function getTaskBoardSummary(): { pending: number; inProgress: number; complete: number; failed: number } {
	const board = loadTaskBoard();
	return {
		pending: board.tasks.filter((q) => q.status === "pending").length,
		inProgress: board.tasks.filter((q) => q.status === "in_progress").length,
		complete: board.tasks.filter((q) => q.status === "complete").length,
		failed: board.tasks.filter((q) => q.status === "failed").length,
	};
}

/**
 * Clear completed tasks from the board
 */
export function clearCompletedTasks(path: string = DEFAULT_TASK_BOARD_PATH): number {
	return withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const before = board.tasks.length;
		board.tasks = board.tasks.filter((q) => q.status !== "complete");
		saveTaskBoard(board, path);
		return before - board.tasks.length;
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
export function getReadyTasksForBatch(count: number = 3): Task[] {
	const board = loadTaskBoard();
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
export function markTaskSetInProgress(
	taskIds: string[],
	sessionIds: string[],
	path: string = DEFAULT_TASK_BOARD_PATH,
): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		for (let i = 0; i < taskIds.length; i++) {
			const taskId = taskIds[i];
			const sessionId = sessionIds[i];
			const task = board.tasks.find((q) => q.id === taskId);
			if (task) {
				task.status = "in_progress";
				task.startedAt = new Date();
				task.sessionId = sessionId;
			}
		}
		saveTaskBoard(board, path);
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
export function updateTaskAnalysis(
	taskId: string,
	analysis: {
		computedPackages?: string[];
		riskScore?: number;
		estimatedFiles?: string[];
		tags?: string[];
	},
	path: string = DEFAULT_TASK_BOARD_PATH,
): void {
	withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
		const task = board.tasks.find((q) => q.id === taskId);
		if (task) {
			if (analysis.computedPackages) task.computedPackages = analysis.computedPackages;
			if (analysis.riskScore !== undefined) task.riskScore = analysis.riskScore;
			if (analysis.estimatedFiles) task.estimatedFiles = analysis.estimatedFiles;
			if (analysis.tags) task.tags = analysis.tags;
			saveTaskBoard(board, path);
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
export function decomposeTaskIntoSubtasks(
	parentTaskId: string,
	subtasks: Array<{
		objective: string;
		estimatedFiles?: string[];
		order: number;
	}>,
	path: string = DEFAULT_TASK_BOARD_PATH,
): string[] {
	return withLock(getLockPath(path), () => {
		const board = loadTaskBoard(path);
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

		for (const subtask of subtasks) {
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

		saveTaskBoard(board, path);
		return subtaskIds;
	});
}

/**
 * Check if all subtasks of a parent are complete
 */
export function areAllSubtasksComplete(parentTaskId: string, path: string = DEFAULT_TASK_BOARD_PATH): boolean {
	const board = loadTaskBoard(path);
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
export function completeParentIfAllSubtasksDone(parentTaskId: string, path: string = DEFAULT_TASK_BOARD_PATH): boolean {
	if (areAllSubtasksComplete(parentTaskId, path)) {
		markTaskComplete(parentTaskId, path);
		return true;
	}
	return false;
}

/**
 * Get task by ID
 */
export function getTaskById(taskId: string, path: string = DEFAULT_TASK_BOARD_PATH): Task | undefined {
	const board = loadTaskBoard(path);
	return board.tasks.find((t) => t.id === taskId);
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
