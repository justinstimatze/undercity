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
import type {
	AgentType,
	Inventory,
	Loadout,
	Raid,
	SafePocket,
	SquadMember,
	Stash,
	Task,
} from "./types.js";

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
}
