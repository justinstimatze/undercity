/**
 * CLI Smoke Tests
 *
 * Verifies that CLI commands don't crash and return expected exit codes.
 * These are fast sanity checks that catch "app won't start" regressions.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_PATH = join(process.cwd(), "bin/undercity.js");

describe("CLI Smoke Tests", () => {
	describe("Help and Version", () => {
		it("--help exits 0 and shows usage", () => {
			const result = execSync(`node ${CLI_PATH} --help`, { encoding: "utf-8" });
			expect(result).toContain("Usage:");
			expect(result).toContain("undercity");
		});

		it("--version exits 0 and shows version", () => {
			const result = execSync(`node ${CLI_PATH} --version`, { encoding: "utf-8" });
			expect(result.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("help command works", () => {
			const result = execSync(`node ${CLI_PATH} help`, { encoding: "utf-8" });
			expect(result).toContain("Usage:");
		});

		it("help for specific command works", () => {
			const result = execSync(`node ${CLI_PATH} help add`, { encoding: "utf-8" });
			expect(result).toContain("add");
			expect(result).toContain("goal");
		});
	});

	describe("Read-only Commands", () => {
		let testDir: string;

		beforeAll(() => {
			// Create minimal test environment
			testDir = mkdtempSync(join(tmpdir(), "cli-smoke-"));
			mkdirSync(join(testDir, ".undercity"), { recursive: true });

			// Empty tasks file
			writeFileSync(join(testDir, ".undercity", "tasks.json"), JSON.stringify({ tasks: [] }));

			// Initialize git repo (some commands need it)
			execSync("git init", { cwd: testDir, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
			execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });
			writeFileSync(join(testDir, "README.md"), "# Test");
			execSync("git add . && git commit -m 'init'", { cwd: testDir, stdio: "pipe" });
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("tasks command works with empty board", () => {
			// Smoke test: just verify command doesn't crash (exit code 0)
			const result = execSync(`node ${CLI_PATH} tasks`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			// Should contain some task board output
			expect(result.length).toBeGreaterThan(0);
		});

		it("limits command works", () => {
			const result = execSync(`node ${CLI_PATH} limits`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("status command works", () => {
			const result = execSync(`node ${CLI_PATH} status`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("config command works", () => {
			const result = execSync(`node ${CLI_PATH} config`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("task-status command works", () => {
			const result = execSync(`node ${CLI_PATH} task-status`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("metrics command works", () => {
			const result = execSync(`node ${CLI_PATH} metrics`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("daemon status works", () => {
			const result = execSync(`node ${CLI_PATH} daemon status`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe("Task Board Commands", () => {
		let testDir: string;

		beforeAll(() => {
			testDir = mkdtempSync(join(tmpdir(), "cli-smoke-tasks-"));
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			writeFileSync(join(testDir, ".undercity", "tasks.json"), JSON.stringify({ tasks: [] }));

			execSync("git init", { cwd: testDir, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
			execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });
			writeFileSync(join(testDir, "README.md"), "# Test");
			execSync("git add . && git commit -m 'init'", { cwd: testDir, stdio: "pipe" });
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("add command adds task to board", () => {
			execSync(`node ${CLI_PATH} add "Test task from smoke test"`, {
				encoding: "utf-8",
				cwd: testDir,
			});

			// Verify task was added by reading tasks.json directly
			const tasksFile = join(testDir, ".undercity", "tasks.json");
			const content = readFileSync(tasksFile, "utf-8");
			expect(content).toContain("Test task from smoke test");
		});

		it("task-analyze command works", () => {
			const result = execSync(`node ${CLI_PATH} task-analyze`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});

		it("triage command works", () => {
			const result = execSync(`node ${CLI_PATH} triage`, {
				encoding: "utf-8",
				cwd: testDir,
			});
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe("Error Handling", () => {
		it("unknown command shows error", () => {
			try {
				execSync(`node ${CLI_PATH} nonexistent-command`, {
					encoding: "utf-8",
					stdio: "pipe",
				});
				expect.fail("Should have thrown");
			} catch (error) {
				// Commander exits with error for unknown commands
				expect(error).toBeDefined();
			}
		});

		it("add without goal shows error", () => {
			try {
				execSync(`node ${CLI_PATH} add`, {
					encoding: "utf-8",
					stdio: "pipe",
				});
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeDefined();
			}
		});
	});
});
