/**
 * File Tracker Module
 *
 * Tracks file operations per agent for conflict detection during parallel execution.
 *
 * | Feature               | Description                                |
 * |-----------------------|--------------------------------------------|
 * | Operation tracking    | read, write, edit, delete per agent        |
 * | Conflict detection    | multi-agent file overlap identification    |
 * | Pre-spawn checking    | verify file availability before assignment |
 * | Crash recovery        | persisted state in .undercity/             |
 */

import { relative, resolve } from "node:path";
import { getASTIndex } from "./ast-index.js";
import { logger } from "./logger.js";
import type {
	CrossTaskConflict,
	FileConflict,
	FileOperation,
	FileTouch,
	FileTrackingEntry,
	FileTrackingState,
	SemanticConflict,
	SemanticConflictAnalysis,
} from "./types.js";

const trackerLogger = logger.child({ module: "file-tracker" });

/**
 * FileTracker: Parallel agent coordination via file access tracking
 *
 * | Problem         | Solution                                 |
 * |-----------------|------------------------------------------|
 * | Merge conflicts | Record file ops per agent                |
 * | Race conditions | Detect conflicts before they occur       |
 * | Poor assignment | Enable smart task distribution           |
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
	 * Normalize a file path considering the agent's working directory
	 * This handles cases where agents work in worktrees with different base paths
	 */
	private normalizePathForAgent(filePath: string, agentCwd?: string): string {
		// If no agent cwd provided, use standard normalization
		if (!agentCwd) {
			return this.normalizePath(filePath);
		}

		// If path is absolute, make it relative to main repo root
		if (filePath.startsWith("/")) {
			return relative(this.cwd, filePath);
		}

		// If path is relative and agent is in a worktree, resolve it relative to main repo
		if (agentCwd !== this.cwd) {
			// Path is relative to agent's working directory, make it relative to main repo
			const absolutePath = resolve(agentCwd, filePath);
			return relative(this.cwd, absolutePath);
		}

		// Agent is in main repo, use path as-is
		return filePath;
	}

	/**
	 * Start tracking files for an agent
	 */
	startTracking(agentId: string, stepId: string, sessionId: string): void {
		if (this.state.entries[agentId]) {
			trackerLogger.warn({ agentId, stepId }, "Agent already being tracked, overwriting");
		}

		this.state.entries[agentId] = {
			agentId,
			stepId,
			sessionId,
			files: [],
			startedAt: new Date(),
		};
		this.state.lastUpdated = new Date();

		trackerLogger.debug({ agentId, stepId, sessionId }, "Started file tracking");
	}

	/**
	 * Start tracking files for an agent with task context
	 * NEW: Support for task-level tracking
	 */
	startTaskTracking(taskId: string, sessionId: string): void {
		// Use taskId as agentId for task-level tracking
		this.startTracking(taskId, taskId, sessionId);
	}

	/**
	 * Stop tracking files for a task
	 * NEW: Support for task-level tracking
	 */
	stopTaskTracking(taskId: string): void {
		this.stopTracking(taskId);
	}

	/**
	 * Stop tracking files for an agent (when step completes)
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
		taskId?: string,
		agentCwd?: string,
	): void {
		const entry = this.state.entries[agentId];
		if (!entry) {
			trackerLogger.warn({ agentId, filePath, operation }, "Attempted to record file access for untracked agent");
			return;
		}

		// Normalize path considering the agent's working directory
		const normalizedPath = this.normalizePathForAgent(filePath, agentCwd);

		const touch: FileTouch = {
			path: normalizedPath,
			operation,
			timestamp: new Date(),
		};

		entry.files.push(touch);
		this.state.lastUpdated = new Date();

		trackerLogger.debug({ agentId, path: normalizedPath, operation, taskId }, "Recorded file access");

		// Also track at task level if taskId provided
		if (taskId && taskId !== agentId) {
			const taskEntry = this.state.entries[taskId];
			if (taskEntry) {
				taskEntry.files.push({ ...touch });
			}
		}
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
	 * Analyze semantic conflicts using AST-based symbol tracking.
	 * Detects when multiple agents modify the same exported symbols (functions, classes, types)
	 * even if they're in different files.
	 *
	 * @param _excludeAgentId - Optional agent to exclude from conflict check (reserved for future use)
	 * @returns Semantic conflict analysis with detected conflicts
	 *
	 * @example
	 * ```typescript
	 * const tracker = new FileTracker();
	 * tracker.startTracking("agent-1", "step-1", "session-1");
	 * tracker.recordFileAccess("agent-1", "src/utils.ts", "edit");
	 * const analysis = await tracker.analyzeSemanticConflicts();
	 * console.log(`Found ${analysis.conflicts.length} semantic conflicts`);
	 * ```
	 */
	private async analyzeSemanticConflicts(_excludeAgentId?: string): Promise<SemanticConflictAnalysis> {
		const conflicts: SemanticConflict[] = [];
		const writeOps: FileOperation[] = ["write", "edit", "delete"];

		// Try to get AST index, return empty analysis if not available
		let astIndex: ReturnType<typeof getASTIndex> | null = null;
		try {
			astIndex = getASTIndex(this.cwd);
			await astIndex.load();
		} catch (error) {
			trackerLogger.debug({ error: String(error) }, "AST index not available, skipping semantic analysis");
			return {
				conflicts: [],
				analyzedFiles: 0,
				symbolsAnalyzed: 0,
			};
		}

		// Additional safety check
		if (!astIndex) {
			return {
				conflicts: [],
				analyzedFiles: 0,
				symbolsAnalyzed: 0,
			};
		}

		// Build map of file -> agents that modified it
		const fileAgents = new Map<
			string,
			Array<{
				agentId: string;
				stepId: string;
				sessionId: string;
			}>
		>();

		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			// Skip completed agents
			if (entry.endedAt) {
				continue;
			}

			for (const touch of entry.files) {
				if (writeOps.includes(touch.operation)) {
					const existing = fileAgents.get(touch.path) || [];
					// Check if this agent is already recorded for this file
					if (!existing.some((a) => a.agentId === agentId)) {
						existing.push({
							agentId,
							stepId: entry.stepId,
							sessionId: entry.sessionId,
						});
						fileAgents.set(touch.path, existing);
					}
				}
			}
		}

		// Build map of symbol -> agents that touched files exporting that symbol
		const symbolAgents = new Map<
			string,
			{
				kind: "function" | "class" | "interface" | "type" | "const" | "enum";
				files: Set<string>;
				agents: Array<{
					agentId: string;
					stepId: string;
					sessionId: string;
				}>;
			}
		>();

		let analyzedFiles = 0;
		let symbolsAnalyzed = 0;

		for (const [filePath, agents] of fileAgents.entries()) {
			// Get exported symbols from this file
			const exports = astIndex.getFileExports(filePath);
			if (exports.length === 0) {
				continue;
			}

			analyzedFiles++;

			for (const exp of exports) {
				symbolsAnalyzed++;
				const existing = symbolAgents.get(exp.name);

				if (!existing) {
					symbolAgents.set(exp.name, {
						kind: exp.kind,
						files: new Set([filePath]),
						agents: [...agents],
					});
				} else {
					// Add file to the set
					existing.files.add(filePath);

					// Add agents that aren't already tracked
					for (const agent of agents) {
						if (!existing.agents.some((a) => a.agentId === agent.agentId)) {
							existing.agents.push(agent);
						}
					}
				}
			}
		}

		// Identify conflicts: symbols touched by multiple agents
		for (const [symbolName, data] of symbolAgents.entries()) {
			if (data.agents.length > 1) {
				// Determine severity based on number of agents
				let severity: "warning" | "error" | "critical";
				if (data.agents.length >= 3) {
					severity = "critical";
				} else if (data.agents.length === 2) {
					severity = "error";
				} else {
					severity = "warning";
				}

				conflicts.push({
					symbolName,
					symbolKind: data.kind,
					files: Array.from(data.files),
					touchedBy: data.agents,
					severity,
				});
			}
		}

		return {
			conflicts,
			analyzedFiles,
			symbolsAnalyzed,
		};
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
				stepId: string;
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
						stepId: entry.stepId,
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
	wouldConflict(filePaths: string[], agentId?: string): Map<string, string[]> {
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
				if (writeOps.includes(touch.operation) && normalizedPaths.includes(touch.path)) {
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
		return Object.values(this.state.entries).filter((entry) => !entry.endedAt);
	}

	/**
	 * Get the tracking entry for an agent
	 */
	getEntry(agentId: string): FileTrackingEntry | undefined {
		return this.state.entries[agentId];
	}

	/**
	 * Clear tracking for a specific session
	 */
	clearSession(sessionId: string): void {
		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			if (entry.sessionId === sessionId) {
				delete this.state.entries[agentId];
			}
		}
		this.state.lastUpdated = new Date();
		trackerLogger.debug({ sessionId }, "Cleared file tracking for session");
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

		trackerLogger.debug({ clearedCount: before - after, remaining: after }, "Cleared completed tracking entries");
	}

	/**
	 * Get the full state for persistence
	 */
	getState(): FileTrackingState {
		return this.state;
	}

	/**
	 * Detect conflicts between tasks running in parallel
	 * NEW: Cross-task conflict detection
	 */
	detectCrossTaskConflicts(): CrossTaskConflict[] {
		const conflicts: CrossTaskConflict[] = [];
		const writeOps: FileOperation[] = ["write", "edit", "delete"];

		// Group entries by task (session) - active tasks only
		const taskEntries = new Map<string, FileTrackingEntry[]>();
		for (const entry of Object.values(this.state.entries)) {
			if (!entry.endedAt) {
				// Only active entries
				const task = entry.sessionId; // Use sessionId as task identifier
				const existing = taskEntries.get(task) || [];
				existing.push(entry);
				taskEntries.set(task, existing);
			}
		}

		// Check for file conflicts between different tasks
		const fileTaskMap = new Map<string, string[]>(); // file -> task[]

		for (const [taskId, entries] of taskEntries) {
			const taskFiles = new Set<string>();

			// Collect all files touched by this task
			for (const entry of entries) {
				for (const touch of entry.files) {
					if (writeOps.includes(touch.operation)) {
						taskFiles.add(touch.path);
					}
				}
			}

			// Track which tasks touch which files
			for (const file of taskFiles) {
				const existing = fileTaskMap.get(file) || [];
				existing.push(taskId);
				fileTaskMap.set(file, existing);
			}
		}

		// Find files touched by multiple tasks
		for (const [file, tasks] of fileTaskMap) {
			if (tasks.length > 1) {
				conflicts.push({
					taskIds: tasks,
					conflictingFiles: [file],
					severity: "error",
				});
			}
		}

		return conflicts;
	}

	/**
	 * Check if adding a task would cause conflicts
	 * NEW: Pre-flight conflict check for task scheduling
	 */
	wouldTaskConflict(taskId: string, estimatedFiles: string[]): boolean {
		const writeOps: FileOperation[] = ["write", "edit", "delete"];
		const normalizedFiles = estimatedFiles.map((f) => this.normalizePath(f));

		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			// Skip completed entries and the task we're checking
			if (entry.endedAt || agentId === taskId) {
				continue;
			}

			// Check if any estimated files conflict with active work
			for (const touch of entry.files) {
				if (writeOps.includes(touch.operation)) {
					// Simple exact match for now - could be enhanced with glob pattern matching
					if (normalizedFiles.includes(touch.path)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Get files currently being modified by active tasks
	 * NEW: Query active file modifications across all tasks
	 */
	getActiveTaskFiles(): Map<string, string[]> {
		const fileTaskMap = new Map<string, string[]>();
		const writeOps: FileOperation[] = ["write", "edit", "delete"];

		for (const [_agentId, entry] of Object.entries(this.state.entries)) {
			if (entry.endedAt) continue; // Skip completed entries

			for (const touch of entry.files) {
				if (writeOps.includes(touch.operation)) {
					const existing = fileTaskMap.get(touch.path) || [];
					if (!existing.includes(entry.sessionId)) {
						existing.push(entry.sessionId);
						fileTaskMap.set(touch.path, existing);
					}
				}
			}
		}

		return fileTaskMap;
	}

	/**
	 * Detect semantic conflicts across active agents using AST analysis.
	 * This method identifies when multiple agents modify the same exported symbols
	 * (functions, classes, types) even if they're in different files.
	 *
	 * @returns Promise resolving to semantic conflict analysis
	 *
	 * @example
	 * ```typescript
	 * const tracker = new FileTracker();
	 * tracker.startTracking("agent-1", "step-1", "session-1");
	 * tracker.recordFileAccess("agent-1", "src/types.ts", "edit");
	 * tracker.startTracking("agent-2", "step-2", "session-2");
	 * tracker.recordFileAccess("agent-2", "src/index.ts", "edit");
	 *
	 * const analysis = await tracker.detectSemanticConflicts();
	 * if (analysis.conflicts.length > 0) {
	 *   console.log(`Found ${analysis.conflicts.length} semantic conflicts`);
	 *   for (const conflict of analysis.conflicts) {
	 *     console.log(`Symbol ${conflict.symbolName} (${conflict.symbolKind}) in ${conflict.files.join(", ")}`);
	 *   }
	 * }
	 * ```
	 */
	async detectSemanticConflicts(): Promise<SemanticConflictAnalysis> {
		return this.analyzeSemanticConflicts();
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
		const completedAgents = Object.keys(this.state.entries).length - activeAgents;

		let _totalFilesTouched = 0;
		const allFiles = new Set<string>();

		for (const entry of Object.values(this.state.entries)) {
			for (const touch of entry.files) {
				allFiles.add(touch.path);
			}
			_totalFilesTouched += entry.files.length;
		}

		const conflicts = this.detectConflicts();

		return {
			activeAgents,
			completedAgents,
			totalFilesTouched: allFiles.size,
			filesWithConflicts: conflicts.length,
		};
	}

	/**
	 * Clear tracking for all tasks except specified ones
	 * NEW: Support for selective task cleanup
	 */
	clearInactiveTasks(activeTaskIds: string[]): void {
		const activeSessionIds = new Set(activeTaskIds);

		for (const [agentId, entry] of Object.entries(this.state.entries)) {
			if (!activeSessionIds.has(entry.sessionId) && entry.endedAt) {
				delete this.state.entries[agentId];
			}
		}

		this.state.lastUpdated = new Date();
		trackerLogger.debug({ activeTasks: activeTaskIds.length }, "Cleared inactive task tracking");
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
