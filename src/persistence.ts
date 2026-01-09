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
import { MetricsTracker } from "./metrics.js";
import type {
	AgentType,
	EfficiencyAnalytics,
	ExtendedStash,
	FileTrackingState,
	Inventory,
	Loadout,
	QuestMetrics,
	Raid,
	RateLimitState,
	SafePocket,
	ScoutCache,
	ScoutCacheEntry,
	SquadMember,
	Stash,
	Task,
} from "./types.js";

/** Scout cache configuration */
const SCOUT_CACHE_FILE = "scout-cache.json";
const SCOUT_CACHE_VERSION = "1.0";
const SCOUT_CACHE_MAX_ENTRIES = 100;
const SCOUT_CACHE_TTL_DAYS = 30;

/** Metrics configuration */
const METRICS_VERSION = "1.0";
const EXTENDED_STASH_FILE = "extended-stash.json";

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
	// Active raid state (tasks, squad)

	getInventory(): Inventory {
		return this.readJson<Inventory>("inventory.json", {
			tasks: [],
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

	getTasks(): Task[] {
		return this.getInventory().tasks;
	}

	saveTasks(tasks: Task[]): void {
		const inventory = this.getInventory();
		inventory.tasks = tasks;
		this.saveInventory(inventory);
	}

	addTask(task: Task): void {
		const tasks = this.getTasks();
		tasks.push(task);
		this.saveTasks(tasks);
	}

	updateTask(taskId: string, updates: Partial<Task>): void {
		const tasks = this.getTasks();
		const index = tasks.findIndex((t) => t.id === taskId);
		if (index !== -1) {
			tasks[index] = { ...tasks[index], ...updates };
			this.saveTasks(tasks);
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

	// ============== Extended Stash with Metrics ==============
	// Enhanced stash with quest efficiency metrics

	/**
	 * Get the extended stash with metrics (creates empty one if doesn't exist)
	 */
	getExtendedStash(): ExtendedStash {
		const extendedStash = this.readJson<ExtendedStash>(EXTENDED_STASH_FILE, {
			completedRaids: [],
			questMetrics: [],
			metricsVersion: METRICS_VERSION,
			metricsStartedAt: new Date(),
			lastUpdated: new Date(),
		});

		// Migration: if metrics fields don't exist, initialize them
		if (!extendedStash.questMetrics) {
			extendedStash.questMetrics = [];
			extendedStash.metricsVersion = METRICS_VERSION;
			extendedStash.metricsStartedAt = new Date();
		}

		return extendedStash;
	}

	/**
	 * Save the extended stash with metrics
	 */
	saveExtendedStash(extendedStash: ExtendedStash): void {
		extendedStash.lastUpdated = new Date();
		this.writeJson(EXTENDED_STASH_FILE, extendedStash);
	}

	/**
	 * Save quest metrics to the extended stash
	 */
	saveQuestMetrics(questMetrics: QuestMetrics): void {
		const extendedStash = this.getExtendedStash();
		extendedStash.questMetrics.push(questMetrics);

		// Keep metrics for last 1000 quests to avoid unbounded growth
		if (extendedStash.questMetrics.length > 1000) {
			extendedStash.questMetrics = extendedStash.questMetrics.slice(-1000);
		}

		this.saveExtendedStash(extendedStash);

		persistenceLogger.debug(
			{
				questId: questMetrics.questId,
				tokens: questMetrics.tokenUsage.totalTokens,
				success: questMetrics.success,
				totalMetrics: extendedStash.questMetrics.length
			},
			"Saved quest metrics"
		);
	}

	/**
	 * Get quest metrics for analysis
	 */
	getQuestMetrics(): QuestMetrics[] {
		return this.getExtendedStash().questMetrics;
	}

	/**
	 * Get quest metrics within a date range
	 */
	getQuestMetricsInRange(startDate: Date, endDate: Date): QuestMetrics[] {
		const allMetrics = this.getQuestMetrics();
		return allMetrics.filter(m => {
			const completedAt = new Date(m.completedAt);
			return completedAt >= startDate && completedAt <= endDate;
		});
	}

	/**
	 * Clear all quest metrics (keep raid history)
	 */
	clearQuestMetrics(): void {
		const extendedStash = this.getExtendedStash();
		extendedStash.questMetrics = [];
		extendedStash.metricsStartedAt = new Date();
		this.saveExtendedStash(extendedStash);
		persistenceLogger.info("Cleared all quest metrics");
	}

	/**
	 * Get efficiency analytics from all quest metrics
	 */
	getEfficiencyAnalytics(): EfficiencyAnalytics {
		const questMetrics = this.getQuestMetrics();
		return MetricsTracker.calculateAnalytics(questMetrics);
	}

	/**
	 * Get efficiency analytics for a date range
	 */
	getEfficiencyAnalyticsInRange(startDate: Date, endDate: Date): EfficiencyAnalytics {
		const questMetrics = this.getQuestMetricsInRange(startDate, endDate);
		return MetricsTracker.calculateAnalytics(questMetrics);
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
			tasks: [],
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

	// ============== Rate Limiting ==============
	// Track API usage and rate limit events

	/**
	 * Get rate limit state
	 */
	getRateLimitState(): RateLimitState {
		return this.readJson<RateLimitState>("rate-limits.json", {
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
			lastUpdated: new Date(),
		});
	}

	/**
	 * Save rate limit state
	 */
	saveRateLimitState(state: RateLimitState): void {
		state.lastUpdated = new Date();
		this.writeJson("rate-limits.json", state);
	}

	/**
	 * Clear rate limit state
	 */
	clearRateLimitState(): void {
		this.writeJson<RateLimitState>("rate-limits.json", {
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
			lastUpdated: new Date(),
		});
	}

	// ============== Quest Metrics ==============
	// Track efficiency metrics for completed quests

	/**
	 * Get all quest metrics
	 */
	getQuestMetrics(): QuestMetrics[] {
		return this.readJson<QuestMetrics[]>("quest-metrics.json", []);
	}

	/**
	 * Save quest metrics
	 */
	saveQuestMetrics(metrics: QuestMetrics[]): void {
		this.writeJson("quest-metrics.json", metrics);
	}

	/**
	 * Add a new quest metric
	 */
	addQuestMetric(metric: QuestMetrics): void {
		const metrics = this.getQuestMetrics();
		metrics.push(metric);

		// Keep only last 1000 metrics to prevent unbounded growth
		if (metrics.length > 1000) {
			metrics.splice(0, metrics.length - 1000);
		}

		this.saveQuestMetrics(metrics);
	}

	/**
	 * Clear quest metrics
	 */
	clearQuestMetrics(): void {
		this.saveQuestMetrics([]);
	}

	/**
	 * Get quest metrics for a specific raid
	 */
	getQuestMetricsForRaid(raidId: string): QuestMetrics[] {
		return this.getQuestMetrics().filter(m => m.raidId === raidId);
	}

	/**
	 * Get recent quest metrics (last N days)
	 */
	getRecentQuestMetrics(days = 30): QuestMetrics[] {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		return this.getQuestMetrics().filter(m => new Date(m.startedAt) >= cutoff);
	}
}
