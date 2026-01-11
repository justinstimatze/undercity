/**
 * File Tracker Module Tests
 *
 * Tests for tracking file operations per agent and detecting conflicts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FileTracker, parseFileOperation } from "../file-tracker.js";
import type { FileTrackingState } from "../types.js";

describe("FileTracker", () => {
	let tracker: FileTracker;

	beforeEach(() => {
		tracker = new FileTracker();
	});

	describe("startTracking", () => {
		it("creates a new tracking entry for an agent", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");

			const entry = tracker.getEntry("agent-1");
			expect(entry).toBeDefined();
			expect(entry?.agentId).toBe("agent-1");
			expect(entry?.stepId).toBe("step-1");
			expect(entry?.sessionId).toBe("session-1");
			expect(entry?.files).toEqual([]);
			expect(entry?.startedAt).toBeInstanceOf(Date);
			expect(entry?.endedAt).toBeUndefined();
		});

		it("overwrites existing entry if tracking same agent", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "file.ts", "write");

			tracker.startTracking("agent-1", "step-2", "session-1");

			const entry = tracker.getEntry("agent-1");
			expect(entry?.stepId).toBe("step-2");
			expect(entry?.files).toEqual([]);
		});
	});

	describe("stopTracking", () => {
		it("marks entry as ended", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.stopTracking("agent-1");

			const entry = tracker.getEntry("agent-1");
			expect(entry?.endedAt).toBeInstanceOf(Date);
		});

		it("handles stopping non-existent agent gracefully", () => {
			// Should not throw
			tracker.stopTracking("non-existent");
		});
	});

	describe("recordFileAccess", () => {
		it("records file operations for an agent", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");

			tracker.recordFileAccess("agent-1", "src/file.ts", "read");
			tracker.recordFileAccess("agent-1", "src/file.ts", "write");
			tracker.recordFileAccess("agent-1", "src/other.ts", "edit");

			const entry = tracker.getEntry("agent-1");
			expect(entry?.files).toHaveLength(3);
			expect(entry?.files[0].path).toBe("src/file.ts");
			expect(entry?.files[0].operation).toBe("read");
			expect(entry?.files[1].operation).toBe("write");
			expect(entry?.files[2].path).toBe("src/other.ts");
		});

		it("normalizes absolute paths to relative", () => {
			const customCwd = "/home/user/project";
			tracker = new FileTracker(undefined, customCwd);
			tracker.startTracking("agent-1", "step-1", "session-1");

			tracker.recordFileAccess("agent-1", "/home/user/project/src/file.ts", "write");

			const entry = tracker.getEntry("agent-1");
			expect(entry?.files[0].path).toBe("src/file.ts");
		});

		it("handles untracked agent gracefully", () => {
			// Should not throw
			tracker.recordFileAccess("non-existent", "file.ts", "write");
		});
	});

	describe("getModifiedFiles", () => {
		it("returns only files with write operations", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "read-only.ts", "read");
			tracker.recordFileAccess("agent-1", "written.ts", "write");
			tracker.recordFileAccess("agent-1", "edited.ts", "edit");
			tracker.recordFileAccess("agent-1", "deleted.ts", "delete");
			tracker.recordFileAccess("agent-1", "another-read.ts", "read");

			const modified = tracker.getModifiedFiles("agent-1");

			expect(modified).toHaveLength(3);
			expect(modified).toContain("written.ts");
			expect(modified).toContain("edited.ts");
			expect(modified).toContain("deleted.ts");
			expect(modified).not.toContain("read-only.ts");
		});

		it("returns unique file paths", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "file.ts", "write");
			tracker.recordFileAccess("agent-1", "file.ts", "write");
			tracker.recordFileAccess("agent-1", "file.ts", "edit");

			const modified = tracker.getModifiedFiles("agent-1");
			expect(modified).toHaveLength(1);
			expect(modified).toContain("file.ts");
		});

		it("returns empty array for unknown agent", () => {
			expect(tracker.getModifiedFiles("non-existent")).toEqual([]);
		});
	});

	describe("getAllTouchedFiles", () => {
		it("returns all files including reads", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "read.ts", "read");
			tracker.recordFileAccess("agent-1", "write.ts", "write");

			const all = tracker.getAllTouchedFiles("agent-1");

			expect(all).toHaveLength(2);
			expect(all).toContain("read.ts");
			expect(all).toContain("write.ts");
		});
	});

	describe("detectConflicts", () => {
		it("detects conflicts when multiple agents modify same file", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");

			tracker.recordFileAccess("agent-1", "shared.ts", "write");
			tracker.recordFileAccess("agent-2", "shared.ts", "edit");

			const conflicts = tracker.detectConflicts();

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].path).toBe("shared.ts");
			expect(conflicts[0].touchedBy).toHaveLength(2);
			expect(conflicts[0].touchedBy.map((t) => t.agentId)).toContain("agent-1");
			expect(conflicts[0].touchedBy.map((t) => t.agentId)).toContain("agent-2");
		});

		it("does not report conflicts for read-only access", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");

			tracker.recordFileAccess("agent-1", "file.ts", "read");
			tracker.recordFileAccess("agent-2", "file.ts", "read");

			const conflicts = tracker.detectConflicts();
			expect(conflicts).toHaveLength(0);
		});

		it("excludes specified agent from conflict check", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");

			tracker.recordFileAccess("agent-1", "file.ts", "write");
			tracker.recordFileAccess("agent-2", "file.ts", "write");

			const conflicts = tracker.detectConflicts("agent-1");

			// Only agent-2 is considered, so no conflict (single modifier)
			expect(conflicts).toHaveLength(0);
		});

		it("excludes completed agents from conflict detection", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");

			tracker.recordFileAccess("agent-1", "file.ts", "write");
			tracker.recordFileAccess("agent-2", "file.ts", "write");

			tracker.stopTracking("agent-1");

			const conflicts = tracker.detectConflicts();

			// agent-1 is completed, so no conflict
			expect(conflicts).toHaveLength(0);
		});

		it("reports multiple conflicts", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");

			tracker.recordFileAccess("agent-1", "file1.ts", "write");
			tracker.recordFileAccess("agent-2", "file1.ts", "write");
			tracker.recordFileAccess("agent-1", "file2.ts", "edit");
			tracker.recordFileAccess("agent-2", "file2.ts", "edit");

			const conflicts = tracker.detectConflicts();

			expect(conflicts).toHaveLength(2);
			expect(conflicts.map((c) => c.path)).toContain("file1.ts");
			expect(conflicts.map((c) => c.path)).toContain("file2.ts");
		});
	});

	describe("wouldConflict", () => {
		it("checks if files would conflict with active agents", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "existing.ts", "write");

			const conflicts = tracker.wouldConflict(["existing.ts", "new.ts"]);

			expect(conflicts.size).toBe(1);
			expect(conflicts.get("existing.ts")).toEqual(["agent-1"]);
		});

		it("excludes specified agent from check", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "file.ts", "write");

			const conflicts = tracker.wouldConflict(["file.ts"], "agent-1");

			expect(conflicts.size).toBe(0);
		});

		it("excludes completed agents", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "file.ts", "write");
			tracker.stopTracking("agent-1");

			const conflicts = tracker.wouldConflict(["file.ts"]);

			expect(conflicts.size).toBe(0);
		});
	});

	describe("getActiveEntries", () => {
		it("returns only non-completed entries", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");
			tracker.stopTracking("agent-1");

			const active = tracker.getActiveEntries();

			expect(active).toHaveLength(1);
			expect(active[0].agentId).toBe("agent-2");
		});
	});

	describe("clearSession", () => {
		it("removes all entries for a specific session", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");
			tracker.startTracking("agent-3", "step-3", "session-2");

			tracker.clearSession("session-1");

			expect(tracker.getEntry("agent-1")).toBeUndefined();
			expect(tracker.getEntry("agent-2")).toBeUndefined();
			expect(tracker.getEntry("agent-3")).toBeDefined();
		});
	});

	describe("clearCompleted", () => {
		it("removes only completed entries", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");
			tracker.stopTracking("agent-1");

			tracker.clearCompleted();

			expect(tracker.getEntry("agent-1")).toBeUndefined();
			expect(tracker.getEntry("agent-2")).toBeDefined();
		});
	});

	describe("getSummary", () => {
		it("returns accurate tracking summary", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.startTracking("agent-2", "step-2", "session-1");
			tracker.recordFileAccess("agent-1", "file1.ts", "write");
			tracker.recordFileAccess("agent-1", "file2.ts", "read");
			tracker.recordFileAccess("agent-2", "file1.ts", "edit");
			tracker.stopTracking("agent-1");

			const summary = tracker.getSummary();

			expect(summary.activeAgents).toBe(1);
			expect(summary.completedAgents).toBe(1);
			expect(summary.totalFilesTouched).toBe(2); // file1.ts and file2.ts
			expect(summary.filesWithConflicts).toBe(0); // agent-1 is completed
		});
	});

	describe("getState", () => {
		it("returns the full state for persistence", () => {
			tracker.startTracking("agent-1", "step-1", "session-1");
			tracker.recordFileAccess("agent-1", "file.ts", "write");

			const state = tracker.getState();

			expect(state.entries).toBeDefined();
			expect(state.entries["agent-1"]).toBeDefined();
			expect(state.lastUpdated).toBeInstanceOf(Date);
		});
	});

	describe("initialization with state", () => {
		it("restores state from persistence", () => {
			const savedState: FileTrackingState = {
				entries: {
					"agent-1": {
						agentId: "agent-1",
						stepId: "step-1",
						sessionId: "session-1",
						files: [{ path: "file.ts", operation: "write", timestamp: new Date() }],
						startedAt: new Date(),
					},
				},
				lastUpdated: new Date(),
			};

			tracker = new FileTracker(savedState);

			const entry = tracker.getEntry("agent-1");
			expect(entry).toBeDefined();
			expect(entry?.files).toHaveLength(1);
			expect(entry?.files[0].path).toBe("file.ts");
		});
	});
});

describe("parseFileOperation", () => {
	it("parses Read tool operations", () => {
		const message = {
			type: "tool_use",
			name: "Read",
			input: { file_path: "/path/to/file.ts" },
		};

		const result = parseFileOperation(message);

		expect(result).toEqual({
			path: "/path/to/file.ts",
			operation: "read",
		});
	});

	it("parses Write tool operations", () => {
		const message = {
			type: "tool_use",
			name: "Write",
			input: { file_path: "/path/to/file.ts", content: "..." },
		};

		const result = parseFileOperation(message);

		expect(result).toEqual({
			path: "/path/to/file.ts",
			operation: "write",
		});
	});

	it("parses Edit tool operations", () => {
		const message = {
			type: "tool_use",
			name: "Edit",
			input: { file_path: "/path/to/file.ts", old_string: "a", new_string: "b" },
		};

		const result = parseFileOperation(message);

		expect(result).toEqual({
			path: "/path/to/file.ts",
			operation: "edit",
		});
	});

	it("parses Bash rm commands", () => {
		const message = {
			type: "tool_use",
			name: "Bash",
			input: { command: "rm -rf /path/to/file.ts" },
		};

		const result = parseFileOperation(message);

		expect(result).toEqual({
			path: "/path/to/file.ts",
			operation: "delete",
		});
	});

	it("parses Bash redirect commands", () => {
		const message = {
			type: "tool_use",
			name: "Bash",
			input: { command: "echo 'content' > output.txt" },
		};

		const result = parseFileOperation(message);

		expect(result).toEqual({
			path: "output.txt",
			operation: "write",
		});
	});

	it("returns null for non-file operations", () => {
		const message = {
			type: "tool_use",
			name: "Bash",
			input: { command: "npm install" },
		};

		const result = parseFileOperation(message);

		expect(result).toBeNull();
	});

	it("returns null for non-tool_use messages", () => {
		const message = {
			type: "text",
			content: "Hello",
		};

		const result = parseFileOperation(message);

		expect(result).toBeNull();
	});

	it("returns null when no input provided", () => {
		const message = {
			type: "tool_use",
			name: "Read",
		};

		const result = parseFileOperation(message);

		expect(result).toBeNull();
	});
});
