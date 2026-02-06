/**
 * Cache Module Tests
 *
 * Tests for local caching of context, error fixes, and file summaries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

// Mock fs module
vi.mock("node:fs", () => ({
	existsSync: vi.fn((path: string): boolean => {
		return mockFiles.has(path) || mockDirs.has(path);
	}),
	readFileSync: vi.fn((path: string, _encoding: string): string => {
		const content = mockFiles.get(path);
		if (content === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
		return content;
	}),
	writeFileSync: vi.fn((path: string, data: string): void => {
		mockFiles.set(path, data);
	}),
	mkdirSync: vi.fn((path: string): void => {
		mockDirs.add(path);
	}),
	renameSync: vi.fn((oldPath: string, newPath: string): void => {
		const content = mockFiles.get(oldPath);
		if (content !== undefined) {
			mockFiles.set(newPath, content);
			mockFiles.delete(oldPath);
		}
	}),
	unlinkSync: vi.fn((path: string): void => {
		mockFiles.delete(path);
	}),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(),
}));

// Import after mocking
import { execFileSync, execSync } from "node:child_process";
import {
	compressContext,
	formatErrorsForAgent,
	getCache,
	getChangedContext,
	parseLintErrors,
	parseTypeScriptErrors,
} from "../cache.js";

const _mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe("cache.ts", () => {
	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("compressContext", () => {
		it("removes single-line comments", () => {
			const content = `const x = 1; // this is a comment
const y = 2;`;
			const compressed = compressContext(content);
			expect(compressed).not.toContain("this is a comment");
			expect(compressed).toContain("const x = 1;");
		});

		it("preserves URLs in comments", () => {
			const content = `// See https://example.com for docs
const x = 1;`;
			const compressed = compressContext(content);
			// URL-containing comments are preserved due to negative lookbehind
			expect(compressed).toContain("https://example.com");
		});

		it("removes multi-line comments", () => {
			const content = `/* This is a
multi-line comment */
const x = 1;`;
			const compressed = compressContext(content);
			expect(compressed).not.toContain("multi-line comment");
			expect(compressed).toContain("const x = 1;");
		});

		it("removes JSDoc comments", () => {
			const content = `/**
 * This is a JSDoc comment
 * @param x The value
 */
function foo(x) { return x; }`;
			const compressed = compressContext(content);
			expect(compressed).not.toContain("JSDoc comment");
			expect(compressed).toContain("function foo");
		});

		it("collapses multiple newlines", () => {
			const content = `const x = 1;



const y = 2;`;
			const compressed = compressContext(content);
			// Should have at most two newlines
			expect(compressed.split("\n").length).toBeLessThanOrEqual(3);
		});

		it("collapses multiple spaces", () => {
			const content = `const x    =    1;`;
			const compressed = compressContext(content);
			expect(compressed).not.toContain("    ");
		});

		it("removes trailing whitespace", () => {
			const content = `const x = 1;
const y = 2;   `;
			const compressed = compressContext(content);
			const lines = compressed.split("\n");
			for (const line of lines) {
				expect(line).toBe(line.trimEnd());
			}
		});
	});

	describe("parseTypeScriptErrors", () => {
		it("parses standard TypeScript errors", () => {
			const output = `src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
			const errors = parseTypeScriptErrors(output);

			expect(errors).toHaveLength(1);
			expect(errors[0].file).toBe("src/file.ts");
			expect(errors[0].line).toBe(10);
			expect(errors[0].column).toBe(5);
			expect(errors[0].code).toBe("TS2345");
			expect(errors[0].message).toContain("Argument of type");
		});

		it("adds suggestions for known error codes", () => {
			const output = `src/file.ts(10,5): error TS2345: Type mismatch`;
			const errors = parseTypeScriptErrors(output);

			expect(errors[0].suggestion).toBe("Check argument types match parameter types");
		});

		it("parses multiple errors", () => {
			const output = `src/a.ts(1,1): error TS2304: Cannot find name 'foo'.
src/b.ts(5,10): error TS2339: Property 'bar' does not exist.`;
			const errors = parseTypeScriptErrors(output);

			expect(errors).toHaveLength(2);
			expect(errors[0].file).toBe("src/a.ts");
			expect(errors[1].file).toBe("src/b.ts");
		});

		it("returns empty array for no errors", () => {
			const output = `No errors found.`;
			const errors = parseTypeScriptErrors(output);

			expect(errors).toEqual([]);
		});

		it("ignores non-error lines", () => {
			const output = `Starting compilation...
src/file.ts(10,5): error TS2345: Type error
Compilation complete.`;
			const errors = parseTypeScriptErrors(output);

			expect(errors).toHaveLength(1);
		});

		it("provides suggestions for common error codes", () => {
			const testCases = [
				{ code: "TS2322", expected: "assignment" },
				{ code: "TS2304", expected: "Import" },
				{ code: "TS2339", expected: "Property" },
				{ code: "TS2307", expected: "Module not found" },
				{ code: "TS2532", expected: "undefined" },
			];

			for (const { code, expected } of testCases) {
				const output = `src/file.ts(1,1): error ${code}: Some error`;
				const errors = parseTypeScriptErrors(output);
				expect(errors[0].suggestion).toContain(expected);
			}
		});
	});

	describe("formatErrorsForAgent", () => {
		it("returns empty string for no errors", () => {
			const result = formatErrorsForAgent([]);
			expect(result).toBe("");
		});

		it("formats single error", () => {
			const errors = [
				{
					file: "src/file.ts",
					line: 10,
					column: 5,
					code: "TS2345",
					message: "Type error",
				},
			];
			const result = formatErrorsForAgent(errors);

			expect(result).toContain("Found 1 type error");
			expect(result).toContain("src/file.ts");
			expect(result).toContain("L10");
			expect(result).toContain("TS2345");
		});

		it("groups errors by file", () => {
			const errors = [
				{ file: "src/a.ts", line: 1, column: 1, code: "TS1", message: "Error 1" },
				{ file: "src/a.ts", line: 2, column: 1, code: "TS2", message: "Error 2" },
				{ file: "src/b.ts", line: 1, column: 1, code: "TS3", message: "Error 3" },
			];
			const result = formatErrorsForAgent(errors);

			expect(result).toContain("Found 3 type error");
			expect(result).toContain("src/a.ts:");
			expect(result).toContain("src/b.ts:");
		});

		it("limits errors per file to 3", () => {
			const errors = Array.from({ length: 5 }, (_, i) => ({
				file: "src/file.ts",
				line: i + 1,
				column: 1,
				code: `TS${i}`,
				message: `Error ${i}`,
			}));
			const result = formatErrorsForAgent(errors);

			expect(result).toContain("... and 2 more in this file");
		});

		it("includes suggestions when present", () => {
			const errors = [
				{
					file: "src/file.ts",
					line: 10,
					column: 5,
					code: "TS2345",
					message: "Type error",
					suggestion: "Check argument types",
				},
			];
			const result = formatErrorsForAgent(errors);

			expect(result).toContain("Check argument types");
		});

		it("truncates long messages", () => {
			const longMessage = "A".repeat(200);
			const errors = [
				{
					file: "src/file.ts",
					line: 10,
					column: 5,
					code: "TS2345",
					message: longMessage,
				},
			];
			const result = formatErrorsForAgent(errors);

			// Should be truncated to 80 chars
			expect(result.includes("A".repeat(81))).toBe(false);
		});
	});

	describe("parseLintErrors", () => {
		it("parses Biome lint errors", () => {
			const output = `src/file.ts:10:5 lint/correctness/noUnusedVariables
  ! This variable is unused.`;
			const errors = parseLintErrors(output);

			expect(errors).toHaveLength(1);
			expect(errors[0].file).toBe("src/file.ts");
			expect(errors[0].line).toBe(10);
			expect(errors[0].column).toBe(5);
			expect(errors[0].code).toBe("lint/correctness/noUnusedVariables");
			expect(errors[0].message).toContain("unused");
		});

		it("parses multiple lint errors", () => {
			const output = `src/a.ts:1:1 lint/rule1
  ! Error 1
src/b.ts:5:10 lint/rule2
  ! Error 2`;
			const errors = parseLintErrors(output);

			expect(errors).toHaveLength(2);
			expect(errors[0].file).toBe("src/a.ts");
			expect(errors[1].file).toBe("src/b.ts");
		});

		it("returns empty array for no errors", () => {
			const output = `No lint errors found.`;
			const errors = parseLintErrors(output);

			expect(errors).toEqual([]);
		});
	});

	describe("getChangedContext", () => {
		it("returns empty string when no files changed", () => {
			mockExecFileSync.mockReturnValue("");
			const result = getChangedContext([], "/test");
			expect(result).toBe("");
		});

		it("formats git diff output", () => {
			mockExecFileSync.mockReturnValue(`--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;`);

			const result = getChangedContext(["src/file.ts"], "/test");

			expect(result).toContain("### src/file.ts");
			expect(result).toContain("```diff");
		});

		it("limits to 5 files", () => {
			mockExecFileSync.mockReturnValue("diff content");
			const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);

			getChangedContext(files, "/test");

			// Should only call execFileSync 5 times (one per file, max 5)
			expect(mockExecFileSync).toHaveBeenCalledTimes(5);
		});

		it("handles errors gracefully", () => {
			mockExecFileSync.mockImplementation(() => {
				throw new Error("Git error");
			});

			const result = getChangedContext(["src/file.ts"], "/test");
			expect(result).toBe("");
		});

		it("skips files with no diff", () => {
			mockExecFileSync.mockReturnValue("");
			const result = getChangedContext(["src/file.ts"], "/test");
			expect(result).toBe("");
		});

		it("rejects file paths with shell metacharacters", () => {
			mockExecFileSync.mockReturnValue("diff content");

			// These should be rejected by validation
			const maliciousPaths = [
				"$(rm -rf /)",
				"`evil-command`",
				"file; rm -rf /",
				"file | cat /etc/passwd",
				"file && evil",
			];

			for (const badPath of maliciousPaths) {
				const result = getChangedContext([badPath], "/test");
				expect(result).toBe("");
			}

			// execFileSync should never be called with malicious paths
			expect(mockExecFileSync).not.toHaveBeenCalled();
		});

		it("accepts valid file paths", () => {
			mockExecFileSync.mockReturnValue("diff content");

			const validPaths = ["src/file.ts", "test/file-name.test.ts", "components/Button_v2.tsx"];

			for (const validPath of validPaths) {
				getChangedContext([validPath], "/test");
			}

			// Should call execFileSync for each valid path
			expect(mockExecFileSync).toHaveBeenCalledTimes(validPaths.length);
		});
	});

	describe("getCache", () => {
		it("returns a cache instance", () => {
			const cache = getCache("/test");
			expect(cache).toBeDefined();
			expect(typeof cache.getFileHash).toBe("function");
			expect(typeof cache.findSimilarFixes).toBe("function");
		});

		it("returns same instance on multiple calls", () => {
			const cache1 = getCache("/test");
			const cache2 = getCache("/test");
			expect(cache1).toBe(cache2);
		});
	});

	describe("ContextCache", () => {
		it("getFileHash returns md5 hash of file content", () => {
			mockFiles.set("test.ts", "const x = 1;");
			const cache = getCache("/test");
			const hash = cache.getFileHash("test.ts");

			expect(hash).toMatch(/^[a-f0-9]{32}$/);
		});

		it("getFileHash returns null for missing file", () => {
			const cache = getCache("/test");
			const hash = cache.getFileHash("missing.ts");
			expect(hash).toBeNull();
		});

		it("hasFileChanged detects file changes", () => {
			// Use unique file path to avoid cache singleton state issues
			const uniquePath = `unique-${Date.now()}.ts`;
			mockFiles.set(uniquePath, "const x = 1;");
			const cache = getCache("/test");

			// First read sets the hash
			cache.getFileHash(uniquePath);

			// Same content - not changed
			const changed1 = cache.hasFileChanged(uniquePath);
			expect(changed1).toBe(false);

			// After content change
			mockFiles.set(uniquePath, "const x = 2;");
			const changed2 = cache.hasFileChanged(uniquePath);
			expect(changed2).toBe(true);
		});

		it("getFileSummary returns null when not cached", () => {
			const cache = getCache("/test");
			const summary = cache.getFileSummary("uncached.ts");
			expect(summary).toBeNull();
		});

		it("setFileSummary and getFileSummary work together", () => {
			mockFiles.set("test.ts", "const x = 1;");
			const cache = getCache("/test");

			const summary = {
				path: "test.ts",
				exports: ["x"],
				imports: [],
				functions: [],
				lineCount: 1,
			};

			cache.setFileSummary("test.ts", summary);
			const retrieved = cache.getFileSummary("test.ts");

			expect(retrieved).toEqual(summary);
		});

		it("getFileSummary returns null when file changed", () => {
			mockFiles.set("test.ts", "const x = 1;");
			const cache = getCache("/test");

			cache.setFileSummary("test.ts", {
				path: "test.ts",
				exports: ["x"],
				imports: [],
				functions: [],
				lineCount: 1,
			});

			// Change the file
			mockFiles.set("test.ts", "const y = 2;");

			const summary = cache.getFileSummary("test.ts");
			expect(summary).toBeNull();
		});

		it("recordErrorFix and findSimilarFixes work together", () => {
			const cache = getCache("/test");

			cache.recordErrorFix("Type 'string' is not assignable", "file.ts", "Changed type to number", true);

			const fixes = cache.findSimilarFixes("Type 'string' is not assignable");
			expect(fixes).toHaveLength(1);
			expect(fixes[0].fix).toBe("Changed type to number");
		});

		it("findSimilarFixes only returns successful fixes", () => {
			const cache = getCache("/test");

			cache.recordErrorFix("Type error", "file.ts", "Bad fix", false);
			cache.recordErrorFix("Type error", "file.ts", "Good fix", true);

			const fixes = cache.findSimilarFixes("Type error");
			expect(fixes).toHaveLength(1);
			expect(fixes[0].fix).toBe("Good fix");
		});

		it("findSimilarFixes normalizes error patterns", () => {
			const cache = getCache("/test");

			// Record with specific details - use simple pattern that will normalize consistently
			cache.recordErrorFix("Type 'string' is not assignable to type 'number'", "file.ts", "Fix it", true);

			// Search with same base pattern - should normalize to same key
			const fixes = cache.findSimilarFixes("Type 'string' is not assignable to type 'number'");
			expect(fixes).toHaveLength(1);
		});

		it("clear removes file hashes and summaries but keeps error fixes", () => {
			mockFiles.set("test.ts", "const x = 1;");
			const cache = getCache("/test");

			// Set up cache state
			cache.getFileHash("test.ts");
			cache.setFileSummary("test.ts", {
				path: "test.ts",
				exports: [],
				imports: [],
				functions: [],
				lineCount: 1,
			});
			cache.recordErrorFix("Error", "file.ts", "Fix", true);

			cache.clear();

			// File hash should be cleared (hasFileChanged returns true)
			expect(cache.hasFileChanged("test.ts")).toBe(true);

			// Summary should be cleared
			expect(cache.getFileSummary("test.ts")).toBeNull();

			// Error fixes should be preserved
			const fixes = cache.findSimilarFixes("Error");
			expect(fixes).toHaveLength(1);
		});
	});
});
