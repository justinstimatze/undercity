import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process and fs
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isFastPathCandidate, tryFastPath } from "../fast-path.js";

describe("fast-path", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("isFastPathCandidate", () => {
		it("should identify rename tasks as candidates", () => {
			expect(isFastPathCandidate("rename foo to bar")).toBe(true);
			expect(isFastPathCandidate("Rename getFoo to getBar in utils.ts")).toBe(true);
		});

		it("should identify change/update tasks as candidates", () => {
			// isFastPathCandidate looks for exact "change to" and "update to" substrings
			expect(isFastPathCandidate("change to new value in file.ts")).toBe(true);
			expect(isFastPathCandidate("update to 2.0")).toBe(true);
		});

		it("should identify replace tasks as candidates", () => {
			expect(isFastPathCandidate("replace with new implementation")).toBe(true);
		});

		it("should not identify complex tasks as candidates", () => {
			expect(isFastPathCandidate("add error handling to auth module")).toBe(false);
			expect(isFastPathCandidate("fix the bug in checkout flow")).toBe(false);
			expect(isFastPathCandidate("implement user authentication")).toBe(false);
		});
	});

	describe("tryFastPath", () => {
		it("should return handled:false when ast-grep not available", () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("command not found");
			});

			const result = tryFastPath("rename foo to bar", "/test");

			expect(result.handled).toBe(false);
		});

		it("should return handled:false for non-matching patterns", () => {
			vi.mocked(execSync).mockReturnValue(Buffer.from("0.40.0"));

			const result = tryFastPath("implement new feature", "/test");

			expect(result.handled).toBe(false);
		});

		it("should handle rename pattern extraction", () => {
			const mockExecSync = vi.mocked(execSync);
			// First call checks ast-grep version, subsequent calls run transformations
			mockExecSync
				.mockReturnValueOnce(Buffer.from("0.40.0"))
				.mockReturnValueOnce(Buffer.from("Updated src/file.ts"))
				.mockReturnValueOnce(Buffer.from(""));

			const result = tryFastPath("rename oldFunc to newFunc", "/test");

			expect(result.handled).toBe(true);
		});

		it("should handle update value pattern with file existence check", () => {
			vi.mocked(execSync).mockReturnValue(Buffer.from("0.40.0"));
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('const version = "1.0.0";');
			vi.mocked(writeFileSync).mockImplementation(() => {});

			const result = tryFastPath('change "1.0.0" to "2.0.0" in version.ts', "/test");

			expect(result.handled).toBe(true);
			expect(result.success).toBe(true);
			expect(writeFileSync).toHaveBeenCalled();
		});

		it("should fail when file not found for update value", () => {
			vi.mocked(execSync).mockReturnValue(Buffer.from("0.40.0"));
			vi.mocked(existsSync).mockReturnValue(false);

			const result = tryFastPath('change "old" to "new" in missing.ts', "/test");

			expect(result.handled).toBe(true);
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});

		it("should fail when value not found in file", () => {
			vi.mocked(execSync).mockReturnValue(Buffer.from("0.40.0"));
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('const x = "something else";');

			const result = tryFastPath('change "notfound" to "new" in file.ts', "/test");

			expect(result.handled).toBe(true);
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});
	});
});
