/**
 * Persistence Module
 *
 * Handles the persistence hierarchy:
 * - Safe Pocket: Critical state surviving crashes
 * - Inventory: Active session state (steps, squad)
 * - Loadout: Pre-session config
 *
 * All state is stored as JSON files in .undercity/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { persistenceLogger } from "./logger.js";
import type {
	ActiveTaskState,
	Agent,
	AgentType,
	BatchMetadata,
	CompletedTaskState,
	FileTrackingState,
	Inventory,
	Loadout,
	LoadoutConfiguration,
	LoadoutPerformanceRecord,
	LoadoutScore,
	LoadoutStorage,
	ParallelRecoveryState,
	ProjectProfile,
	PromptKnowledge,
	RateLimitState,
	ScoutCache,
	ScoutCacheEntry,
	SessionRecovery,
	Step,
	TaskMetrics,
	WorktreeInfo,
	WorktreeState,
} from "./types.js";

/** Scout cache configuration */
const FLUTE_CACHE_FILE = "flute-cache.json";
const SCOUT_CACHE_VERSION = "1.0";
const SCOUT_CACHE_MAX_ENTRIES = 100;
const SCOUT_CACHE_TTL_DAYS = 30;

const DEFAULT_STATE_DIR = ".undercity";

/**
 * Persistence manager for Undercity state
 */
export class Persistence {
	private stateDir: string;

	constructor(stateDir: string = DEFAULT_STATE_DIR) {
		this.stateDir = stateDir;
		this.ensureDirectories();
	}

	private ensureDirectories(): void {
		const dirs = [this.stateDir, join(this.stateDir, "squad"), join(this.stateDir, "logs")];

		for (const dir of dirs) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
	}

	private getPath(filename: string): string {
		return join(this.stateDir, filename);
	}

	private readJson<T>(filename: string, defaultValue: T): T {
		const path = this.getPath(filename);
		if (!existsSync(path)) {
			return defaultValue;
		}
		try {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content) as T;
		} catch {
			return defaultValue;
		}
	}

	private writeJson<T>(filename: string, data: T): void {
		const path = this.getPath(filename);
		const tempPath = `${path}.tmp`;
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		try {
			// Write to temporary file first
			writeFileSync(tempPath, JSON.stringify(data, null, 2), {
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

	// ============== Session Recovery ==============
	// Critical state that survives crashes

	getSessionRecovery(): SessionRecovery {
		return this.readJson<SessionRecovery>("session-recovery.json", {
			lastUpdated: new Date(),
		});
	}

	saveSessionRecovery(recovery: SessionRecovery): void {
		recovery.lastUpdated = new Date();
		this.writeJson("session-recovery.json", recovery);
	}

	clearSessionRecovery(): void {
		this.writeJson<SessionRecovery>("session-recovery.json", {
			lastUpdated: new Date(),
		});
	}

	/** @deprecated Use getSessionRecovery instead */
	getPocket(): SessionRecovery {
		return this.getSessionRecovery();
	}

	/** @deprecated Use saveSessionRecovery instead */
	savePocket(pocket: SessionRecovery): void {
		this.saveSessionRecovery(pocket);
	}

	/** @deprecated Use clearSessionRecovery instead */
	clearPocket(): void {
		this.clearSessionRecovery();
	}

	// ============== Inventory ==============
	// Active session state (steps, squad)

	getInventory(): Inventory {
		return this.readJson<Inventory>("inventory.json", {
			steps: [],
			agents: [],
			lastUpdated: new Date(),
		});
	}

	saveInventory(inventory: Inventory): void {
		inventory.lastUpdated = new Date();
		this.writeJson("inventory.json", inventory);
	}

	// Convenience methods for inventory
	getTasks(): Step[] {
		return this.getInventory().steps;
	}

	saveTasks(steps: Step[]): void {
		const inventory = this.getInventory();
		inventory.steps = steps;
		this.saveInventory(inventory);
	}

	addTasks(step: Step): void {
		const steps = this.getTasks();
		steps.push(step);
		this.saveTasks(steps);
	}

	updateTask(stepId: string, updates: Partial<Step>): void {
		const steps = this.getTasks();
		const index = steps.findIndex((t) => t.id === stepId);
		if (index !== -1) {
			steps[index] = { ...steps[index], ...updates };
			this.saveTasks(steps);
		}
	}

	getAgents(): Agent[] {
		return this.getInventory().agents;
	}

	saveAgents(agents: Agent[]): void {
		const inventory = this.getInventory();
		inventory.agents = agents;
		this.saveInventory(inventory);
	}

	addAgent(member: Agent): void {
		const agents = this.getAgents();
		agents.push(member);
		this.saveAgents(agents);
	}

	updateAgent(memberId: string, updates: Partial<Agent>): void {
		const agents = this.getAgents();
		const index = agents.findIndex((m) => m.id === memberId);
		if (index !== -1) {
			agents[index] = { ...agents[index], ...updates };
			this.saveAgents(agents);
		}
	}

	removeAgent(memberId: string): void {
		const agents = this.getAgents().filter((m) => m.id !== memberId);
		this.saveAgents(agents);
	}

	// ============== Loadout ==============
	// Pre-session configuration

	getLoadout(): Loadout {
		return this.readJson<Loadout>("loadout.json", {
			maxAgents: 5,
			enabledAgentTypes: ["scout", "planner", "builder", "reviewer"] as AgentType[],
			autoApprove: false,
			lastUpdated: new Date(),
		});
	}

	saveLoadout(loadout: Loadout): void {
		loadout.lastUpdated = new Date();
		this.writeJson("loadout.json", loadout);
	}

	// ============== Loadout Configurations ==============
	// Configurable loadouts for different task types

	getLoadoutStorage(): LoadoutStorage {
		return this.readJson<LoadoutStorage>("loadout-storage.json", {
			configurations: [],
			performanceRecords: [],
			scores: {},
			lastUpdated: new Date(),
		});
	}

	saveLoadoutStorage(storage: LoadoutStorage): void {
		storage.lastUpdated = new Date();
		this.writeJson("loadout-storage.json", storage);
	}

	getLoadoutConfigurations(): LoadoutConfiguration[] {
		return this.getLoadoutStorage().configurations;
	}

	saveLoadoutConfiguration(config: LoadoutConfiguration): void {
		const storage = this.getLoadoutStorage();
		const index = storage.configurations.findIndex((c) => c.id === config.id);
		if (index !== -1) {
			storage.configurations[index] = config;
		} else {
			storage.configurations.push(config);
		}
		this.saveLoadoutStorage(storage);
	}

	removeLoadoutConfiguration(id: string): void {
		const storage = this.getLoadoutStorage();
		storage.configurations = storage.configurations.filter((c) => c.id !== id);
		this.saveLoadoutStorage(storage);
	}

	getLoadoutPerformanceRecords(): LoadoutPerformanceRecord[] {
		return this.getLoadoutStorage().performanceRecords;
	}

	addLoadoutPerformanceRecord(record: LoadoutPerformanceRecord): void {
		const storage = this.getLoadoutStorage();
		storage.performanceRecords.push(record);
		this.saveLoadoutStorage(storage);
	}

	getLoadoutScores(): Record<string, LoadoutScore> {
		return this.getLoadoutStorage().scores;
	}

	saveLoadoutScore(score: LoadoutScore): void {
		const storage = this.getLoadoutStorage();
		storage.scores[score.loadoutId] = score;
		this.saveLoadoutStorage(storage);
	}

	// ============== Squad Member Sessions ==============
	// Per-agent session state for SDK resumption

	getAgentSession(memberId: string): string | undefined {
		const path = join(this.stateDir, "squad", `${memberId}.json`);
		if (!existsSync(path)) {
			return undefined;
		}
		try {
			const content = readFileSync(path, "utf-8");
			const data = JSON.parse(content) as { sessionId?: string };
			return data.sessionId;
		} catch {
			return undefined;
		}
	}

	saveAgentSession(memberId: string, sessionId: string): void {
		const path = join(this.stateDir, "squad", `${memberId}.json`);
		const tempPath = `${path}.tmp`;
		const data = JSON.stringify({ sessionId, savedAt: new Date() }, null, 2);

		try {
			// Write to temporary file first
			writeFileSync(tempPath, data, {
				encoding: "utf-8",
				flag: "w",
			});

			// Atomically rename temporary file to target file
			renameSync(tempPath, path);
		} catch (error) {
			// Clean up temporary file if it exists
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}
	}

	// ============== File Tracking ==============
	// Track which files each agent is touching

	getFileTracking(): FileTrackingState {
		return this.readJson<FileTrackingState>("file-tracking.json", {
			entries: {},
			lastUpdated: new Date(),
		});
	}

	saveFileTracking(state: FileTrackingState): void {
		state.lastUpdated = new Date();
		this.writeJson("file-tracking.json", state);
	}

	clearFileTracking(): void {
		this.writeJson<FileTrackingState>("file-tracking.json", {
			entries: {},
			lastUpdated: new Date(),
		});
	}

	// ============== Git Worktree State ==============
	// Track active worktrees for session isolation

	getWorktreeState(): WorktreeState {
		return this.readJson<WorktreeState>("worktree-state.json", {
			worktrees: {},
			lastUpdated: new Date(),
		});
	}

	saveWorktreeState(state: WorktreeState): void {
		state.lastUpdated = new Date();
		this.writeJson("worktree-state.json", state);
	}

	addWorktree(worktreeInfo: WorktreeInfo): void {
		const state = this.getWorktreeState();
		state.worktrees[worktreeInfo.sessionId] = worktreeInfo;
		this.saveWorktreeState(state);
	}

	removeWorktree(sessionId: string): void {
		const state = this.getWorktreeState();
		delete state.worktrees[sessionId];
		this.saveWorktreeState(state);
	}

	getWorktreeForSession(sessionId: string): WorktreeInfo | null {
		const state = this.getWorktreeState();
		return state.worktrees[sessionId] || null;
	}

	getAllActiveWorktrees(): WorktreeInfo[] {
		const state = this.getWorktreeState();
		return Object.values(state.worktrees).filter((w) => w.isActive);
	}

	clearWorktreeState(): void {
		this.writeJson<WorktreeState>("worktree-state.json", {
			worktrees: {},
			lastUpdated: new Date(),
		});
	}

	// ============== Utilities ==============

	/**
	 * Clear all state for a fresh start
	 */
	clearAll(): void {
		this.clearSessionRecovery();
		this.saveInventory({
			steps: [],
			agents: [],
			lastUpdated: new Date(),
		});
	}

	// ============== Scout Cache ==============
	// Caches flute results to avoid redundant codebase analysis

	/**
	 * Get the flute cache (creates empty cache if doesn't exist)
	 */
	getScoutCache(): ScoutCache {
		return this.readJson<ScoutCache>(FLUTE_CACHE_FILE, {
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
	}

	/**
	 * Save the flute cache
	 */
	saveScoutCache(cache: ScoutCache): void {
		cache.lastUpdated = new Date();
		this.writeJson(FLUTE_CACHE_FILE, cache);
	}

	/**
	 * Get a flute cache entry by fingerprint and goal hash
	 *
	 * @param fingerprintHash Hash of the codebase fingerprint
	 * @param goalHash Hash of the flute goal
	 * @returns The cache entry if found and valid, null otherwise
	 */
	getScoutCacheEntry(fingerprintHash: string, goalHash: string): ScoutCacheEntry | null {
		try {
			const cache = this.getScoutCache();
			const key = `${fingerprintHash}:${goalHash}`;
			const entry = cache.entries[key];

			if (!entry) {
				return null;
			}

			// Check TTL
			const createdAt = new Date(entry.createdAt);
			const ageMs = Date.now() - createdAt.getTime();
			const ttlMs = SCOUT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

			if (ageMs > ttlMs) {
				persistenceLogger.debug({ key, ageMs, ttlMs }, "Scout cache entry expired");
				return null;
			}

			// Update last used timestamp
			entry.lastUsedAt = new Date();
			cache.entries[key] = entry;
			this.saveScoutCache(cache);

			persistenceLogger.debug({ key, goalText: entry.goalText }, "Scout cache hit");
			return entry;
		} catch (error) {
			persistenceLogger.warn({ error }, "Error reading flute cache entry");
			return null;
		}
	}

	/**
	 * Save a flute result to the cache
	 *
	 * @param fingerprintHash Hash of the codebase fingerprint
	 * @param goalHash Hash of the flute goal
	 * @param fluteResult The flute intel result to cache
	 * @param goalText Original goal text (for debugging)
	 */
	saveScoutCacheEntry(fingerprintHash: string, goalHash: string, fluteResult: string, goalText: string): void {
		try {
			const cache = this.getScoutCache();
			const key = `${fingerprintHash}:${goalHash}`;

			const entry: ScoutCacheEntry = {
				fingerprintHash,
				goalHash,
				fluteResult,
				goalText,
				createdAt: new Date(),
				lastUsedAt: new Date(),
			};

			cache.entries[key] = entry;

			// Cleanup if over max entries (LRU eviction)
			const entries = Object.entries(cache.entries);
			if (entries.length > SCOUT_CACHE_MAX_ENTRIES) {
				// Sort by lastUsedAt ascending (oldest first)
				entries.sort((a, b) => {
					const aTime = new Date(a[1].lastUsedAt).getTime();
					const bTime = new Date(b[1].lastUsedAt).getTime();
					return aTime - bTime;
				});

				// Remove oldest entries to get under limit
				const toRemove = entries.length - SCOUT_CACHE_MAX_ENTRIES;
				for (let i = 0; i < toRemove; i++) {
					delete cache.entries[entries[i][0]];
				}

				persistenceLogger.debug({ removed: toRemove }, "Evicted old flute cache entries (LRU)");
			}

			this.saveScoutCache(cache);
			persistenceLogger.debug({ key, goalText }, "Saved flute result to cache");
		} catch (error) {
			persistenceLogger.warn({ error }, "Error saving flute cache entry");
			// Silent failure - caching is optional
		}
	}

	/**
	 * Clean up expired cache entries
	 */
	cleanupScoutCache(): void {
		try {
			const cache = this.getScoutCache();
			const now = Date.now();
			const ttlMs = SCOUT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
			let removed = 0;

			for (const [key, entry] of Object.entries(cache.entries)) {
				const createdAt = new Date(entry.createdAt).getTime();
				if (now - createdAt > ttlMs) {
					delete cache.entries[key];
					removed++;
				}
			}

			if (removed > 0) {
				this.saveScoutCache(cache);
				persistenceLogger.info({ removed }, "Cleaned up expired flute cache entries");
			}
		} catch (error) {
			persistenceLogger.warn({ error }, "Error cleaning up flute cache");
		}
	}

	/**
	 * Clear the entire flute cache
	 */
	clearScoutCache(): void {
		this.saveScoutCache({
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
		persistenceLogger.info("Cleared flute cache");
	}

	/**
	 * Get flute cache statistics
	 */
	getScoutCacheStats(): { entryCount: number; oldestEntry: Date | null; newestEntry: Date | null } {
		const cache = this.getScoutCache();
		const entries = Object.values(cache.entries);

		if (entries.length === 0) {
			return { entryCount: 0, oldestEntry: null, newestEntry: null };
		}

		const dates = entries.map((e) => new Date(e.createdAt).getTime());
		return {
			entryCount: entries.length,
			oldestEntry: new Date(Math.min(...dates)),
			newestEntry: new Date(Math.max(...dates)),
		};
	}

	// ============== Rate Limit Tracking ==============

	/**
	 * Get rate limit state
	 */
	getRateLimitState(): RateLimitState | null {
		try {
			return this.readJson<RateLimitState>("rate-limit-state.json", {
				tasks: [],
				rateLimitHits: [],
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: {
						haiku: 0.25,
						sonnet: 1.0,
						opus: 12.0,
					},
				},
				pause: { isPaused: false },
				lastUpdated: new Date(),
			});
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to load rate limit state");
			return null;
		}
	}

	/**
	 * Save rate limit state
	 */
	saveRateLimitState(state: RateLimitState): void {
		try {
			state.lastUpdated = new Date();
			this.writeJson("rate-limit-state.json", state);
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to save rate limit state");
		}
	}

	// ============== Task Metrics ==============

	/**
	 * Save task metrics
	 */
	saveTaskMetrics(metrics: TaskMetrics): void {
		try {
			const metricsFile = this.getPath("task-metrics.json");
			let existingMetrics: TaskMetrics[] = [];

			// Load existing metrics
			if (existsSync(metricsFile)) {
				const data = JSON.parse(readFileSync(metricsFile, "utf8"));
				existingMetrics = data.metrics || [];
			}

			// Add new metrics
			existingMetrics.push(metrics);

			// Keep only the most recent 1000 metrics to prevent file size growth
			if (existingMetrics.length > 1000) {
				existingMetrics = existingMetrics.slice(-1000);
			}

			// Save back to file
			const data = {
				metrics: existingMetrics,
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const tempPath = `${metricsFile}.tmp`;
			try {
				// Write to temporary file first
				writeFileSync(tempPath, JSON.stringify(data, null, 2), {
					encoding: "utf-8",
					flag: "w",
				});

				// Atomically rename temporary file to target file
				renameSync(tempPath, metricsFile);
			} catch (writeError) {
				// Clean up temporary file if it exists
				if (existsSync(tempPath)) {
					unlinkSync(tempPath);
				}
				throw writeError;
			}
			persistenceLogger.debug({ taskId: metrics.taskId }, "Saved task metrics");
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to save task metrics");
		}
	}

	/**
	 * Load all task metrics
	 */
	getTaskMetrics(): TaskMetrics[] {
		try {
			const metricsFile = this.getPath("task-metrics.json");
			if (!existsSync(metricsFile)) {
				return [];
			}

			const data = JSON.parse(readFileSync(metricsFile, "utf8"));
			return data.metrics || [];
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to load task metrics");
			return [];
		}
	}

	/**
	 * Get task metrics filtered by session ID
	 */
	getTaskMetricsBySession(sessionId: string): TaskMetrics[] {
		return this.getTaskMetrics().filter((m) => m.sessionId === sessionId);
	}

	// ============== Parallel Recovery System ==============

	/**
	 * Save parallel recovery state
	 */
	saveParallelRecoveryState(state: ParallelRecoveryState): void {
		state.lastUpdated = new Date();
		this.writeJson("parallel-recovery.json", state);
	}

	/**
	 * Get parallel recovery state
	 */
	getParallelRecoveryState(): ParallelRecoveryState | null {
		try {
			const state = this.readJson<ParallelRecoveryState | null>("parallel-recovery.json", null);
			return state;
		} catch {
			return null;
		}
	}

	/**
	 * Check if there's an active (incomplete) parallel batch
	 */
	hasActiveParallelBatch(): boolean {
		const state = this.getParallelRecoveryState();
		return state !== null && !state.isComplete;
	}

	/**
	 * Clear parallel recovery state
	 */
	clearParallelRecoveryState(): void {
		const path = this.getPath("parallel-recovery.json");
		if (existsSync(path)) {
			unlinkSync(path);
		}
	}

	// ============== Atomic Recovery System ==============
	// Directory-based per-task state for crash-safe recovery

	private get activeDir(): string {
		return join(this.stateDir, "active");
	}

	private get completedDir(): string {
		return join(this.stateDir, "completed");
	}

	private ensureRecoveryDirs(): void {
		for (const dir of [this.activeDir, this.completedDir]) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
	}

	/**
	 * Save batch metadata (once per batch)
	 */
	saveBatchMetadata(metadata: BatchMetadata): void {
		this.writeJson("batch-meta.json", metadata);
	}

	/**
	 * Get batch metadata
	 */
	getBatchMetadata(): BatchMetadata | null {
		try {
			return this.readJson<BatchMetadata | null>("batch-meta.json", null);
		} catch {
			return null;
		}
	}

	/**
	 * Clear batch metadata
	 */
	clearBatchMetadata(): void {
		const path = this.getPath("batch-meta.json");
		if (existsSync(path)) {
			unlinkSync(path);
		}
	}

	/**
	 * Write active task state atomically
	 */
	writeActiveTask(state: ActiveTaskState): void {
		this.ensureRecoveryDirs();
		const filePath = join(this.activeDir, `${state.taskId}.state`);
		const tempPath = `${filePath}.tmp`;

		try {
			writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
			renameSync(tempPath, filePath);
			persistenceLogger.debug({ taskId: state.taskId }, "Wrote active task state");
		} catch (error) {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}
	}

	/**
	 * Read active task state
	 */
	readActiveTask(taskId: string): ActiveTaskState | null {
		const filePath = join(this.activeDir, `${taskId}.state`);
		if (!existsSync(filePath)) {
			return null;
		}

		try {
			const content = readFileSync(filePath, "utf-8");
			return JSON.parse(content) as ActiveTaskState;
		} catch {
			return null;
		}
	}

	/**
	 * Update active task status
	 */
	updateActiveTaskStatus(taskId: string, status: "pending" | "running", startedAt?: Date): void {
		const state = this.readActiveTask(taskId);
		if (!state) return;

		state.status = status;
		if (startedAt) {
			state.startedAt = startedAt;
		}
		this.writeActiveTask(state);
	}

	/**
	 * Mark task as completed (moves from active/ to completed/)
	 */
	markTaskCompleted(
		taskId: string,
		status: "complete" | "failed" | "merged",
		extra?: { error?: string; modifiedFiles?: string[] },
	): void {
		this.ensureRecoveryDirs();
		const activeTask = this.readActiveTask(taskId);
		if (!activeTask) {
			persistenceLogger.warn({ taskId }, "No active task found to complete");
			return;
		}

		// Create completed state
		const completedState: CompletedTaskState = {
			taskId: activeTask.taskId,
			task: activeTask.task,
			status,
			batchId: activeTask.batchId,
			completedAt: new Date(),
			error: extra?.error,
			modifiedFiles: extra?.modifiedFiles,
		};

		// Write to completed dir
		const completedPath = join(this.completedDir, `${taskId}.done`);
		const tempPath = `${completedPath}.tmp`;
		try {
			writeFileSync(tempPath, JSON.stringify(completedState, null, 2), "utf-8");
			renameSync(tempPath, completedPath);
		} catch (error) {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}

		// Remove from active dir
		const activePath = join(this.activeDir, `${taskId}.state`);
		if (existsSync(activePath)) {
			unlinkSync(activePath);
		}

		persistenceLogger.debug({ taskId, status }, "Marked task completed");
	}

	/**
	 * Scan active directory for all active tasks
	 */
	scanActiveTasks(): ActiveTaskState[] {
		this.ensureRecoveryDirs();
		const tasks: ActiveTaskState[] = [];

		try {
			const files = readdirSync(this.activeDir);
			for (const file of files) {
				if (file.endsWith(".state")) {
					const filePath = join(this.activeDir, file);
					try {
						const content = readFileSync(filePath, "utf-8");
						const state = JSON.parse(content) as ActiveTaskState;
						tasks.push(state);
					} catch {
						// Skip corrupt files
						persistenceLogger.warn({ file }, "Skipping corrupt active task file");
					}
				}
			}
		} catch {
			// Directory doesn't exist or can't be read
		}

		return tasks;
	}

	/**
	 * Check if there are active tasks
	 */
	hasActiveTasks(): boolean {
		try {
			if (!existsSync(this.activeDir)) {
				return false;
			}
			const files = readdirSync(this.activeDir);
			return files.some((f) => f.endsWith(".state"));
		} catch {
			return false;
		}
	}

	/**
	 * Clear all active and completed tasks for a batch
	 */
	clearBatch(batchId: string): void {
		this.ensureRecoveryDirs();

		// Clear active tasks
		try {
			const activeFiles = readdirSync(this.activeDir);
			for (const file of activeFiles) {
				if (file.endsWith(".state")) {
					const filePath = join(this.activeDir, file);
					try {
						const content = readFileSync(filePath, "utf-8");
						const state = JSON.parse(content) as ActiveTaskState;
						if (state.batchId === batchId) {
							unlinkSync(filePath);
						}
					} catch {
						// Skip if can't read
					}
				}
			}
		} catch {
			// Directory doesn't exist
		}

		// Clear completed tasks
		try {
			const completedFiles = readdirSync(this.completedDir);
			for (const file of completedFiles) {
				if (file.endsWith(".done")) {
					const filePath = join(this.completedDir, file);
					try {
						const content = readFileSync(filePath, "utf-8");
						const state = JSON.parse(content) as CompletedTaskState;
						if (state.batchId === batchId) {
							unlinkSync(filePath);
						}
					} catch {
						// Skip if can't read
					}
				}
			}
		} catch {
			// Directory doesn't exist
		}

		// Clear batch metadata
		this.clearBatchMetadata();

		persistenceLogger.debug({ batchId }, "Cleared batch");
	}

	/**
	 * Get all completed tasks for a batch
	 */
	getCompletedTasks(batchId: string): CompletedTaskState[] {
		this.ensureRecoveryDirs();
		const tasks: CompletedTaskState[] = [];

		try {
			const files = readdirSync(this.completedDir);
			for (const file of files) {
				if (file.endsWith(".done")) {
					const filePath = join(this.completedDir, file);
					try {
						const content = readFileSync(filePath, "utf-8");
						const state = JSON.parse(content) as CompletedTaskState;
						if (state.batchId === batchId) {
							tasks.push(state);
						}
					} catch {
						// Skip corrupt files
					}
				}
			}
		} catch {
			// Directory doesn't exist
		}

		return tasks;
	}

	/**
	 * Check if batch is complete (no active tasks remain)
	 */
	isBatchComplete(): boolean {
		return !this.hasActiveTasks();
	}

	// ============== Prompt Knowledge ==============

	/**
	 * Save prompt knowledge entry
	 */
	savePromptKnowledge(entry: PromptKnowledge): void {
		try {
			const knowledgeFile = this.getPath("prompt-knowledge.json");
			let knowledge: PromptKnowledge[] = [];

			// Load existing knowledge
			if (existsSync(knowledgeFile)) {
				const data = JSON.parse(readFileSync(knowledgeFile, "utf8"));
				knowledge = data.knowledge || [];
			}

			// Check if this approach already exists
			const existingIndex = knowledge.findIndex((k) => k.id === entry.id);
			if (existingIndex !== -1) {
				// Update existing entry
				knowledge[existingIndex] = {
					...knowledge[existingIndex],
					approach: entry.approach,
					metrics: {
						tokensUsed: (knowledge[existingIndex].metrics.tokensUsed + entry.metrics.tokensUsed) / 2,
						executionTimeMs: (knowledge[existingIndex].metrics.executionTimeMs + entry.metrics.executionTimeMs) / 2,
						successRating: entry.metrics.successRating ?? knowledge[existingIndex].metrics.successRating,
					},
					tags: [...new Set([...knowledge[existingIndex].tags, ...entry.tags])],
					successCount: knowledge[existingIndex].successCount + 1,
				};
			} else {
				// Add new entry
				knowledge.push(entry);
			}

			// Keep only the most recent 1000 entries
			if (knowledge.length > 1000) {
				knowledge = knowledge.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime()).slice(0, 1000);
			}

			// Save back to file
			const data = {
				knowledge,
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const tempPath = `${knowledgeFile}.tmp`;
			try {
				// Write to temporary file first
				writeFileSync(tempPath, JSON.stringify(data, null, 2), {
					encoding: "utf-8",
					flag: "w",
				});

				// Atomically rename temporary file to target file
				renameSync(tempPath, knowledgeFile);
			} catch (writeError) {
				// Clean up temporary file if it exists
				if (existsSync(tempPath)) {
					unlinkSync(tempPath);
				}
				throw writeError;
			}
			persistenceLogger.debug({ entryId: entry.id }, "Saved prompt knowledge");
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to save prompt knowledge");
		}
	}

	/**
	 * Load all prompt knowledge entries
	 */
	getPromptKnowledge(): PromptKnowledge[] {
		try {
			const knowledgeFile = this.getPath("prompt-knowledge.json");
			if (!existsSync(knowledgeFile)) {
				return [];
			}

			const data = JSON.parse(readFileSync(knowledgeFile, "utf8"));
			return data.knowledge || [];
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to load prompt knowledge");
			return [];
		}
	}

	/**
	 * Get prompt knowledge filtered by task type
	 */
	getPromptKnowledgeByType(taskType: string): PromptKnowledge[] {
		return this.getPromptKnowledge()
			.filter((k) => k.taskType === taskType)
			.sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Get top N most successful knowledge entries
	 */
	getTopPromptKnowledge(limit: number = 10): PromptKnowledge[] {
		return this.getPromptKnowledge()
			.sort((a, b) => b.successCount - a.successCount)
			.slice(0, limit);
	}

	/**
	 * Get prompt knowledge filtered by tags
	 */
	getPromptKnowledgeByTags(tags: string[]): PromptKnowledge[] {
		return this.getPromptKnowledge()
			.filter((k) => tags.some((tag) => k.tags.includes(tag)))
			.sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Initialize .undercity/ directory
	 *
	 * @param stateDir Optional custom state directory, defaults to .undercity
	 */
	initializeUndercity(stateDir: string = DEFAULT_STATE_DIR): void {
		// Use existing ensureDirectories method
		this.stateDir = stateDir;
		this.ensureDirectories();

		persistenceLogger.info({ stateDir }, "Initialized Undercity state directory");
	}

	// ============== Experiment Storage ==============

	/**
	 * Get experiment storage
	 */
	getExperimentStorage<T>(defaultValue: T): T {
		return this.readJson<T>("experiment-storage.json", defaultValue);
	}

	/**
	 * Save experiment storage
	 */
	saveExperimentStorage<T>(data: T): void {
		this.writeJson("experiment-storage.json", data);
	}

	// ============== Project Profile ==============

	/**
	 * Get project profile
	 */
	getProfile(): ProjectProfile | null {
		const profile = this.readJson<ProjectProfile | null>("profile.json", null);
		return profile;
	}

	/**
	 * Save project profile
	 */
	saveProfile(profile: ProjectProfile): void {
		profile.updatedAt = new Date();
		this.writeJson("profile.json", profile);
	}

	/**
	 * Check if profile exists
	 */
	hasProfile(): boolean {
		return existsSync(this.getPath("profile.json"));
	}
}

// ============== Task Assignment (Work Hook) ==============
// Standalone functions that write to worktree, not .undercity/

import type { TaskAssignment, TaskCheckpoint } from "./types.js";

const ASSIGNMENT_FILENAME = ".undercity-assignment.json";

/**
 * Write task assignment to worktree root.
 * This file lives in the worktree (not .undercity/) so agents can detect their identity.
 */
export function writeTaskAssignment(assignment: TaskAssignment): void {
	const assignmentPath = join(assignment.worktreePath, ASSIGNMENT_FILENAME);

	try {
		// Ensure worktree directory exists
		const dir = dirname(assignmentPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Atomic write via temp file
		const tempPath = `${assignmentPath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(assignment, null, 2), "utf-8");
		renameSync(tempPath, assignmentPath);

		persistenceLogger.debug({ taskId: assignment.taskId, path: assignmentPath }, "Wrote task assignment");
	} catch (error) {
		persistenceLogger.error({ error: String(error), taskId: assignment.taskId }, "Failed to write task assignment");
		throw error;
	}
}

/**
 * Read task assignment from a worktree.
 * Returns null if no assignment exists.
 */
export function readTaskAssignment(worktreePath: string): TaskAssignment | null {
	const assignmentPath = join(worktreePath, ASSIGNMENT_FILENAME);

	if (!existsSync(assignmentPath)) {
		return null;
	}

	try {
		const content = readFileSync(assignmentPath, "utf-8");
		return JSON.parse(content) as TaskAssignment;
	} catch (error) {
		persistenceLogger.warn({ error: String(error), path: assignmentPath }, "Failed to read task assignment");
		return null;
	}
}

/**
 * Update checkpoint in an existing assignment.
 * Used for crash recovery - saves progress without rewriting entire assignment.
 */
export function updateTaskCheckpoint(worktreePath: string, checkpoint: TaskCheckpoint): void {
	const assignment = readTaskAssignment(worktreePath);
	if (!assignment) {
		// Debug level: expected in solo mode (no worktree), only relevant in parallel mode
		persistenceLogger.debug({ worktreePath }, "No assignment found for checkpoint update");
		return;
	}

	assignment.checkpoint = checkpoint;
	writeTaskAssignment(assignment);
}

/**
 * Delete task assignment from worktree (cleanup after completion).
 */
export function deleteTaskAssignment(worktreePath: string): void {
	const assignmentPath = join(worktreePath, ASSIGNMENT_FILENAME);

	if (existsSync(assignmentPath)) {
		try {
			unlinkSync(assignmentPath);
			persistenceLogger.debug({ path: assignmentPath }, "Deleted task assignment");
		} catch (error) {
			persistenceLogger.warn({ error: String(error), path: assignmentPath }, "Failed to delete task assignment");
		}
	}
}

/**
 * Detect if current working directory is a worktree with an assignment.
 * Useful for worker identity detection from path.
 */
export function detectAssignmentFromCwd(): TaskAssignment | null {
	return readTaskAssignment(process.cwd());
}
