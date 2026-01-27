/**
 * Tests for symbol extraction and validation in task-validator.ts
 */

import { describe, expect, it, vi } from "vitest";
import { extractSymbolsFromObjective, validateSymbolReferences } from "../task-validator.js";

// Mock the AST index
vi.mock("../ast-index.js", () => ({
	getASTIndex: vi.fn(() => ({
		load: vi.fn().mockResolvedValue(undefined),
		findSymbolDefinition: vi.fn((name: string) => {
			// Mock symbol locations
			const symbolMap: Record<string, string[]> = {
				calculateVector: ["src/embeddings.ts"],
				LocalEmbedder: ["src/rag/embedder.ts"],
				TaskWorker: ["src/worker.ts"],
				unknownSymbol: [],
			};
			return symbolMap[name] || [];
		}),
	})),
}));

describe("task-validator/symbols", () => {
	describe("extractSymbolsFromObjective", () => {
		it("extracts function calls like functionName()", () => {
			const objective = "In src/file.ts, fix the calculateVector() function";
			const symbols = extractSymbolsFromObjective(objective);

			expect(symbols).toContainEqual(
				expect.objectContaining({
					name: "calculateVector",
					type: "function",
				}),
			);
		});

		it("extracts class names with class keyword", () => {
			const objective = "update the class LocalEmbedder in src/rag/embedder.ts";
			const symbols = extractSymbolsFromObjective(objective);

			expect(symbols).toContainEqual(
				expect.objectContaining({
					name: "LocalEmbedder",
					type: "class",
				}),
			);
		});

		it("extracts method names", () => {
			const objective = "Fix the processTask method in worker.ts";
			const symbols = extractSymbolsFromObjective(objective);

			expect(symbols).toContainEqual(
				expect.objectContaining({
					name: "processTask",
					type: "method",
				}),
			);
		});

		it("associates symbols with file path from objective", () => {
			const objective = "In src/embeddings.ts, add error handling to calculateVector()";
			const symbols = extractSymbolsFromObjective(objective);

			const calcVector = symbols.find((s) => s.name === "calculateVector");
			expect(calcVector?.claimedFile).toBe("src/embeddings.ts");
		});

		it("filters out common words that look like function calls", () => {
			const objective = "Add the new feature and fix() the bug";
			const symbols = extractSymbolsFromObjective(objective);

			// "fix" and "add" should be filtered out
			expect(symbols.find((s) => s.name === "fix")).toBeUndefined();
			expect(symbols.find((s) => s.name === "add")).toBeUndefined();
		});

		it("extracts PascalCase names with Manager suffix", () => {
			const objective = "Add error handling to TaskWorkerManager";
			const symbols = extractSymbolsFromObjective(objective);

			// Should extract because "Manager" is a known suffix pattern
			expect(symbols).toContainEqual(
				expect.objectContaining({
					name: "TaskWorkerManager",
				}),
			);
		});

		it("extracts PascalCase names with known suffixes", () => {
			const objective = "Update the ValidationError class";
			const symbols = extractSymbolsFromObjective(objective);

			expect(symbols).toContainEqual(
				expect.objectContaining({
					name: "ValidationError",
				}),
			);
		});

		it("returns empty array for objectives without symbols", () => {
			const objective = "Add a new feature to the application";
			const symbols = extractSymbolsFromObjective(objective);

			expect(symbols).toHaveLength(0);
		});
	});

	describe("validateSymbolReferences", () => {
		it("returns no issues when symbol is in correct file", async () => {
			const symbols = [{ name: "calculateVector", claimedFile: "src/embeddings.ts", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			expect(result.issues).toHaveLength(0);
			expect(result.corrections).toHaveLength(0);
		});

		it("returns error when symbol is in wrong file", async () => {
			const symbols = [{ name: "calculateVector", claimedFile: "src/rag/embedder.ts", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			expect(result.issues).toHaveLength(1);
			expect(result.issues[0].type).toBe("symbol_wrong_file");
			expect(result.issues[0].severity).toBe("error");
			expect(result.issues[0].autoFix).toEqual({
				originalPath: "src/rag/embedder.ts",
				correctedPath: "src/embeddings.ts",
			});
		});

		it("provides correction when symbol is in wrong file", async () => {
			const symbols = [{ name: "calculateVector", claimedFile: "src/rag/embedder.ts", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			expect(result.corrections).toHaveLength(1);
			expect(result.corrections[0]).toEqual({
				symbol: "calculateVector",
				originalFile: "src/rag/embedder.ts",
				correctFile: "src/embeddings.ts",
			});
		});

		it("returns warning when symbol not found anywhere", async () => {
			const symbols = [{ name: "unknownSymbol", claimedFile: "src/file.ts", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			expect(result.issues).toHaveLength(1);
			expect(result.issues[0].type).toBe("symbol_not_found");
			expect(result.issues[0].severity).toBe("warning");
		});

		it("skips validation for symbols without claimed file", async () => {
			const symbols = [{ name: "unknownSymbol", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			// Should not warn about not found if no file was claimed
			expect(result.issues).toHaveLength(0);
		});

		it("handles multiple symbols", async () => {
			const symbols = [
				{ name: "calculateVector", claimedFile: "src/rag/embedder.ts", type: "function" as const }, // wrong file
				{ name: "LocalEmbedder", claimedFile: "src/rag/embedder.ts", type: "class" as const }, // correct file
			];

			const result = await validateSymbolReferences(symbols, process.cwd());

			// Only one error (wrong file for calculateVector)
			expect(result.issues.filter((i) => i.type === "symbol_wrong_file")).toHaveLength(1);
			expect(result.corrections).toHaveLength(1);
		});

		it("skips very short symbol names", async () => {
			const symbols = [{ name: "a", claimedFile: "src/file.ts", type: "function" as const }];

			const result = await validateSymbolReferences(symbols, process.cwd());

			// Should skip validation for short names
			expect(result.issues).toHaveLength(0);
		});
	});
});
