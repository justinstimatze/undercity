/**
 * Tests for AST Index Manager
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASTIndexManager, resetASTIndex } from "../ast-index.js";

describe("ASTIndexManager", () => {
	let testDir: string;
	let indexManager: ASTIndexManager;

	beforeEach(() => {
		resetASTIndex();
		testDir = mkdtempSync(join(tmpdir(), "ast-index-test-"));

		// Create .undercity directory
		mkdirSync(join(testDir, ".undercity"), { recursive: true });

		// Create a minimal tsconfig.json
		writeFileSync(
			join(testDir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					strict: true,
				},
				include: ["src/**/*"],
			}),
		);

		// Create src directory with sample files
		mkdirSync(join(testDir, "src"), { recursive: true });

		indexManager = new ASTIndexManager(testDir);
	});

	afterEach(() => {
		resetASTIndex();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("load and save", () => {
		it("should create empty index when no file exists", async () => {
			await indexManager.load();
			const stats = indexManager.getStats();
			expect(stats.fileCount).toBe(0);
			expect(stats.symbolCount).toBe(0);
		});

		it("should save and load index", async () => {
			// Create a test file
			writeFileSync(join(testDir, "src/test.ts"), `export function testFunc(): string { return "test"; }`);

			await indexManager.load();
			await indexManager.indexFile("src/test.ts");
			await indexManager.save();

			// Create new instance and load
			const newManager = new ASTIndexManager(testDir);
			await newManager.load();

			const stats = newManager.getStats();
			expect(stats.fileCount).toBe(1);
			expect(stats.symbolCount).toBe(1);
		});
	});

	describe("indexFile", () => {
		it("should extract exported function", async () => {
			writeFileSync(
				join(testDir, "src/functions.ts"),
				`export function greet(name: string): string {
					return \`Hello, \${name}\`;
				}`,
			);

			await indexManager.load();
			const updated = await indexManager.indexFile("src/functions.ts");

			expect(updated).toBe(true);
			const exports = indexManager.getFileExports("src/functions.ts");
			expect(exports).toHaveLength(1);
			expect(exports[0].name).toBe("greet");
			expect(exports[0].kind).toBe("function");
		});

		it("should extract exported class", async () => {
			writeFileSync(
				join(testDir, "src/classes.ts"),
				`export class MyService {
					run(): void {}
				}`,
			);

			await indexManager.load();
			await indexManager.indexFile("src/classes.ts");

			const exports = indexManager.getFileExports("src/classes.ts");
			expect(exports).toHaveLength(1);
			expect(exports[0].name).toBe("MyService");
			expect(exports[0].kind).toBe("class");
		});

		it("should extract exported interface", async () => {
			writeFileSync(
				join(testDir, "src/types.ts"),
				`export interface User {
					id: string;
					name: string;
				}`,
			);

			await indexManager.load();
			await indexManager.indexFile("src/types.ts");

			const exports = indexManager.getFileExports("src/types.ts");
			expect(exports).toHaveLength(1);
			expect(exports[0].name).toBe("User");
			expect(exports[0].kind).toBe("interface");
		});

		it("should extract exported type alias", async () => {
			writeFileSync(join(testDir, "src/types.ts"), `export type Status = "pending" | "complete";`);

			await indexManager.load();
			await indexManager.indexFile("src/types.ts");

			const exports = indexManager.getFileExports("src/types.ts");
			expect(exports).toHaveLength(1);
			expect(exports[0].name).toBe("Status");
			expect(exports[0].kind).toBe("type");
		});

		it("should not update if file unchanged", async () => {
			writeFileSync(join(testDir, "src/stable.ts"), `export const VALUE = 42;`);

			await indexManager.load();
			const firstUpdate = await indexManager.indexFile("src/stable.ts");
			const secondUpdate = await indexManager.indexFile("src/stable.ts");

			expect(firstUpdate).toBe(true);
			expect(secondUpdate).toBe(false);
		});
	});

	describe("querying", () => {
		beforeEach(async () => {
			// Set up test files with imports
			writeFileSync(join(testDir, "src/types.ts"), `export interface Task { id: string; }`);

			writeFileSync(
				join(testDir, "src/service.ts"),
				`import type { Task } from "./types.js";
				export function getTask(id: string): Task | null { return null; }`,
			);

			await indexManager.load();
			await indexManager.indexFile("src/types.ts");
			await indexManager.indexFile("src/service.ts");
		});

		it("should find symbol definition", () => {
			const files = indexManager.findSymbolDefinition("Task");
			expect(files).toContain("src/types.ts");
		});

		it("should find importers", () => {
			const importers = indexManager.findImporters("src/types.ts");
			expect(importers).toContain("src/service.ts");
		});

		it("should find imports of a file", () => {
			const imports = indexManager.findImports("src/service.ts");
			expect(imports).toContain("src/types.ts");
		});

		it("should get symbol info", () => {
			const info = indexManager.getSymbolInfo("Task");
			expect(info).not.toBeNull();
			expect(info?.kind).toBe("interface");
		});

		it("should search symbols by pattern", () => {
			const results = indexManager.searchSymbols(/^get/);
			expect(results.some((s) => s.name === "getTask")).toBe(true);
		});
	});

	describe("isStale", () => {
		it("should return true for new files", async () => {
			writeFileSync(join(testDir, "src/new.ts"), `export const X = 1;`);
			await indexManager.load();

			expect(indexManager.isStale("src/new.ts")).toBe(true);
		});

		it("should return false for unchanged indexed files", async () => {
			writeFileSync(join(testDir, "src/stable.ts"), `export const X = 1;`);
			await indexManager.load();
			await indexManager.indexFile("src/stable.ts");

			expect(indexManager.isStale("src/stable.ts")).toBe(false);
		});

		it("should return true when file content changes", async () => {
			writeFileSync(join(testDir, "src/changing.ts"), `export const X = 1;`);
			await indexManager.load();
			await indexManager.indexFile("src/changing.ts");

			// Modify the file
			writeFileSync(join(testDir, "src/changing.ts"), `export const X = 2;`);

			expect(indexManager.isStale("src/changing.ts")).toBe(true);
		});
	});

	describe("updateIncremental", () => {
		it("should only update stale files", async () => {
			writeFileSync(join(testDir, "src/a.ts"), `export const A = 1;`);
			writeFileSync(join(testDir, "src/b.ts"), `export const B = 2;`);

			await indexManager.load();
			await indexManager.indexFile("src/a.ts");
			await indexManager.indexFile("src/b.ts");

			// Modify only one file
			writeFileSync(join(testDir, "src/a.ts"), `export const A = 100;`);

			const updated = await indexManager.updateIncremental(["src/a.ts", "src/b.ts"]);
			expect(updated).toBe(1);
		});
	});

	describe("removeFile", () => {
		it("should remove file from index and reverse lookups", async () => {
			writeFileSync(join(testDir, "src/toremove.ts"), `export function removeMe(): void {}`);

			await indexManager.load();
			await indexManager.indexFile("src/toremove.ts");

			expect(indexManager.findSymbolDefinition("removeMe")).toContain("src/toremove.ts");

			indexManager.removeFile("src/toremove.ts");

			expect(indexManager.getFileInfo("src/toremove.ts")).toBeNull();
			expect(indexManager.findSymbolDefinition("removeMe")).toHaveLength(0);
		});
	});
});
