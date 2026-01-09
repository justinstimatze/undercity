/**
 * Persistence Module
 *
 * Handles the persistence hierarchy:
 * - Safe Pocket: Critical state surviving crashes
 * - Inventory: Active raid state
 * - Loadout: Pre-raid config
 * - Stash: Long-term storage between raids
 *
 * All state is stored as JSON files in .undercity/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { persistenceLogger } from "./logger.js";
import type {
	AgentType,
	FileTrackingState,
	Inventory,
	Loadout,
	LoadoutConfiguration,
	LoadoutPerformanceRecord,
	LoadoutScore,
	LoadoutStorage,
	Raid,
	SafePocket,
	ScoutCache,
	ScoutCacheEntry,
	SquadMember,
	Stash,
	Waypoint,
} from "./types.js";

/** Scout cache configuration */
const SCOUT_CACHE_FILE = "scout-cache.json";
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
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path, JSON.stringify(data, null, 2));
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
	getRaid(): Raid | undefined {
		return this.getInventory().raid;
	}

	saveRaid(raid: Raid): void {
		const inventory = this.getInventory();
		inventory.raid = raid;
		this.saveInventory(inventory);

		// Also update pocket with critical info
		this.savePocket({
			raidId: raid.id,
			raidGoal: raid.goal,
			raidStatus: raid.status,
			lastUpdated: new Date(),
		});
	}

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
			enabledAgentTypes: ["scout", "planner", "fabricator", "auditor"] as AgentType[],
			autoApprove: false,
			lastUpdated: new Date(),
		});
	}

	saveLoadout(loadout: Loadout): void {
		loadout.lastUpdated = new Date();
		this.writeJson("loadout.json", loadout);
	}

	// ============== Stash ==============
	// Long-term storage between raids

	getStash(): Stash {
		return this.readJson<Stash>("stash.json", {
			completedRaids: [],
			lastUpdated: new Date(),
		});
	}

	saveStash(stash: Stash): void {
		stash.lastUpdated = new Date();
		this.writeJson("stash.json", stash);
	}

	addCompletedRaid(raid: Raid, success: boolean): void {
		const stash = this.getStash();
		stash.completedRaids.push({
			id: raid.id,
			goal: raid.goal,
			completedAt: new Date(),
			success,
		});
		this.saveStash(stash);
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
		writeFileSync(path, JSON.stringify({ sessionId, savedAt: new Date() }, null, 2));
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

	// ============== Utilities ==============

	/**
	 * Check if there's an active raid (GUPP principle)
	 */
	hasActiveRaid(): boolean {
		const pocket = this.getPocket();
		return pocket.raidId !== undefined && pocket.raidStatus !== "complete" && pocket.raidStatus !== "failed";
	}

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

	// ============== Scout Cache ==============
	// Caches scout results to avoid redundant codebase analysis

	/**
	 * Get the scout cache (creates empty cache if doesn't exist)
	 */
	getScoutCache(): ScoutCache {
		return this.readJson<ScoutCache>(SCOUT_CACHE_FILE, {
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
	}

	/**
	 * Save the scout cache
	 */
	saveScoutCache(cache: ScoutCache): void {
		cache.lastUpdated = new Date();
		this.writeJson(SCOUT_CACHE_FILE, cache);
	}

	/**
	 * Get a scout cache entry by fingerprint and goal hash
	 *
	 * @param fingerprintHash Hash of the codebase fingerprint
	 * @param goalHash Hash of the scout goal
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
			persistenceLogger.warn({ error }, "Error reading scout cache entry");
			return null;
		}
	}

	/**
	 * Save a scout result to the cache
	 *
	 * @param fingerprintHash Hash of the codebase fingerprint
	 * @param goalHash Hash of the scout goal
	 * @param scoutResult The scout intel result to cache
	 * @param goalText Original goal text (for debugging)
	 */
	saveScoutCacheEntry(fingerprintHash: string, goalHash: string, scoutResult: string, goalText: string): void {
		try {
			const cache = this.getScoutCache();
			const key = `${fingerprintHash}:${goalHash}`;

			const entry: ScoutCacheEntry = {
				fingerprintHash,
				goalHash,
				scoutResult,
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

				persistenceLogger.debug({ removed: toRemove }, "Evicted old scout cache entries (LRU)");
			}

			this.saveScoutCache(cache);
			persistenceLogger.debug({ key, goalText }, "Saved scout result to cache");
		} catch (error) {
			persistenceLogger.warn({ error }, "Error saving scout cache entry");
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
				persistenceLogger.info({ removed }, "Cleaned up expired scout cache entries");
			}
		} catch (error) {
			persistenceLogger.warn({ error }, "Error cleaning up scout cache");
		}
	}

	/**
	 * Clear the entire scout cache
	 */
	clearScoutCache(): void {
		this.saveScoutCache({
			entries: {},
			version: SCOUT_CACHE_VERSION,
			lastUpdated: new Date(),
		});
		persistenceLogger.info("Cleared scout cache");
	}

	/**
	 * Get scout cache statistics
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
}
