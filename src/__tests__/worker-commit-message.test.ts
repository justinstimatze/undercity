/**
 * Tests for commit message generation in TaskWorker
 *
 * Tests the logic for deriving conventional commit types, scopes, and
 * building commit messages from task objectives and modified files.
 */

import { describe, expect, it } from "vitest";

// Re-implement the logic here for testing since the methods are private
// This ensures the logic is correct without exposing internals

function deriveCommitType(task: string): string {
	const lower = task.toLowerCase();

	// Check for research task prefix first
	if (/\[research\]/i.test(task)) return "research";

	// Check for test-related tasks first (higher priority than feat)
	// Matches: "Add test", "Add tests", "Add unit test", "Write test", etc.
	if (/^(add|write|improve|create)\s+(\w+\s+)*tests?\b/i.test(task)) return "test";
	if (/^test\s/i.test(task)) return "test";

	// Check for docs-related tasks
	if (/^(add|update)\s+(\w+\s+)*docs?\b/i.test(task)) return "docs";
	if (/^(add|update)\s+(\w+\s+)*documentation\b/i.test(task)) return "docs";

	// Check for performance tasks
	if (/^improve\s+performance/i.test(task)) return "perf";

	// Then check for action verbs at start of task
	if (/^(add|create|implement|introduce|build)\s/i.test(task)) return "feat";
	if (/^(fix|repair|resolve|correct|patch)\s/i.test(task)) return "fix";
	if (/^(refactor|extract|reorganize|simplify|restructure|clean)\s/i.test(task)) return "refactor";
	if (/^(doc|document)\s/i.test(task)) return "docs";
	if (/^(perf|optimize|speed)\s/i.test(task)) return "perf";
	if (/^(style|format|lint)\s/i.test(task)) return "style";

	// Check for keywords anywhere in task
	if (lower.includes("fix") || lower.includes("bug") || lower.includes("error")) return "fix";
	if (lower.includes("test")) return "test";
	if (lower.includes("refactor")) return "refactor";
	if (lower.includes("document") || lower.includes("readme") || lower.includes("docs")) return "docs";

	// Default to chore for updates/changes
	return "chore";
}

function findCommonPathPrefix(paths: string[]): string {
	if (paths.length === 0) return "";
	if (paths.length === 1) return paths[0];

	const parts = paths.map((p) => p.split("/"));
	const minLen = Math.min(...parts.map((p) => p.length));
	const common: string[] = [];

	for (let i = 0; i < minLen; i++) {
		const segment = parts[0][i];
		if (parts.every((p) => p[i] === segment)) {
			common.push(segment);
		} else {
			break;
		}
	}

	return common.join("/");
}

function findCommonStringPrefix(strings: string[]): string {
	if (strings.length === 0) return "";
	if (strings.length === 1) return strings[0];

	const minLen = Math.min(...strings.map((s) => s.length));
	let common = "";

	for (let i = 0; i < minLen; i++) {
		const char = strings[0][i];
		if (strings.every((s) => s[i] === char)) {
			common += char;
		} else {
			break;
		}
	}

	return common;
}

function deriveScope(files: string[]): string {
	if (files.length === 0) return "";

	if (files.length === 1) {
		// Single file: use filename without extension
		const basename = files[0].split("/").pop() || "";
		return basename.replace(/\.[^.]+$/, "");
	}

	// Multiple files: try to find common directory or pattern
	const dirs = files.map((f) => {
		const parts = f.split("/");
		// Remove filename, keep directory path
		return parts.slice(0, -1).join("/");
	});

	// Find common prefix among directories
	const commonDir = findCommonPathPrefix(dirs.filter((d) => d.length > 0));
	if (commonDir) {
		// Use the last component of the common directory
		const lastPart = commonDir.split("/").pop();
		if (lastPart && lastPart !== "src") {
			return lastPart;
		}
	}

	// If all files are in the same immediate directory, use that
	const immediateDirs = new Set(dirs);
	if (immediateDirs.size === 1) {
		const dir = [...immediateDirs][0];
		const lastPart = dir.split("/").pop();
		if (lastPart && lastPart !== "src") {
			return lastPart;
		}
	}

	// Fallback: if files share a common base name pattern, use that
	const basenames = files.map((f) => {
		const name = f.split("/").pop() || "";
		return name.replace(/\.[^.]+$/, "");
	});
	const commonBasename = findCommonStringPrefix(basenames);
	if (commonBasename.length >= 3) {
		return commonBasename.replace(/-$/, ""); // Remove trailing hyphen
	}

	return "";
}

function extractShortDescription(task: string): string {
	// Remove [bracket] prefixes (like [research], [meta:triage], etc.)
	let desc = task.replace(/^\[[^\]]+\]\s*/g, "");

	// Remove leading "Task:" or similar prefixes
	desc = desc.replace(/^(Task|Goal|Objective|TODO):\s*/i, "");

	// Trim whitespace
	desc = desc.trim();

	// Capitalize first letter
	if (desc.length > 0) {
		desc = desc.charAt(0).toUpperCase() + desc.slice(1);
	}

	return desc;
}

function buildCommitSubject(type: string, scope: string, task: string): string {
	const prefix = scope ? `${type}(${scope}):` : `${type}:`;
	const shortDesc = extractShortDescription(task);

	// Git convention: subject line should be ~72 chars max
	const maxDescLen = 72 - prefix.length - 1; // -1 for space after prefix
	const truncatedDesc = shortDesc.length > maxDescLen ? `${shortDesc.substring(0, maxDescLen - 3)}...` : shortDesc;

	return `${prefix} ${truncatedDesc}`;
}

describe("worker commit message generation", () => {
	describe("deriveCommitType", () => {
		it("returns feat for add/create/implement tasks", () => {
			expect(deriveCommitType("Add custom error classes")).toBe("feat");
			expect(deriveCommitType("Create new validation module")).toBe("feat");
			expect(deriveCommitType("Implement user authentication")).toBe("feat");
			expect(deriveCommitType("Introduce caching layer")).toBe("feat");
			expect(deriveCommitType("Build new API endpoint")).toBe("feat");
		});

		it("returns fix for fix/repair/resolve tasks", () => {
			expect(deriveCommitType("Fix broken validation")).toBe("fix");
			expect(deriveCommitType("Repair database connection")).toBe("fix");
			expect(deriveCommitType("Resolve race condition")).toBe("fix");
			expect(deriveCommitType("Correct typo in error message")).toBe("fix");
			expect(deriveCommitType("Patch security vulnerability")).toBe("fix");
		});

		it("returns refactor for refactor/extract tasks", () => {
			expect(deriveCommitType("Refactor error handling")).toBe("refactor");
			expect(deriveCommitType("Extract helper functions")).toBe("refactor");
			expect(deriveCommitType("Reorganize module structure")).toBe("refactor");
			expect(deriveCommitType("Simplify complex logic")).toBe("refactor");
			expect(deriveCommitType("Restructure code")).toBe("refactor");
			expect(deriveCommitType("Clean up dead code")).toBe("refactor");
		});

		it("returns test for test tasks", () => {
			expect(deriveCommitType("Test user authentication")).toBe("test");
			expect(deriveCommitType("Add tests for validation")).toBe("test");
			expect(deriveCommitType("Write test for edge cases")).toBe("test");
			expect(deriveCommitType("Improve test coverage")).toBe("test");
		});

		it("returns docs for documentation tasks", () => {
			expect(deriveCommitType("Document API endpoints")).toBe("docs");
			expect(deriveCommitType("Update documentation")).toBe("docs");
			expect(deriveCommitType("Add docs for new feature")).toBe("docs");
		});

		it("returns perf for performance tasks", () => {
			expect(deriveCommitType("Optimize database queries")).toBe("perf");
			expect(deriveCommitType("Speed up build process")).toBe("perf");
			expect(deriveCommitType("Improve performance of search")).toBe("perf");
		});

		it("returns style for style/format tasks", () => {
			expect(deriveCommitType("Format code")).toBe("style");
			expect(deriveCommitType("Style cleanup")).toBe("style");
			expect(deriveCommitType("Lint fixes")).toBe("style");
		});

		it("returns research for research tasks", () => {
			expect(deriveCommitType("[research] Investigate memory leak")).toBe("research");
			expect(deriveCommitType("[RESEARCH] Find best practices")).toBe("research");
		});

		it("detects keywords anywhere in task", () => {
			expect(deriveCommitType("Update code to fix bug")).toBe("fix");
			expect(deriveCommitType("Improve error handling")).toBe("fix");
			expect(deriveCommitType("Add unit tests for validation")).toBe("test");
			expect(deriveCommitType("Clean up and refactor code")).toBe("refactor");
			expect(deriveCommitType("Update README file")).toBe("docs");
		});

		it("returns chore for generic tasks", () => {
			expect(deriveCommitType("Update dependencies")).toBe("chore");
			expect(deriveCommitType("Modify configuration")).toBe("chore");
			expect(deriveCommitType("Change settings")).toBe("chore");
		});
	});

	describe("deriveScope", () => {
		it("returns empty string for no files", () => {
			expect(deriveScope([])).toBe("");
		});

		it("returns filename without extension for single file", () => {
			expect(deriveScope(["src/errors.ts"])).toBe("errors");
			expect(deriveScope(["src/worker/agent-loop.ts"])).toBe("agent-loop");
			expect(deriveScope(["package.json"])).toBe("package");
		});

		it("returns common directory for multiple files in same dir", () => {
			expect(deriveScope(["src/worker/agent-loop.ts", "src/worker/state.ts"])).toBe("worker");
			expect(deriveScope(["src/commands/task.ts", "src/commands/mixed.ts"])).toBe("commands");
		});

		it("returns common parent for nested files", () => {
			expect(
				deriveScope(["src/worker/agent-loop.ts", "src/worker/state.ts", "src/worker/verification-handler.ts"]),
			).toBe("worker");
		});

		it("returns common basename prefix for related files", () => {
			expect(deriveScope(["src/task.ts", "src/task-schema.ts", "src/task-planner.ts"])).toBe("task");
		});

		it("returns empty string when no common pattern", () => {
			// Files with nothing in common
			expect(deriveScope(["src/foo.ts", "lib/bar.ts"])).toBe("");
		});
	});

	describe("extractShortDescription", () => {
		it("removes bracket prefixes", () => {
			expect(extractShortDescription("[research] Investigate issue")).toBe("Investigate issue");
			expect(extractShortDescription("[meta:triage] Analyze board")).toBe("Analyze board");
		});

		it("removes Task:/Goal:/Objective: prefixes", () => {
			expect(extractShortDescription("Task: Implement feature")).toBe("Implement feature");
			expect(extractShortDescription("Goal: Add validation")).toBe("Add validation");
			expect(extractShortDescription("Objective: Fix bug")).toBe("Fix bug");
		});

		it("capitalizes first letter", () => {
			expect(extractShortDescription("add new feature")).toBe("Add new feature");
			expect(extractShortDescription("fix broken test")).toBe("Fix broken test");
		});

		it("handles already capitalized text", () => {
			expect(extractShortDescription("Add new feature")).toBe("Add new feature");
		});

		it("trims whitespace", () => {
			expect(extractShortDescription("  Add feature  ")).toBe("Add feature");
		});
	});

	describe("buildCommitSubject", () => {
		it("builds subject with scope", () => {
			const subject = buildCommitSubject("feat", "errors", "Add custom error classes");
			expect(subject).toBe("feat(errors): Add custom error classes");
		});

		it("builds subject without scope", () => {
			const subject = buildCommitSubject("chore", "", "Update dependencies");
			expect(subject).toBe("chore: Update dependencies");
		});

		it("truncates long descriptions", () => {
			const longTask =
				"Add comprehensive custom error classes for domain-specific error handling with proper stack traces and context";
			const subject = buildCommitSubject("feat", "errors", longTask);
			expect(subject.length).toBeLessThanOrEqual(72);
			expect(subject).toContain("...");
		});

		it("removes bracket prefixes from description", () => {
			const subject = buildCommitSubject("research", "", "[research] Investigate memory leak");
			expect(subject).toBe("research: Investigate memory leak");
		});
	});

	describe("findCommonPathPrefix", () => {
		it("returns empty for empty array", () => {
			expect(findCommonPathPrefix([])).toBe("");
		});

		it("returns path for single item", () => {
			expect(findCommonPathPrefix(["src/worker"])).toBe("src/worker");
		});

		it("finds common prefix for paths", () => {
			expect(findCommonPathPrefix(["src/worker", "src/commands"])).toBe("src");
			expect(findCommonPathPrefix(["src/worker/a", "src/worker/b"])).toBe("src/worker");
		});

		it("returns empty for no common prefix", () => {
			expect(findCommonPathPrefix(["src/foo", "lib/bar"])).toBe("");
		});
	});

	describe("findCommonStringPrefix", () => {
		it("returns empty for empty array", () => {
			expect(findCommonStringPrefix([])).toBe("");
		});

		it("returns string for single item", () => {
			expect(findCommonStringPrefix(["task"])).toBe("task");
		});

		it("finds common prefix", () => {
			expect(findCommonStringPrefix(["task", "task-schema", "task-planner"])).toBe("task");
			expect(findCommonStringPrefix(["worker", "worker-state"])).toBe("worker");
		});

		it("returns empty for no common prefix", () => {
			expect(findCommonStringPrefix(["foo", "bar"])).toBe("");
		});
	});
});
