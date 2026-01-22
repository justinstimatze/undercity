/**
 * Tests for orchestrator/rebase-helpers.ts
 *
 * Tests rebase operations and conflict resolution helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	abortRebase,
	attemptMergeVerificationFix,
	attemptRebaseConflictResolution,
	buildConflictResolutionPrompt,
	buildVerificationFixPrompt,
	DEFAULT_REBASE_CONFIG,
	getConflictedFiles,
	isRebaseInProgress,
	readConflictDetails,
	rebaseOntoMain,
} from "../orchestrator/rebase-helpers.js";

// Mock node:fs
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
}));

// Mock output
vi.mock("../output.js", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	success: vi.fn(),
}));

// Mock git-utils
vi.mock("../orchestrator/git-utils.js", () => ({
	execGitInDir: vi.fn(),
}));

// Mock claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

describe("orchestrator/rebase-helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("DEFAULT_REBASE_CONFIG", () => {
		it("has expected default values", () => {
			expect(DEFAULT_REBASE_CONFIG).toEqual({
				conflictResolutionModel: "claude-opus-4-5-20251101",
				verificationFixModel: "claude-sonnet-4-20250514",
				conflictResolutionMaxTurns: 10,
				verificationFixMaxTurns: 5,
			});
		});
	});

	describe("abortRebase", () => {
		it("calls git rebase --abort", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("");

			abortRebase("/worktree/path");

			expect(execGitInDir).toHaveBeenCalledWith(["rebase", "--abort"], "/worktree/path");
		});

		it("ignores errors from abort", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockImplementation(() => {
				throw new Error("No rebase in progress");
			});

			// Should not throw
			expect(() => abortRebase("/worktree/path")).not.toThrow();
		});
	});

	describe("isRebaseInProgress", () => {
		it("returns true when REBASE_HEAD exists", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("abc1234");

			const result = isRebaseInProgress("/worktree/path");

			expect(result).toBe(true);
			expect(execGitInDir).toHaveBeenCalledWith(["rev-parse", "--verify", "REBASE_HEAD"], "/worktree/path");
		});

		it("returns false when REBASE_HEAD does not exist", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockImplementation(() => {
				throw new Error("fatal: Needed a single revision");
			});

			const result = isRebaseInProgress("/worktree/path");

			expect(result).toBe(false);
		});
	});

	describe("getConflictedFiles", () => {
		it("returns empty array for clean status", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual([]);
		});

		it("extracts UU (both modified) conflicts", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("UU src/file1.ts\nUU src/file2.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["src/file1.ts", "src/file2.ts"]);
		});

		it("extracts AA (both added) conflicts", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("AA new-file.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["new-file.ts"]);
		});

		it("extracts DU (deleted/modified) conflicts", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("DU deleted-file.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["deleted-file.ts"]);
		});

		it("extracts UD (modified/deleted) conflicts", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("UD modified-file.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["modified-file.ts"]);
		});

		it("ignores non-conflict status lines", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue(" M modified.ts\n?? untracked.ts\nUU conflict.ts\nA  added.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["conflict.ts"]);
		});

		it("handles mixed conflict types", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("UU file1.ts\nAA file2.ts\nDU file3.ts\nUD file4.ts");

			const result = getConflictedFiles("/worktree/path");

			expect(result).toEqual(["file1.ts", "file2.ts", "file3.ts", "file4.ts"]);
		});
	});

	describe("readConflictDetails", () => {
		it("returns empty array when no files provided", async () => {
			const result = readConflictDetails("/worktree/path", []);

			expect(result).toEqual([]);
		});

		it("reads conflict markers from files", async () => {
			const { readFileSync } = await import("node:fs");
			vi.mocked(readFileSync).mockReturnValue(`
<<<<<<< HEAD
const a = 1;
=======
const a = 2;
>>>>>>> feature
`);

			const result = readConflictDetails("/worktree/path", ["file.ts"]);

			expect(result.length).toBe(1);
			expect(result[0]).toContain("--- file.ts ---");
			expect(result[0]).toContain("<<<<<<<");
			expect(result[0]).toContain(">>>>>>>");
		});

		it("skips files without conflict markers", async () => {
			const { readFileSync } = await import("node:fs");
			vi.mocked(readFileSync).mockReturnValue("const a = 1;\n");

			const result = readConflictDetails("/worktree/path", ["file.ts"]);

			expect(result).toEqual([]);
		});

		it("limits number of files read", async () => {
			const { readFileSync } = await import("node:fs");
			vi.mocked(readFileSync).mockReturnValue("<<<<<<< HEAD\n=======\n>>>>>>>\n");

			const files = ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"];
			readConflictDetails("/worktree/path", files, 2);

			expect(readFileSync).toHaveBeenCalledTimes(2);
		});

		it("truncates large file content", async () => {
			const { readFileSync } = await import("node:fs");
			const largeContent = `<<<<<<< HEAD\n${"x".repeat(5000)}\n=======\n>>>>>>>\n`;
			vi.mocked(readFileSync).mockReturnValue(largeContent);

			const result = readConflictDetails("/worktree/path", ["file.ts"], 3, 100);

			// Content should be truncated to maxContentSize
			expect(result[0].length).toBeLessThan(200);
		});

		it("handles file read errors gracefully", async () => {
			const { readFileSync } = await import("node:fs");
			vi.mocked(readFileSync).mockImplementation(() => {
				throw new Error("ENOENT: no such file");
			});

			const result = readConflictDetails("/worktree/path", ["missing.ts"]);

			expect(result).toEqual([]);
		});
	});

	describe("buildConflictResolutionPrompt", () => {
		it("includes conflicted files list", () => {
			const prompt = buildConflictResolutionPrompt(["file1.ts", "file2.ts"], [], "/worktree/path");

			expect(prompt).toContain("file1.ts, file2.ts");
		});

		it("includes conflict details when provided", () => {
			const details = ["--- file1.ts ---\n<<<<<<< HEAD\nconflict\n>>>>>>>\n"];
			const prompt = buildConflictResolutionPrompt(["file1.ts"], details, "/worktree/path");

			expect(prompt).toContain("Conflict details:");
			expect(prompt).toContain("--- file1.ts ---");
		});

		it("includes working directory", () => {
			const prompt = buildConflictResolutionPrompt(["file.ts"], [], "/custom/worktree");

			expect(prompt).toContain("Working directory: /custom/worktree");
		});

		it("includes instructions for resolution", () => {
			const prompt = buildConflictResolutionPrompt(["file.ts"], [], "/worktree");

			expect(prompt).toContain("INSTRUCTIONS:");
			expect(prompt).toContain("git add");
			expect(prompt).toContain("git rebase --continue");
			expect(prompt).toContain("<<<<<<<");
		});
	});

	describe("buildVerificationFixPrompt", () => {
		it("includes error output", () => {
			const prompt = buildVerificationFixPrompt("Type error: Expected string", "/worktree");

			expect(prompt).toContain("Type error: Expected string");
		});

		it("includes working directory", () => {
			const prompt = buildVerificationFixPrompt("Error", "/my/worktree/path");

			expect(prompt).toContain("Working directory: /my/worktree/path");
		});

		it("includes focus instruction", () => {
			const prompt = buildVerificationFixPrompt("Error", "/worktree");

			expect(prompt).toContain("Focus ONLY on fixing the specific errors");
			expect(prompt).toContain("Do not refactor");
		});
	});

	describe("attemptRebaseConflictResolution", () => {
		it("returns false when no conflicted files found", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const outputMock = await import("../output.js");
			vi.mocked(execGitInDir).mockReturnValue(""); // No conflicts

			const result = await attemptRebaseConflictResolution("task-123", "/worktree");

			expect(result).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("No conflicted files found"));
		});

		it("spawns agent when conflicts are found", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");
			const outputMock = await import("../output.js");

			// First call: getConflictedFiles returns conflicts
			// Second call: isRebaseInProgress returns false (resolved)
			vi.mocked(execGitInDir)
				.mockReturnValueOnce("UU conflict.ts") // status --porcelain
				.mockImplementationOnce(() => {
					// rev-parse REBASE_HEAD throws = no longer in rebase
					throw new Error("fatal");
				});

			// Mock async generator
			const messages = [{ type: "result", subtype: "success" }];
			vi.mocked(query).mockReturnValue(
				(async function* () {
					for (const msg of messages) {
						yield msg;
					}
				})(),
			);

			const result = await attemptRebaseConflictResolution("task-123", "/worktree");

			expect(result).toBe(true);
			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						model: "claude-opus-4-5-20251101",
						cwd: "/worktree",
					}),
				}),
			);
			expect(outputMock.info).toHaveBeenCalledWith(expect.stringContaining("Spawning conflict resolution agent"));
		});

		it("returns false when rebase still in progress after agent", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");
			const outputMock = await import("../output.js");

			vi.mocked(execGitInDir)
				.mockReturnValueOnce("UU conflict.ts") // getConflictedFiles
				.mockReturnValueOnce("abc123"); // isRebaseInProgress - still in rebase

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			const result = await attemptRebaseConflictResolution("task-123", "/worktree");

			expect(result).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Rebase still in progress"));
		});

		it("returns false when agent throws error", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");
			const outputMock = await import("../output.js");

			vi.mocked(execGitInDir).mockReturnValueOnce("UU conflict.ts");
			// Create a generator that throws after first iteration
			vi.mocked(query).mockImplementation(() => {
				return (async function* () {
					yield { type: "progress" };
					throw new Error("Agent crashed");
				})();
			});

			const result = await attemptRebaseConflictResolution("task-123", "/worktree");

			expect(result).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Conflict resolution agent failed"));
		});

		it("uses custom config when provided", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");

			vi.mocked(execGitInDir)
				.mockReturnValueOnce("UU conflict.ts")
				.mockImplementationOnce(() => {
					throw new Error("fatal");
				});

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			const customConfig = {
				conflictResolutionModel: "custom-model",
				verificationFixModel: "other-model",
				conflictResolutionMaxTurns: 15,
				verificationFixMaxTurns: 8,
			};

			await attemptRebaseConflictResolution("task-123", "/worktree", customConfig);

			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						model: "custom-model",
						maxTurns: 15,
					}),
				}),
			);
		});
	});

	describe("attemptMergeVerificationFix", () => {
		it("spawns fix agent with error output", async () => {
			const { query } = await import("@anthropic-ai/claude-agent-sdk");
			const outputMock = await import("../output.js");

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			await attemptMergeVerificationFix("task-123", "/worktree", "Type error in file.ts");

			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining("Type error in file.ts"),
					options: expect.objectContaining({
						model: "claude-sonnet-4-20250514",
						maxTurns: 5,
						cwd: "/worktree",
					}),
				}),
			);
			expect(outputMock.info).toHaveBeenCalledWith(expect.stringContaining("Spawning fix agent"));
		});

		it("uses custom config when provided", async () => {
			const { query } = await import("@anthropic-ai/claude-agent-sdk");

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			const customConfig = {
				conflictResolutionModel: "opus",
				verificationFixModel: "custom-fix-model",
				conflictResolutionMaxTurns: 10,
				verificationFixMaxTurns: 3,
			};

			await attemptMergeVerificationFix("task-123", "/worktree", "Error", customConfig);

			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						model: "custom-fix-model",
						maxTurns: 3,
					}),
				}),
			);
		});
	});

	describe("rebaseOntoMain", () => {
		it("performs clean rebase when no conflicts", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue("");

			await rebaseOntoMain("task-123", "/worktree");

			expect(execGitInDir).toHaveBeenCalledWith(["rebase", "FETCH_HEAD"], "/worktree");
		});

		it("attempts conflict resolution on conflict error", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");
			const outputMock = await import("../output.js");

			let rebaseAttempted = false;
			vi.mocked(execGitInDir).mockImplementation((args) => {
				if (args[0] === "rebase" && args[1] === "FETCH_HEAD") {
					rebaseAttempted = true;
					throw new Error("CONFLICT: merge conflict in file.ts");
				}
				if (args[0] === "status") {
					return "UU file.ts";
				}
				if (args[0] === "rev-parse") {
					// After resolution, no longer in rebase
					throw new Error("fatal");
				}
				return "";
			});

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			await rebaseOntoMain("task-123", "/worktree");

			expect(rebaseAttempted).toBe(true);
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Rebase conflict"));
			expect(outputMock.success).toHaveBeenCalledWith(expect.stringContaining("Resolved rebase conflict"));
		});

		it("aborts and throws when conflict resolution fails", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");

			vi.mocked(execGitInDir).mockImplementation((args) => {
				if (args[0] === "rebase" && args[1] === "FETCH_HEAD") {
					throw new Error("could not apply abc123");
				}
				if (args[0] === "status") {
					return ""; // No conflicted files = can't resolve
				}
				return "";
			});

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			await expect(rebaseOntoMain("task-123", "/worktree")).rejects.toThrow("Rebase failed for task-123");

			// Should have attempted to abort
			expect(execGitInDir).toHaveBeenCalledWith(["rebase", "--abort"], "/worktree");
		});

		it("aborts and throws on non-conflict rebase error", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");

			vi.mocked(execGitInDir).mockImplementation((args) => {
				if (args[0] === "rebase" && args[1] === "FETCH_HEAD") {
					throw new Error("fatal: invalid upstream 'FETCH_HEAD'");
				}
				return "";
			});

			await expect(rebaseOntoMain("task-123", "/worktree")).rejects.toThrow("Rebase failed for task-123");
			expect(execGitInDir).toHaveBeenCalledWith(["rebase", "--abort"], "/worktree");
		});

		it("uses custom config for conflict resolution", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const { query } = await import("@anthropic-ai/claude-agent-sdk");

			vi.mocked(execGitInDir).mockImplementation((args) => {
				if (args[0] === "rebase" && args[1] === "FETCH_HEAD") {
					throw new Error("conflict");
				}
				if (args[0] === "status") {
					return "UU file.ts";
				}
				if (args[0] === "rev-parse") {
					throw new Error("fatal");
				}
				return "";
			});

			vi.mocked(query).mockReturnValue(
				(async function* () {
					yield { type: "result", subtype: "success" };
				})(),
			);

			const customConfig = {
				conflictResolutionModel: "custom-model",
				verificationFixModel: "other",
				conflictResolutionMaxTurns: 20,
				verificationFixMaxTurns: 5,
			};

			await rebaseOntoMain("task-123", "/worktree", customConfig);

			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						model: "custom-model",
						maxTurns: 20,
					}),
				}),
			);
		});
	});
});
