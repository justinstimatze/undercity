/**
 * File Tracker Module
 *
 * Tracks which files each agent (quester/raider) is touching during a raid.
 * This enables conflict detection when running parallel fabricators.
 *
 * Key features:
 * - Track file operations (read, write, edit, delete) per agent
 * - Detect conflicts when multiple agents touch the same file
 * - Support for checking conflicts before spawning parallel agents
 * - Persisted state for crash recovery
 */

import { relative } from "node:path";
import { logger } from "./logger.js";
import type {
	FileConflict,
	FileOperation,
	FileTouch,
	FileTrackingEntry,
	FileTrackingState,
} from "./types.js";

const trackerLogger = logger.child({ module: "file-tracker" });

/**
 * FileTracker manages file access tracking for parallel agent coordination.
 *
 * When multiple fabricators work in parallel, they may attempt to modify
 * the same files, leading to merge conflicts. This tracker:
 *
 * 1. Records every file operation per agent
 * 2. Detects potential conflicts before they happen
 * 3. Enables smart task assignment to avoid overlapping file access
 */
export class FileTracker {
	private state: FileTrackingState;
	private cwd: string;

	constructor(initialState?: FileTrackingState, cwd?: string) {
		this.state = initialState ?? {
			entries: {},
			lastUpdated: new Date(),
		};
		this.cwd = cwd ?? process.cwd();
	}

	/**
	 * Normalize a file path to be relative to cwd for consistent tracking
	 */
	private normalizePath(filePath: string): string {
		// If already relative, use as-is
		if (!filePath.startsWith("/")) {
			return filePath;
		}
		// Convert absolute path to relative
		return relative(this.cwd, filePath);
	}

	/**
	 * Start tracking files for an agent
	 */
	startTracking(agentId: string, taskId: string, raidId: string): void {
		if (this.state.entries[agentId]) {
			trackerLogger.warn(
				{ agentId, taskId },
				"Agent already being tracked, overwriting",
			);
		}

		this.state.entries[agentId] = {
			agentId,
			taskId,
			raidId,
			files: [],
			startedAt: new Date(),
		};
		this.state.lastUpdated = new Date();

		trackerLogger.debug({ agentId, taskId, raidId }, "Started file tracking");
	}

	/**
	 * Stop tracking files for an agent (when task completes)
	 */
	stopTracking(agentId: string): void {
		const entry = this.state.entries[agentId];
		if (entry) {
			entry.endedAt = new Date();
			this.state.lastUpdated = new Date();
			trackerLogger.debug(
				{
					agentId,
					filesTracked: entry.files.length,
					uniqueFiles: new Set(entry.files.map((f) => f.path)).size,
				},
				"Stopped file tracking",
			);
		}
	}

	/**
	 * Record a file operation by an agent
	 */
	recordFileAccess(
		agentId: string,
		filePath: string,
		operation: FileOperation,
	): void {
		const entry = this.state.entries[agentId];
		if (!entry) {
			trackerLogger.warn(
				{ agentId, filePath, operation },
				"Attempted to record file access for untracked agent",
			);
			return;
		}

		const normalizedPath = this.normalizePath(filePath);

		const touch: FileTouch = {
			path: normalizedPath,
			operation,
			timestamp: new Date(),
		};

		entry.files.push(touch);
		this.state.lastUpdated = new Date();

		trackerLogger.debug(
			{ agentId, path: normalizedPath, operation },
			"Recorded file access",
		);
	}

	/**
	 * Get all files touched by an agent (with write operations)
	 * These are the files that could cause conflicts
	 */
	getModifiedFiles(agentId: string): string[] {
		const entry = this.state.entries[agentId];
		if (!entry) {
			return [];
		}

		const writeOps: FileOperation[] = ["write", "edit", "delete"];
		const modifiedPaths = new Set<string>();

		for (const touch of entry.files) {
			if (writeOps.includes(touch.operation)) {
				modifiedPaths.add(touch.path);
			}
		}

		return Array.from(modifiedPaths);
	}

	/**
	 * Get all files touched by an agent (any operation)
	 */
	getAllTouchedFiles(agentId: string): string[] {
		const entry = this.state.entries[agentId];
		if (!entry) {
			return [];
		}

		const paths = new Set<string>();
		for (const touch of entry.files) {
			paths.add(touch.path);
		}

		return Array.from(paths);
	}

	/**
	 * Check for conflicts between active agents
	 *
	 * A conflict occurs when multiple agents have modified (write/edit/delete)
	 * the same file. Read-only access doesn't cause conflicts.
	 *
	 * @param excludeAgentId - Optional agent to exclude from conflict check
	 *                         (useful when checking if a new agent would conflict)
	 * @returns Array of file conflicts with details
	 */
	detectConflicts(excludeAgentId?: string): FileConflict[] {
		const conflicts: FileConflict[] = [];
		const writeOps: FileOperation[] = ["write", "edit", "delete"];

		// Build a map of file -> agents that modified it
		const fileModifiers = new Map<
			string,
			Array<{
				agentId: string;
				taskId: string;
				operation: FileOperation;
				timestamp: Date;
			}>
		>();

		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			// Skip excluded agent
			if (excludeAgentId && agentId === excludeAgentId) {
				continue;
			}

			// Skip completed agents (they're done, conflicts are resolved via merge)
			if (entry.endedAt) {
				continue;
			}

			for (const touch of entry.files) {
				if (writeOps.includes(touch.operation)) {
					const existing = fileModifiers.get(touch.path) ?? [];
					existing.push({
						agentId,
						taskId: entry.taskId,
						operation: touch.operation,
						timestamp: touch.timestamp,
					});
					fileModifiers.set(touch.path, existing);
				}
			}
		}

		// Find files with multiple modifiers
		for (const [path, modifiers] of fileModifiers) {
			if (modifiers.length > 1) {
				conflicts.push({
					path,
					touchedBy: modifiers,
				});
			}
		}

		return conflicts;
	}

	/**
	 * Check if a set of files would conflict with currently active agents
	 *
	 * Use this before spawning a new agent to check if the files it might
	 * touch would overlap with work already in progress.
	 *
	 * @param filePaths - Files the new agent is expected to touch
	 * @param agentId - Optional: the agent ID to exclude from check
	 * @returns Conflicting files and which agents are working on them
	 */
	wouldConflict(
		filePaths: string[],
		agentId?: string,
	): Map<string, string[]> {
		const result = new Map<string, string[]>();
		const writeOps: FileOperation[] = ["write", "edit", "delete"];

		const normalizedPaths = filePaths.map((p) => this.normalizePath(p));

		for (const [currentAgentId, entry] of Object.entries(this.state.entries)) {
			// Skip the agent we're checking for
			if (agentId && currentAgentId === agentId) {
				continue;
			}

			// Skip completed agents
			if (entry.endedAt) {
				continue;
			}

			// Check if any of the files overlap
			for (const touch of entry.files) {
				if (
					writeOps.includes(touch.operation) &&
					normalizedPaths.includes(touch.path)
				) {
					const existing = result.get(touch.path) ?? [];
					if (!existing.includes(currentAgentId)) {
						existing.push(currentAgentId);
						result.set(touch.path, existing);
					}
				}
			}
		}

		return result;
	}

	/**
	 * Get active (non-completed) tracking entries
	 */
	getActiveEntries(): FileTrackingEntry[] {
		return Object.values(this.state.entries).filter(
			(entry) => !entry.endedAt,
		);
	}

	/**
	 * Get the tracking entry for an agent
	 */
	getEntry(agentId: string): FileTrackingEntry | undefined {
		return this.state.entries[agentId];
	}

	/**
	 * Clear tracking for a specific raid
	 */
	clearRaid(raidId: string): void {
		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			if (entry.raidId === raidId) {
				delete this.state.entries[agentId];
			}
		}
		this.state.lastUpdated = new Date();
		trackerLogger.debug({ raidId }, "Cleared file tracking for raid");
	}

	/**
	 * Clear all completed entries (cleanup)
	 */
	clearCompleted(): void {
		const before = Object.keys(this.state.entries).length;

		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			if (entry.endedAt) {
				delete this.state.entries[agentId];
			}
		}

		const after = Object.keys(this.state.entries).length;
		this.state.lastUpdated = new Date();

		trackerLogger.debug(
			{ clearedCount: before - after, remaining: after },
			"Cleared completed tracking entries",
		);
	}

	/**
	 * Get the full state for persistence
	 */
	getState(): FileTrackingState {
		return this.state;
	}

	/**
	 * Get a summary of current tracking status
	 */
	getSummary(): {
		activeAgents: number;
		completedAgents: number;
		totalFilesTouched: number;
		filesWithConflicts: number;
	} {
		const activeAgents = this.getActiveEntries().length;
		const completedAgents =
			Object.keys(this.state.entries).length - activeAgents;

		let totalFilesTouched = 0;
		const allFiles = new Set<string>();

		for (const entry of Object.values(this.state.entries)) {
			for (const touch of entry.files) {
				allFiles.add(touch.path);
			}
			totalFilesTouched += entry.files.length;
		}

		const conflicts = this.detectConflicts();

		return {
			activeAgents,
			completedAgents,
			totalFilesTouched: allFiles.size,
			filesWithConflicts: conflicts.length,
		};
	}
}

/**
 * Parse SDK tool messages to extract file operations
 *
 * This function analyzes Claude SDK messages to detect file operations
 * and return them in a normalized format for tracking.
 *
 * @param message - The SDK message (tool_use content block)
 * @returns File operation details or null if not a file operation
 */
export function parseFileOperation(message: unknown): {
	path: string;
	operation: FileOperation;
} | null {
	const msg = message as Record<string, unknown>;

	// Handle tool_use content blocks
	if (msg.type !== "tool_use") {
		return null;
	}

	const toolName = msg.name as string;
	const input = msg.input as Record<string, unknown> | undefined;

	if (!input) {
		return null;
	}

	// Map tool names to operations
	switch (toolName) {
		case "Read":
			if (typeof input.file_path === "string") {
				return { path: input.file_path, operation: "read" };
			}
			break;

		case "Write":
			if (typeof input.file_path === "string") {
				return { path: input.file_path, operation: "write" };
			}
			break;

		case "Edit":
			if (typeof input.file_path === "string") {
				return { path: input.file_path, operation: "edit" };
			}
			break;

		case "Bash": {
			// Parse bash commands for file operations
			const command = input.command as string | undefined;
			if (command) {
				// Detect rm/delete commands
				if (command.match(/\brm\s+(-[rf]+\s+)?/)) {
					// Extract file paths from rm command (simplified)
					const match = command.match(/\brm\s+(?:-[rf]+\s+)?(.+)/);
					if (match) {
						const path = match[1].trim().split(/\s+/)[0];
						if (path && !path.startsWith("-")) {
							return { path, operation: "delete" };
						}
					}
				}

				// Detect file creation/write via redirect
				if (command.includes(">") || command.includes(">>")) {
					const match = command.match(/>\s*(.+?)(?:\s|$)/);
					if (match) {
						return { path: match[1].trim(), operation: "write" };
					}
				}
			}
			break;
		}
	}

	return null;
}
