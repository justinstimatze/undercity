import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

// Note: Module imports are done dynamically in each test via vi.resetModules() + await import()
// to ensure a fresh module cache for testing tool availability detection

describe("efficiency-tools", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("getToolAvailability", () => {
		it("should check all tools and cache results", async () => {
			const mockExecSync = vi.mocked(execSync);
			// Simulate ast-grep and jq available, others not
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("ast-grep") || cmd.includes("jq")) {
					return Buffer.from("1.0.0");
				}
				throw new Error("command not found");
			});

			// Need to re-import to get fresh cache
			vi.resetModules();
			const { getToolAvailability: freshGetAvailability } = await import("../efficiency-tools.js");

			const availability = freshGetAvailability();

			expect(availability.get("ast-grep")).toBe(true);
			expect(availability.get("jq")).toBe(true);
			expect(availability.get("comby")).toBe(false);
		});
	});

	describe("getAvailableTools", () => {
		it("should return only available tools", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("ast-grep")) {
					return Buffer.from("0.40.0");
				}
				throw new Error("not found");
			});

			vi.resetModules();
			const { getAvailableTools: freshGetTools } = await import("../efficiency-tools.js");

			const tools = freshGetTools();

			expect(tools.length).toBe(1);
			expect(tools[0].name).toBe("ast-grep");
		});
	});

	describe("generateToolsPrompt", () => {
		it("should generate prompt with available tools", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("ast-grep") || cmd.includes("jq")) {
					return Buffer.from("1.0.0");
				}
				throw new Error("not found");
			});

			vi.resetModules();
			const { generateToolsPrompt: freshGenerate } = await import("../efficiency-tools.js");

			const prompt = freshGenerate();

			expect(prompt).toContain("Efficiency Tools");
			expect(prompt).toContain("ast-grep");
			expect(prompt).toContain("jq");
			expect(prompt).toContain("Examples:");
			expect(prompt).not.toContain("comby"); // Not available
		});

		it("should return empty string when no tools available", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation(() => {
				throw new Error("not found");
			});

			vi.resetModules();
			const { generateToolsPrompt: freshGenerate } = await import("../efficiency-tools.js");

			const prompt = freshGenerate();

			expect(prompt).toBe("");
		});
	});

	describe("getToolQuickRef", () => {
		it("should return quick reference for available tool", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("jq")) {
					return Buffer.from("jq-1.7");
				}
				throw new Error("not found");
			});

			vi.resetModules();
			const { getToolQuickRef: freshQuickRef } = await import("../efficiency-tools.js");

			const ref = freshQuickRef("jq");

			expect(ref).toContain("jq");
			expect(ref).toContain("JSON");
		});

		it("should return null for unavailable tool", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation(() => {
				throw new Error("not found");
			});

			vi.resetModules();
			const { getToolQuickRef: freshQuickRef } = await import("../efficiency-tools.js");

			const ref = freshQuickRef("ast-grep");

			expect(ref).toBeNull();
		});

		it("should return null for unknown tool", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockReturnValue(Buffer.from("1.0.0"));

			vi.resetModules();
			const { getToolQuickRef: freshQuickRef } = await import("../efficiency-tools.js");

			const ref = freshQuickRef("unknown-tool");

			expect(ref).toBeNull();
		});
	});

	describe("hasAnyTools", () => {
		it("should return true when tools are available", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("ast-grep")) {
					return Buffer.from("1.0.0");
				}
				throw new Error("not found");
			});

			vi.resetModules();
			const { hasAnyTools: freshHasTools } = await import("../efficiency-tools.js");

			expect(freshHasTools()).toBe(true);
		});

		it("should return false when no tools available", async () => {
			const mockExecSync = vi.mocked(execSync);
			mockExecSync.mockImplementation(() => {
				throw new Error("not found");
			});

			vi.resetModules();
			const { hasAnyTools: freshHasTools } = await import("../efficiency-tools.js");

			expect(freshHasTools()).toBe(false);
		});
	});
});
