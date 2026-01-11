/**
 * Persistence Module
 *
 * Handles the persistence hierarchy:
 * - Safe Pocket: Critical state surviving crashes
 * - Inventory: Active session state (waypoints, squad)
 * - Loadout: Pre-session config
 *
 * All state is stored as JSON files in .undercity/
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { persistenceLogger } from "./logger.js";
import type {
	AgentType,
	EfficiencyOutcome,
	FileTrackingState,
	FluteCache,
	FluteCacheEntry,
	Inventory,
	Loadout,
	LoadoutConfiguration,
	LoadoutPerformanceRecord,
	LoadoutScore,
	LoadoutStorage,
	ParallelRecoveryState,
	PromptKnowledge,
	QuestMetrics,
	RateLimitState,
	SafePocket,
	SquadMember,
	Waypoint,
	WorktreeInfo,
	WorktreeState,
} from "./types.js";

/** Flute cache configuration */
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

	// ============== Safe Pocket ==============
	// Critical state that survives crashes

	getPocket(): SafePocket {
		return this.readJson<SafePocket>("pocket.json", {
			lastUpdated: new Date(),
		});
	}

	savePocket(pocket: SafePocket): void {
		pocket.lastUpdated = new Date();
		this.writeJson("pocket.json", pocket);
	}

	clearPocket(): void {
		this.writeJson<SafePocket>("pocket.json", {
			lastUpdated: new Date(),
		});
	}

	// ============== Inventory ==============
	// Active raid state (waypoints, squad)

	getInventory(): Inventory {
		return this.readJson<Inventory>("inventory.json", {
			waypoints: [],
			squad: [],
			lastUpdated: new Date(),
		});
	}

	saveInventory(inventory: Inventory): void {
		inventory.lastUpdated = new Date();
		this.writeJson("inventory.json", inventory);
	}

	// Convenience methods for inventory
	getTasks(): Waypoint[] {
		return this.getInventory().waypoints;
	}

	saveTasks(waypoints: Waypoint[]): void {
		const inventory = this.getInventory();
		inventory.waypoints = waypoints;
		this.saveInventory(inventory);
	}

	addTask(waypoint: Waypoint): void {
		const waypoints = this.getTasks();
		waypoints.push(waypoint);
		this.saveTasks(waypoints);
	}

	updateTask(waypointId: string, updates: Partial<Waypoint>): void {
		const waypoints = this.getTasks();
		const index = waypoints.findIndex((t) => t.id === waypointId);
		if (index !== -1) {
			waypoints[index] = { ...waypoints[index], ...updates };
			this.saveTasks(waypoints);
		}
	}

	getSquad(): SquadMember[] {
		return this.getInventory().squad;
	}

	saveSquad(squad: SquadMember[]): void {
		const inventory = this.getInventory();
		inventory.squad = squad;
		this.saveInventory(inventory);
	}

	addSquadMember(member: SquadMember): void {
		const squad = this.getSquad();
		squad.push(member);
		this.saveSquad(squad);
	}

	updateSquadMember(memberId: string, updates: Partial<SquadMember>): void {
		const squad = this.getSquad();
		const index = squad.findIndex((m) => m.id === memberId);
		if (index !== -1) {
			squad[index] = { ...squad[index], ...updates };
			this.saveSquad(squad);
		}
	}

	removeSquadMember(memberId: string): void {
		const squad = this.getSquad().filter((m) => m.id !== memberId);
		this.saveSquad(squad);
	}

	// ============== Loadout ==============
	// Pre-raid configuration

	getLoadout(): Loadout {
		return this.readJson<Loadout>("loadout.json", {
			maxSquadSize: 5,
			enabledAgentTypes: ["flute", "logistics", "quester", "sheriff"] as AgentType[],
			autoApprove: false,
			lastUpdated: new Date(),
		});
	}

	saveLoadout(loadout: Loadout): void {
		loadout.lastUpdated = new Date();
		this.writeJson("loadout.json", loadout);
	}

	// ============== Loadout Configurations ==============
	// Configurable loadouts for different quest types

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

	getSquadMemberSession(memberId: string): string | undefined {
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

	saveSquadMemberSession(memberId: string, sessionId: string): void {
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
	// Track active worktrees for raid isolation

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
		state.worktrees[worktreeInfo.raidId] = worktreeInfo;
		this.saveWorktreeState(state);
	}

	removeWorktree(raidId: string): void {
		const state = this.getWorktreeState();
		delete state.worktrees[raidId];
		this.saveWorktreeState(state);
	}

	getWorktreeForRaid(raidId: string): WorktreeInfo | null {
		const state = this.getWorktreeState();
		return state.worktrees[raidId] || null;
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
		this.clearPocket();
		this.saveInventory({
			waypoints: [],
			squad: [],
			lastUpdated: new Date(),
		});
	}

	// ============== Flute Cache ==============
	// Caches flute results to avoid redundant codebase analysis

	/**
	 * Get the flute cache (creates empty cache if doesn't exist)
	 */
	getFluteCache(): FluteCache {
		return this.readJson<FluteCache>(FLUTE_CACHE_FILE, {
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
	}

	/**
	 * Save the flute cache
	 */
	saveFluteCache(cache: FluteCache): void {
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
	getFluteCacheEntry(fingerprintHash: string, goalHash: string): FluteCacheEntry | null {
		try {
			const cache = this.getFluteCache();
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
				persistenceLogger.debug({ key, ageMs, ttlMs }, "Flute cache entry expired");
				return null;
			}

			// Update last used timestamp
			entry.lastUsedAt = new Date();
			cache.entries[key] = entry;
			this.saveFluteCache(cache);

			persistenceLogger.debug({ key, goalText: entry.goalText }, "Flute cache hit");
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
	saveFluteCacheEntry(fingerprintHash: string, goalHash: string, fluteResult: string, goalText: string): void {
		try {
			const cache = this.getFluteCache();
			const key = `${fingerprintHash}:${goalHash}`;

			const entry: FluteCacheEntry = {
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

			this.saveFluteCache(cache);
			persistenceLogger.debug({ key, goalText }, "Saved flute result to cache");
		} catch (error) {
			persistenceLogger.warn({ error }, "Error saving flute cache entry");
			// Silent failure - caching is optional
		}
	}

	/**
	 * Clean up expired cache entries
	 */
	cleanupFluteCache(): void {
		try {
			const cache = this.getFluteCache();
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
				this.saveFluteCache(cache);
				persistenceLogger.info({ removed }, "Cleaned up expired flute cache entries");
			}
		} catch (error) {
			persistenceLogger.warn({ error }, "Error cleaning up flute cache");
		}
	}

	/**
	 * Clear the entire flute cache
	 */
	clearFluteCache(): void {
		this.saveFluteCache({
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
		persistenceLogger.info("Cleared flute cache");
	}

	/**
	 * Get flute cache statistics
	 */
	getFluteCacheStats(): { entryCount: number; oldestEntry: Date | null; newestEntry: Date | null } {
		const cache = this.getFluteCache();
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

	// ============== Efficiency Tracking ==============

	/**
	 * Save efficiency outcome to storage
	 */
	saveEfficiencyOutcome(outcome: EfficiencyOutcome): void {
		try {
			const outcomesFile = this.getPath("efficiency-outcomes.json");
			let outcomes: EfficiencyOutcome[] = [];

			// Load existing outcomes
			if (existsSync(outcomesFile)) {
				const data = JSON.parse(readFileSync(outcomesFile, "utf8"));
				outcomes = data.outcomes || [];
			}

			// Add new outcome
			outcomes.push(outcome);

			// Keep only the most recent 1000 outcomes to prevent file size growth
			if (outcomes.length > 1000) {
				outcomes = outcomes.slice(-1000);
			}

			// Save back to file
			const data = {
				outcomes,
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const tempPath = `${outcomesFile}.tmp`;
			try {
				// Write to temporary file first
				writeFileSync(tempPath, JSON.stringify(data, null, 2), {
					encoding: "utf-8",
					flag: "w",
				});

				// Atomically rename temporary file to target file
				renameSync(tempPath, outcomesFile);
			} catch (writeError) {
				// Clean up temporary file if it exists
				if (existsSync(tempPath)) {
					unlinkSync(tempPath);
				}
				throw writeError;
			}
			persistenceLogger.debug({ outcomeId: outcome.id }, "Saved efficiency outcome");
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to save efficiency outcome");
		}
	}

	/**
	 * Load all efficiency outcomes
	 */
	getEfficiencyOutcomes(): EfficiencyOutcome[] {
		try {
			const outcomesFile = this.getPath("efficiency-outcomes.json");
			if (!existsSync(outcomesFile)) {
				return [];
			}

			const data = JSON.parse(readFileSync(outcomesFile, "utf8"));
			return data.outcomes || [];
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to load efficiency outcomes");
			return [];
		}
	}

	/**
	 * Get efficiency outcomes filtered by experiment ID
	 */
	getEfficiencyOutcomesByExperiment(experimentId: string): EfficiencyOutcome[] {
		return this.getEfficiencyOutcomes().filter((o) => o.experimentId === experimentId);
	}

	/**
	 * Get efficiency outcomes filtered by parallelism level
	 */
	getEfficiencyOutcomesByParallelism(parallelismLevel: string): EfficiencyOutcome[] {
		return this.getEfficiencyOutcomes().filter((o) => o.parallelismLevel === parallelismLevel);
	}

	// ============== Rate Limit Tracking ==============

	/**
	 * Get rate limit state
	 */
	getRateLimitState(): RateLimitState | null {
		try {
			return this.readJson<RateLimitState>("rate-limit-state.json", {
				quests: [],
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

	// ============== Quest Metrics ==============

	/**
	 * Save quest metrics
	 */
	saveQuestMetrics(metrics: QuestMetrics): void {
		try {
			const metricsFile = this.getPath("quest-metrics.json");
			let existingMetrics: QuestMetrics[] = [];

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
			persistenceLogger.debug({ questId: metrics.questId }, "Saved quest metrics");
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to save quest metrics");
		}
	}

	/**
	 * Load all quest metrics
	 */
	getQuestMetrics(): QuestMetrics[] {
		try {
			const metricsFile = this.getPath("quest-metrics.json");
			if (!existsSync(metricsFile)) {
				return [];
			}

			const data = JSON.parse(readFileSync(metricsFile, "utf8"));
			return data.metrics || [];
		} catch (error) {
			persistenceLogger.error({ error: String(error) }, "Failed to load quest metrics");
			return [];
		}
	}

	/**
	 * Get quest metrics filtered by raid ID
	 */
	getQuestMetricsByRaid(raidId: string): QuestMetrics[] {
		return this.getQuestMetrics().filter((m) => m.raidId === raidId);
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
}
