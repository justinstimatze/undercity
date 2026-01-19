/**
 * Task Index Cache Module
 *
 * In-memory indices to reduce O(n) scans on task board queries.
 * Maintains indices by status, priority, ID, package, and parent task.
 * Indices are lazily rebuilt when invalidated by write operations.
 *
 * | Index Type       | Purpose                                    |
 * |------------------|--------------------------------------------|
 * | By Status        | Fast lookup of pending/complete/etc tasks  |
 * | By Priority      | Fast ready task selection                  |
 * | By ID            | O(1) task lookup by ID                     |
 * | By Package       | Conflict detection across tasks            |
 * | By Parent        | Subtask decomposition queries              |
 *
 * Cache Invalidation Strategy:
 * - Write operations (add, update, mark status) invalidate relevant indices
 * - Lazy rebuild: indices rebuilt on next query after invalidation
 * - Manual refresh available for consistency checks
 */

import type { Task, TaskBoard } from "./task.js";
import { loadTaskBoard } from "./task.js";

/**
 * Pre-computed priority score for fast task selection
 */
interface ScoredTask {
	task: Task;
	score: number;
}

/**
 * Index state tracking
 */
interface IndexState {
	/** Whether this index needs rebuilding */
	dirty: boolean;
	/** Last rebuild timestamp */
	lastBuilt: Date | null;
}

/**
 * TaskIndex maintains in-memory indices for fast task board queries
 */
export class TaskIndex {
	// Primary indices
	private byId: Map<string, Task> = new Map();
	private byStatus: Map<Task["status"], Task[]> = new Map();
	private byParent: Map<string, Task[]> = new Map();
	private byPackage: Map<string, Task[]> = new Map();

	// Pre-computed results
	private readyTasksCache: ScoredTask[] | null = null;
	private packageStatsCache: Map<string, number> | null = null;

	// Index state tracking
	private indexState: Record<string, IndexState> = {
		byId: { dirty: true, lastBuilt: null },
		byStatus: { dirty: true, lastBuilt: null },
		byParent: { dirty: true, lastBuilt: null },
		byPackage: { dirty: true, lastBuilt: null },
		readyTasks: { dirty: true, lastBuilt: null },
		packageStats: { dirty: true, lastBuilt: null },
	};

	// File mtime tracking for detecting external changes
	private lastMtime: number | null = null;
	private taskBoardPath: string;

	constructor(taskBoardPath = ".undercity/tasks.json") {
		this.taskBoardPath = taskBoardPath;
	}

	/**
	 * Invalidate all indices (call after write operations)
	 */
	invalidateAll(): void {
		for (const key of Object.keys(this.indexState)) {
			this.indexState[key].dirty = true;
		}
		this.readyTasksCache = null;
		this.packageStatsCache = null;
	}

	/**
	 * Invalidate specific indices (more granular than invalidateAll)
	 */
	invalidate(indices: ("byId" | "byStatus" | "byParent" | "byPackage" | "readyTasks" | "packageStats")[]): void {
		for (const index of indices) {
			this.indexState[index].dirty = true;
		}
		// Clear dependent caches
		if (indices.includes("byStatus") || indices.includes("byId")) {
			this.readyTasksCache = null;
		}
		if (indices.includes("byPackage")) {
			this.packageStatsCache = null;
		}
	}

	/**
	 * Check if board file has changed since last index (detect external mutations)
	 */
	private hasBoardChanged(): boolean {
		try {
			const { statSync } = require("node:fs");
			const stats = statSync(this.taskBoardPath);
			const currentMtime = stats.mtimeMs;

			if (this.lastMtime === null) {
				this.lastMtime = currentMtime;
				return true;
			}

			if (currentMtime !== this.lastMtime) {
				this.lastMtime = currentMtime;
				return true;
			}

			return false;
		} catch {
			// File doesn't exist or error reading, assume changed
			return true;
		}
	}

	/**
	 * Ensure indices are up-to-date, rebuilding if necessary
	 */
	private ensureIndices(): TaskBoard {
		// Check for external file changes
		if (this.hasBoardChanged()) {
			this.invalidateAll();
		}

		const board = loadTaskBoard(this.taskBoardPath);

		// Rebuild dirty indices
		if (
			this.indexState.byId.dirty ||
			this.indexState.byStatus.dirty ||
			this.indexState.byParent.dirty ||
			this.indexState.byPackage.dirty
		) {
			this.rebuildIndices(board);
		}

		return board;
	}

	/**
	 * Rebuild all indices from task board
	 */
	private rebuildIndices(board: TaskBoard): void {
		const now = new Date();

		// Clear all indices
		this.byId.clear();
		this.byStatus.clear();
		this.byParent.clear();
		this.byPackage.clear();

		// Rebuild from tasks
		for (const task of board.tasks) {
			// By ID index
			this.byId.set(task.id, task);

			// By Status index
			if (!this.byStatus.has(task.status)) {
				this.byStatus.set(task.status, []);
			}
			this.byStatus.get(task.status)!.push(task);

			// By Parent index
			if (task.parentId) {
				if (!this.byParent.has(task.parentId)) {
					this.byParent.set(task.parentId, []);
				}
				this.byParent.get(task.parentId)!.push(task);
			}

			// By Package index
			const packages = task.computedPackages || task.packageHints || [];
			for (const pkg of packages) {
				if (!this.byPackage.has(pkg)) {
					this.byPackage.set(pkg, []);
				}
				this.byPackage.get(pkg)!.push(task);
			}
		}

		// Mark indices as clean
		this.indexState.byId = { dirty: false, lastBuilt: now };
		this.indexState.byStatus = { dirty: false, lastBuilt: now };
		this.indexState.byParent = { dirty: false, lastBuilt: now };
		this.indexState.byPackage = { dirty: false, lastBuilt: now };
	}

	/**
	 * Get all tasks (still O(n) but cached from file read)
	 */
	getAllTasks(): Task[] {
		const board = this.ensureIndices();
		return board.tasks;
	}

	/**
	 * Get task by ID - O(1) lookup
	 */
	getTaskById(id: string): Task | undefined {
		this.ensureIndices();
		return this.byId.get(id);
	}

	/**
	 * Get tasks by status - O(1) index lookup + O(k) result iteration
	 */
	getTasksByStatus(status: Task["status"]): Task[] {
		this.ensureIndices();
		return this.byStatus.get(status) || [];
	}

	/**
	 * Get subtasks of a parent task - O(1) lookup
	 */
	getSubtasks(parentId: string): Task[] {
		this.ensureIndices();
		return this.byParent.get(parentId) || [];
	}

	/**
	 * Get tasks touching a specific package - O(1) lookup
	 */
	getTasksByPackage(pkg: string): Task[] {
		this.ensureIndices();
		return this.byPackage.get(pkg) || [];
	}

	/**
	 * Get ready tasks for batch execution with pre-computed scores
	 * O(1) index lookup + O(k) scoring where k = pending tasks
	 */
	getReadyTasksForBatch(count: number): Task[] {
		this.ensureIndices();

		// Rebuild cache if dirty
		if (this.readyTasksCache === null || this.indexState.readyTasks.dirty) {
			this.readyTasksCache = this.computeReadyTasks();
			this.indexState.readyTasks = { dirty: false, lastBuilt: new Date() };
		}

		// Select compatible tasks with minimal file/package overlap
		const selectedTasks: Task[] = [];
		const usedPackages = new Set<string>();
		const usedFiles = new Set<string>();

		for (const { task } of this.readyTasksCache) {
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
	 * Compute and score ready tasks
	 */
	private computeReadyTasks(): ScoredTask[] {
		const pendingTasks = this.getTasksByStatus("pending");
		const completedTaskIds = new Set(this.getTasksByStatus("complete").map((t) => t.id));

		// Filter ready tasks (not decomposed, dependencies met)
		const readyTasks = pendingTasks.filter(
			(task) => !task.isDecomposed && (!task.dependsOn || task.dependsOn.every((depId) => completedTaskIds.has(depId))),
		);

		// Score tasks
		const scoredTasks = readyTasks.map((task) => {
			let score = task.priority ?? 999;

			// Boost/penalize based on tags
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
			const daysSinceCreation = (Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24);
			score += Math.min(daysSinceCreation * 0.5, 30);

			// Consider dependencies
			if (task.dependsOn && task.dependsOn.length > 0) {
				score += task.dependsOn.length * 5;
			}

			return { task, score };
		});

		// Sort by score (lower is better)
		return scoredTasks.sort((a, b) => a.score - b.score);
	}

	/**
	 * Get package usage statistics for analytics
	 * Returns map of package -> task count
	 */
	getPackageStats(): Map<string, number> {
		this.ensureIndices();

		// Use cache if available
		if (this.packageStatsCache !== null && !this.indexState.packageStats.dirty) {
			return this.packageStatsCache;
		}

		// Rebuild cache
		const stats = new Map<string, number>();
		for (const [pkg, tasks] of this.byPackage.entries()) {
			stats.set(pkg, tasks.length);
		}

		this.packageStatsCache = stats;
		this.indexState.packageStats = { dirty: false, lastBuilt: new Date() };

		return stats;
	}

	/**
	 * Get top conflicting packages (most frequently touched)
	 */
	getTopConflictingPackages(limit = 5): string[] {
		const stats = this.getPackageStats();
		return Array.from(stats.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([pkg]) => pkg);
	}

	/**
	 * Get summary statistics
	 */
	getSummary(): {
		totalTasks: number;
		byStatus: Record<Task["status"], number>;
		pendingReady: number;
		pendingBlocked: number;
		indexedPackages: number;
		cacheStats: {
			readyTasksCached: boolean;
			packageStatsCached: boolean;
			lastRebuildAt: Date | null;
		};
	} {
		this.ensureIndices();

		const pendingTasks = this.getTasksByStatus("pending");
		const completedTaskIds = new Set(this.getTasksByStatus("complete").map((t) => t.id));

		const pendingReady = pendingTasks.filter(
			(task) => !task.isDecomposed && (!task.dependsOn || task.dependsOn.every((depId) => completedTaskIds.has(depId))),
		).length;

		const pendingBlocked = pendingTasks.length - pendingReady;

		return {
			totalTasks: this.byId.size,
			byStatus: {
				pending: this.byStatus.get("pending")?.length || 0,
				in_progress: this.byStatus.get("in_progress")?.length || 0,
				complete: this.byStatus.get("complete")?.length || 0,
				failed: this.byStatus.get("failed")?.length || 0,
				blocked: this.byStatus.get("blocked")?.length || 0,
				duplicate: this.byStatus.get("duplicate")?.length || 0,
				canceled: this.byStatus.get("canceled")?.length || 0,
				obsolete: this.byStatus.get("obsolete")?.length || 0,
			},
			pendingReady,
			pendingBlocked,
			indexedPackages: this.byPackage.size,
			cacheStats: {
				readyTasksCached: this.readyTasksCache !== null,
				packageStatsCached: this.packageStatsCache !== null,
				lastRebuildAt: this.indexState.byId.lastBuilt,
			},
		};
	}

	/**
	 * Clear all caches and force rebuild on next query
	 */
	reset(): void {
		this.invalidateAll();
		this.lastMtime = null;
	}
}

// Map of path -> TaskIndex instances
const indexInstances: Map<string, TaskIndex> = new Map();
const DEFAULT_TASK_BOARD_PATH = ".undercity/tasks.json";

/**
 * Get the task index instance for a specific path
 * Each path gets its own TaskIndex to avoid cross-path cache issues
 */
export function getTaskIndex(path?: string): TaskIndex {
	const resolvedPath = path ?? DEFAULT_TASK_BOARD_PATH;
	let instance = indexInstances.get(resolvedPath);
	if (!instance) {
		instance = new TaskIndex(resolvedPath);
		indexInstances.set(resolvedPath, instance);
	}
	return instance;
}

/**
 * Reset the task index (for testing)
 * If path is provided, only reset that path's index
 * If no path is provided, reset all indices
 */
export function resetTaskIndex(path?: string): void {
	if (path) {
		indexInstances.delete(path);
	} else {
		indexInstances.clear();
	}
}
