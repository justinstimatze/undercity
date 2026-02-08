/**
 * Tests for RAG search tracking in live-metrics.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the git command to return a test directory
let testDir: string;

vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => {
		if (!testDir) throw new Error("testDir not initialized");
		return testDir;
	}),
}));

describe("RAG search tracking", () => {
	beforeEach(() => {
		// Create a temporary directory for each test
		testDir = mkdtempSync(join(tmpdir(), "live-metrics-rag-test-"));

		// Clear module cache to get fresh imports with mocked git
		vi.resetModules();
	});

	afterEach(() => {
		// Clean up test directory
		if (testDir && existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should include ragSearches field in createEmptyMetrics", async () => {
		const { loadLiveMetrics } = await import("../live-metrics.js");

		const metrics = loadLiveMetrics();

		expect(metrics.ragSearches).toBeDefined();
		expect(metrics.ragSearches.total).toBe(0);
		expect(metrics.ragSearches.resultsFound).toBe(0);
		expect(metrics.ragSearches.searchesUsed).toBe(0);
	});

	it("should increment counters correctly on recordRagSearch", async () => {
		const { recordRagSearch, loadLiveMetrics } = await import("../live-metrics.js");

		recordRagSearch({
			query: "test query",
			resultsCount: 5,
			wasUsed: true,
		});

		const metrics = loadLiveMetrics();
		expect(metrics.ragSearches.total).toBe(1);
		expect(metrics.ragSearches.resultsFound).toBe(5);
		expect(metrics.ragSearches.searchesUsed).toBe(1);
	});

	it("should accumulate metrics across multiple calls", async () => {
		const { recordRagSearch, loadLiveMetrics } = await import("../live-metrics.js");

		recordRagSearch({ query: "query 1", resultsCount: 3, wasUsed: true });
		recordRagSearch({ query: "query 2", resultsCount: 7, wasUsed: true });
		recordRagSearch({ query: "query 3", resultsCount: 2, wasUsed: false });

		const metrics = loadLiveMetrics();
		expect(metrics.ragSearches.total).toBe(3);
		expect(metrics.ragSearches.resultsFound).toBe(12); // 3 + 7 + 2
		expect(metrics.ragSearches.searchesUsed).toBe(2); // Only first two had wasUsed=true
	});

	it("should not increment searchesUsed when wasUsed is false", async () => {
		const { recordRagSearch, loadLiveMetrics } = await import("../live-metrics.js");

		recordRagSearch({
			query: "test query",
			resultsCount: 0,
			wasUsed: false,
		});

		const metrics = loadLiveMetrics();
		expect(metrics.ragSearches.total).toBe(1);
		expect(metrics.ragSearches.resultsFound).toBe(0);
		expect(metrics.ragSearches.searchesUsed).toBe(0);
	});

	it("should persist metrics to disk", async () => {
		const { recordRagSearch } = await import("../live-metrics.js");

		recordRagSearch({
			query: "persist test",
			resultsCount: 4,
			wasUsed: true,
		});

		const metricsPath = join(testDir, ".undercity", "live-metrics.json");
		expect(existsSync(metricsPath)).toBe(true);

		const content = JSON.parse(readFileSync(metricsPath, "utf-8"));
		expect(content.ragSearches).toBeDefined();
		expect(content.ragSearches.total).toBe(1);
		expect(content.ragSearches.resultsFound).toBe(4);
		expect(content.ragSearches.searchesUsed).toBe(1);
	});
});
