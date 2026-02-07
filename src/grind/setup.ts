/**
 * Grind Setup Module
 *
 * Handles initialization: lock acquisition, cleanup, migration, disk space checks.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import * as output from "../output.js";
import { Persistence } from "../persistence.js";
import type { GrindConfig, GrindOptions } from "./types.js";

const MINIMUM_DISK_SPACE_GB = 2;
const LOCK_FILE = ".undercity/grind.lock";

interface LockInfo {
	pid: number;
	startedAt: string;
}

/**
 * Get the path to the grind lock file
 */
function getGrindLockPath(): string {
	return join(process.cwd(), LOCK_FILE);
}

/**
 * Check if a process is still running
 */
function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire the grind lock to prevent concurrent execution
 */
export function acquireGrindLock(): { acquired: boolean; existingPid?: number; startedAt?: string } {
	const lockPath = getGrindLockPath();

	// Check for existing lock
	if (existsSync(lockPath)) {
		try {
			const lockData = JSON.parse(readFileSync(lockPath, "utf-8")) as LockInfo;
			// Check if the process is still running
			if (isProcessRunning(lockData.pid)) {
				return {
					acquired: false,
					existingPid: lockData.pid,
					startedAt: lockData.startedAt,
				};
			}
			// Stale lock - remove it
			unlinkSync(lockPath);
		} catch {
			// Corrupted lock file - remove it
			try {
				unlinkSync(lockPath);
			} catch {
				// Ignore
			}
		}
	}

	// Create new lock
	const lockInfo: LockInfo = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};

	try {
		writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2));
		return { acquired: true };
	} catch {
		return { acquired: false };
	}
}

/**
 * Release the grind lock
 */
export function releaseGrindLock(): void {
	const lockPath = getGrindLockPath();
	try {
		if (existsSync(lockPath)) {
			unlinkSync(lockPath);
		}
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Set up signal handlers to release lock on exit
 */
export function setupSignalHandlers(cleanup: () => void): void {
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});
}

/**
 * Clean up stale workers from previous crashed sessions
 */
export function cleanupStaleWorkers(): { cleaned: number; taskIds: string[] } {
	const persistence = new Persistence();
	return persistence.cleanupStaleWorkers();
}

/**
 * Run SQLite migration if needed
 */
export async function runMigrationIfNeeded(): Promise<{
	migrated: boolean;
	learnings?: number;
	errorPatterns?: number;
	decisions?: number;
	errors?: string[];
}> {
	const { autoMigrateIfNeeded } = await import("../storage.js");
	const migration = autoMigrateIfNeeded();

	if (migration) {
		return {
			migrated: true,
			learnings: migration.learnings,
			errorPatterns: migration.errorPatterns,
			decisions: migration.decisions,
			errors: migration.errors,
		};
	}

	return { migrated: false };
}

/**
 * Generate embeddings for learnings without them
 */
export async function generateEmbeddings(): Promise<number> {
	const { embedAllLearnings } = await import("../embeddings.js");
	return embedAllLearnings();
}

/**
 * Get available disk space in GB for worktrees directory
 */
export function getWorktreesDiskSpaceGB(): number | null {
	const worktreesDir =
		process.env.UNDERCITY_WORKTREES_DIR || join(process.cwd(), "..", `${process.cwd().split("/").pop()}-worktrees`);

	try {
		// Get the mount point for the worktrees directory (or its parent if it doesn't exist)
		const checkPath = existsSync(worktreesDir) ? worktreesDir : process.cwd();
		const _stats = statSync(checkPath);

		// On Unix-like systems, we can use df command
		const { execSync } = require("node:child_process");
		const dfOutput = execSync(`df -k "${checkPath}"`, { encoding: "utf-8" });
		const lines = dfOutput.trim().split("\n");
		if (lines.length >= 2) {
			const parts = lines[1].split(/\s+/);
			// Available space is typically the 4th column (in KB)
			const availableKB = parseInt(parts[3], 10);
			if (!Number.isNaN(availableKB)) {
				return Math.round((availableKB / 1024 / 1024) * 10) / 10; // Convert to GB with 1 decimal
			}
		}
	} catch {
		// Can't determine disk space
	}

	return null;
}

/**
 * Check if there's enough disk space
 */
export function checkDiskSpace(): { ok: boolean; availableGB: number | null } {
	const availableGB = getWorktreesDiskSpaceGB();

	if (availableGB !== null && availableGB < MINIMUM_DISK_SPACE_GB) {
		return { ok: false, availableGB };
	}

	return { ok: true, availableGB };
}

/**
 * Parse duration string (e.g., "6h", "30m") to milliseconds
 */
export function parseDuration(duration: string): number | null {
	const match = duration.match(/^(\d+)(h|m|s)?$/i);
	if (!match) return null;

	const value = parseInt(match[1], 10);
	const unit = (match[2] || "m").toLowerCase();

	switch (unit) {
		case "h":
			return value * 60 * 60 * 1000;
		case "m":
			return value * 60 * 1000;
		case "s":
			return value * 1000;
		default:
			return null;
	}
}

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: number): string {
	const hours = Math.floor(ms / (60 * 60 * 1000));
	const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

/**
 * Parse CLI options into validated config
 *
 * Merges CLI options with .undercityrc config file values.
 * CLI options (when explicitly set) override config file values.
 */
export function parseGrindOptions(options: GrindOptions): GrindConfig {
	// Load config file (merges home + project .undercityrc)
	const fileConfig = loadConfig();

	const maxCount = parseInt(options.count || "0", 10);
	const parallelism = Math.min(3, Math.max(1, parseInt(options.parallel || String(fileConfig.parallel), 10)));

	// CLI overrides config file, which overrides defaults
	const maxAttempts = options.maxAttempts ? parseInt(options.maxAttempts, 10) : fileConfig.maxAttempts;
	const maxRetriesPerTier = options.maxRetriesPerTier
		? parseInt(options.maxRetriesPerTier, 10)
		: fileConfig.maxRetriesPerTier;
	const maxReviewPassesPerTier = options.maxReviewPasses
		? parseInt(options.maxReviewPasses, 10)
		: fileConfig.maxReviewPassesPerTier;
	const maxOpusReviewPasses = options.maxOpusReviewPasses
		? parseInt(options.maxOpusReviewPasses, 10)
		: fileConfig.maxOpusReviewPasses;
	const maxDecompositionDepth = options.maxDecompositionDepth ? parseInt(options.maxDecompositionDepth, 10) : 1;
	const maxTier = options.maxTier as "sonnet" | "opus" | undefined;

	// Validate maxTier
	if (maxTier && !["sonnet", "opus"].includes(maxTier)) {
		output.error(`Invalid max-tier: ${maxTier}. Must be sonnet or opus`);
		process.exit(1);
	}

	return {
		maxCount,
		parallelism,
		maxAttempts,
		maxRetriesPerTier,
		maxReviewPassesPerTier,
		maxOpusReviewPasses,
		maxDecompositionDepth,
		maxTier,
		startingModel: (options.model || fileConfig.model || "sonnet") as "sonnet" | "opus",
		autoCommit: options.commit !== false && fileConfig.autoCommit !== false,
		stream: options.stream || fileConfig.stream || false,
		verbose: options.verbose || fileConfig.verbose || false,
		reviewPasses: options.review === true || fileConfig.review === true,
		pushOnSuccess: options.push === true || fileConfig.push === true,
		decompose: options.decompose !== false,
		postmortem: options.postmortem !== false,
		dryRun: options.dryRun || false,
		continuous: options.continuous !== undefined && options.continuous !== false,
		continuousFocus: typeof options.continuous === "string" ? options.continuous : undefined,
		duration: options.duration,
		taskId: options.taskId,
		auditBash: fileConfig.auditBash,
		useSystemPromptPreset: fileConfig.useSystemPromptPreset,
		useExtendedContext: fileConfig.useExtendedContext,
		maxBudgetPerTask: fileConfig.maxBudgetPerTask,
	};
}
