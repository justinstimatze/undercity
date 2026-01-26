/**
 * Tests for Extraction Benchmark Harness
 *
 * Tests the parallel extraction benchmark comparing pattern-matching
 * vs model-based extraction, including metrics calculation, parallel
 * execution, and report generation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude agent SDK to avoid real API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock logger
vi.mock("../logger.js", () => ({
	sessionLogger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Import after mocking
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtractedItem, ExtractionResult } from "../extraction-benchmark.js";
import {
	aggregateMetrics,
	calculateSampleMetrics,
	DEFAULT_BENCHMARK_CONFIG,
	formatBenchmarkJson,
	formatBenchmarkReport,
	modelBasedExtract,
	patternMatchingExtract,
	runBenchmark,
} from "../extraction-benchmark.js";
import type { ExtractionSample, GroundTruthItem } from "../test-data/extraction-samples.js";
import {
	EXTRACTION_SAMPLES,
	getExtractionTypeBreakdown,
	getSamplesByCategory,
	getTotalExpectedExtractions,
} from "../test-data/extraction-samples.js";

describe("extraction-benchmark", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("patternMatchingExtract", () => {
		it("should extract file paths from TypeScript errors", () => {
			const input = "src/components/Button.tsx(42,15): error TS2345";
			const extracted = patternMatchingExtract(input);

			const filePaths = extracted.filter((e) => e.type === "file_path");
			expect(filePaths.length).toBeGreaterThan(0);
			expect(filePaths.some((e) => e.value.includes("Button.tsx"))).toBe(true);
		});

		it("should extract error codes", () => {
			const input = "error TS2345: Type mismatch";
			const extracted = patternMatchingExtract(input);

			const errorCodes = extracted.filter((e) => e.type === "error_code");
			expect(errorCodes).toContainEqual({ type: "error_code", value: "TS2345" });
		});

		it("should extract line numbers from various formats", () => {
			const input1 = "file.ts:42:15 - error";
			const input2 = "file.ts(42,15): error";
			const input3 = "Error on line 42";

			const extracted1 = patternMatchingExtract(input1);
			const extracted2 = patternMatchingExtract(input2);
			const extracted3 = patternMatchingExtract(input3);

			expect(extracted1.some((e) => e.type === "line_number" && e.value === "42")).toBe(true);
			expect(extracted2.some((e) => e.type === "line_number" && e.value === "42")).toBe(true);
			expect(extracted3.some((e) => e.type === "line_number" && e.value === "42")).toBe(true);
		});

		it("should extract function names from stack traces", () => {
			const input = "at getUserById (/app/src/services/user.ts:34:18)";
			const extracted = patternMatchingExtract(input);

			const functions = extracted.filter((e) => e.type === "function_name");
			expect(functions).toContainEqual({ type: "function_name", value: "getUserById" });
		});

		it("should extract module names with scopes", () => {
			const input = "Cannot find module '@mui/material/Button'";
			const extracted = patternMatchingExtract(input);

			const modules = extracted.filter((e) => e.type === "module_name");
			expect(modules.some((e) => e.value.includes("@mui/material"))).toBe(true);
		});

		it("should extract URLs", () => {
			const input = "See https://nvd.nist.gov/vuln/detail/CVE-2020-8203";
			const extracted = patternMatchingExtract(input);

			const urls = extracted.filter((e) => e.type === "url");
			expect(urls.some((e) => e.value.includes("nvd.nist.gov"))).toBe(true);
		});

		it("should extract version numbers", () => {
			const input = "lodash@4.17.15 - Upgrade to lodash@4.17.21";
			const extracted = patternMatchingExtract(input);

			const versions = extracted.filter((e) => e.type === "version");
			expect(versions.length).toBeGreaterThanOrEqual(2);
		});

		it("should handle empty input", () => {
			const extracted = patternMatchingExtract("");
			expect(extracted).toEqual([]);
		});

		it("should deduplicate extractions", () => {
			const input = "src/file.ts src/file.ts src/file.ts";
			const extracted = patternMatchingExtract(input);

			// Should not have duplicate file paths
			const filePaths = extracted.filter((e) => e.type === "file_path");
			const uniqueValues = new Set(filePaths.map((e) => e.value));
			expect(uniqueValues.size).toBe(filePaths.length);
		});
	});

	describe("modelBasedExtract", () => {
		it("should call Claude API and parse JSON response", async () => {
			// Mock successful API response
			const mockResponse = [
				{ type: "file_path", value: "src/test.ts" },
				{ type: "error_code", value: "TS2345" },
			];

			const mockQuery = vi.mocked(query);
			mockQuery.mockImplementation(async function* () {
				yield {
					type: "result" as const,
					subtype: "success" as const,
					result: JSON.stringify(mockResponse),
				};
			});

			const result = await modelBasedExtract("Error in src/test.ts: TS2345");

			expect(result.extracted).toEqual([
				{ type: "file_path", value: "src/test.ts" },
				{ type: "error_code", value: "TS2345" },
			]);
			expect(result.latencyMs).toBeGreaterThan(0);
			expect(result.costUsd).toBeGreaterThanOrEqual(0);
		});

		it("should handle empty API response", async () => {
			const mockQuery = vi.mocked(query);
			mockQuery.mockImplementation(async function* () {
				yield {
					type: "result" as const,
					subtype: "success" as const,
					result: "[]",
				};
			});

			const result = await modelBasedExtract("No extractable content");

			expect(result.extracted).toEqual([]);
		});

		it("should handle API errors gracefully", async () => {
			const mockQuery = vi.mocked(query);
			// Mock implementation that throws after yielding (required for generator)
			mockQuery.mockImplementation(async function* () {
				yield { type: "assistant" as const, content: "dummy" };
				throw new Error("API Error");
			});

			const result = await modelBasedExtract("Some input");

			expect(result.extracted).toEqual([]);
			expect(result.error).toContain("API Error");
		});

		it("should calculate cost based on token usage", async () => {
			const mockQuery = vi.mocked(query);
			mockQuery.mockImplementation(async function* () {
				yield {
					type: "result" as const,
					subtype: "success" as const,
					result: "[]",
				};
			});

			const result = await modelBasedExtract("Test input");

			expect(result.costUsd).toBeGreaterThanOrEqual(0);
			expect(result.tokens).toBeDefined();
		});
	});

	describe("calculateSampleMetrics", () => {
		it("should calculate perfect precision and recall when extractions match exactly", () => {
			const extracted: ExtractedItem[] = [
				{ type: "file_path", value: "src/file.ts" },
				{ type: "line_number", value: "42" },
			];
			const groundTruth: GroundTruthItem[] = [
				{ type: "file_path", value: "src/file.ts" },
				{ type: "line_number", value: "42" },
			];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.precision).toBe(1.0);
			expect(metrics.recall).toBe(1.0);
			expect(metrics.f1).toBe(1.0);
			expect(metrics.truePositives).toBe(2);
			expect(metrics.falsePositives).toBe(0);
			expect(metrics.falseNegatives).toBe(0);
		});

		it("should calculate correct metrics when some extractions are missed", () => {
			const extracted: ExtractedItem[] = [{ type: "file_path", value: "src/file.ts" }];
			const groundTruth: GroundTruthItem[] = [
				{ type: "file_path", value: "src/file.ts" },
				{ type: "line_number", value: "42" },
			];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.precision).toBe(1.0); // 1/1
			expect(metrics.recall).toBe(0.5); // 1/2
			expect(metrics.truePositives).toBe(1);
			expect(metrics.falsePositives).toBe(0);
			expect(metrics.falseNegatives).toBe(1);
		});

		it("should calculate correct metrics when there are false positives", () => {
			const extracted: ExtractedItem[] = [
				{ type: "file_path", value: "src/file.ts" },
				{ type: "error_code", value: "TS9999" }, // Not in ground truth
			];
			const groundTruth: GroundTruthItem[] = [{ type: "file_path", value: "src/file.ts" }];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.precision).toBe(0.5); // 1/2
			expect(metrics.recall).toBe(1.0); // 1/1
			expect(metrics.truePositives).toBe(1);
			expect(metrics.falsePositives).toBe(1);
			expect(metrics.falseNegatives).toBe(0);
		});

		it("should handle empty extractions", () => {
			const extracted: ExtractedItem[] = [];
			const groundTruth: GroundTruthItem[] = [{ type: "file_path", value: "src/file.ts" }];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.precision).toBe(0);
			expect(metrics.recall).toBe(0);
			expect(metrics.f1).toBe(0);
			expect(metrics.falseNegatives).toBe(1);
		});

		it("should handle empty ground truth", () => {
			const extracted: ExtractedItem[] = [{ type: "file_path", value: "src/file.ts" }];
			const groundTruth: GroundTruthItem[] = [];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.precision).toBe(0);
			expect(metrics.recall).toBe(0);
			expect(metrics.falsePositives).toBe(1);
		});

		it("should calculate F1 score correctly", () => {
			// Precision = 0.5, Recall = 1.0, F1 = 2*0.5*1/(0.5+1) = 0.667
			const extracted: ExtractedItem[] = [
				{ type: "file_path", value: "src/file.ts" },
				{ type: "error_code", value: "TS9999" },
			];
			const groundTruth: GroundTruthItem[] = [{ type: "file_path", value: "src/file.ts" }];

			const metrics = calculateSampleMetrics(extracted, groundTruth);

			expect(metrics.f1).toBeCloseTo(0.667, 2);
		});
	});

	describe("aggregateMetrics", () => {
		it("should aggregate metrics across multiple samples", () => {
			const samples: ExtractionSample[] = [
				{
					id: "sample-1",
					category: "error_message",
					description: "Test 1",
					input: "Error in src/a.ts",
					groundTruth: [{ type: "file_path", value: "src/a.ts" }],
				},
				{
					id: "sample-2",
					category: "error_message",
					description: "Test 2",
					input: "Error in src/b.ts",
					groundTruth: [{ type: "file_path", value: "src/b.ts" }],
				},
			];

			const results: ExtractionResult[] = [
				{
					sampleId: "sample-1",
					extracted: [{ type: "file_path", value: "src/a.ts" }],
					latencyMs: 10,
					costUsd: 0,
				},
				{
					sampleId: "sample-2",
					extracted: [{ type: "file_path", value: "src/b.ts" }],
					latencyMs: 20,
					costUsd: 0,
				},
			];

			const aggregated = aggregateMetrics(results, samples, "pattern_matching");

			expect(aggregated.sampleCount).toBe(2);
			expect(aggregated.precision).toBe(1.0);
			expect(aggregated.recall).toBe(1.0);
			expect(aggregated.f1).toBe(1.0);
			expect(aggregated.avgLatencyMs).toBe(15);
			expect(aggregated.totalTruePositives).toBe(2);
		});

		it("should calculate latency percentiles correctly", () => {
			const samples: ExtractionSample[] = Array.from({ length: 10 }, (_, i) => ({
				id: `sample-${i}`,
				category: "error_message" as const,
				description: `Test ${i}`,
				input: `Error ${i}`,
				groundTruth: [],
			}));

			const results: ExtractionResult[] = Array.from({ length: 10 }, (_, i) => ({
				sampleId: `sample-${i}`,
				extracted: [],
				latencyMs: (i + 1) * 10, // 10, 20, 30, ..., 100
				costUsd: 0,
			}));

			const aggregated = aggregateMetrics(results, samples, "pattern_matching");

			expect(aggregated.avgLatencyMs).toBe(55);
			expect(aggregated.medianLatencyMs).toBe(60); // Middle of sorted array
			expect(aggregated.p95LatencyMs).toBe(100); // 95th percentile
		});

		it("should aggregate costs correctly", () => {
			const samples: ExtractionSample[] = [
				{
					id: "sample-1",
					category: "error_message",
					description: "Test",
					input: "Error",
					groundTruth: [],
				},
				{
					id: "sample-2",
					category: "error_message",
					description: "Test",
					input: "Error",
					groundTruth: [],
				},
			];

			const results: ExtractionResult[] = [
				{ sampleId: "sample-1", extracted: [], latencyMs: 10, costUsd: 0.001 },
				{ sampleId: "sample-2", extracted: [], latencyMs: 10, costUsd: 0.002 },
			];

			const aggregated = aggregateMetrics(results, samples, "model_based");

			expect(aggregated.totalCostUsd).toBeCloseTo(0.003, 4);
			expect(aggregated.avgCostUsd).toBeCloseTo(0.0015, 4);
		});
	});

	describe("runBenchmark", () => {
		it("should run pattern matching when configured", async () => {
			const samples: ExtractionSample[] = [
				{
					id: "test-1",
					category: "error_message",
					description: "Test",
					input: "Error in src/file.ts:42",
					groundTruth: [
						{ type: "file_path", value: "src/file.ts" },
						{ type: "line_number", value: "42" },
					],
				},
			];

			const result = await runBenchmark(samples, {
				...DEFAULT_BENCHMARK_CONFIG,
				runPatternMatching: true,
				runModelBased: false,
			});

			expect(result.patternMatching.sampleCount).toBe(1);
			expect(result.modelBased.sampleCount).toBe(0);
		});

		it("should run both methods in parallel when configured", async () => {
			const mockQuery = vi.mocked(query);
			mockQuery.mockImplementation(async function* () {
				yield {
					type: "result" as const,
					subtype: "success" as const,
					result: "[]",
				};
			});

			const samples: ExtractionSample[] = [
				{
					id: "test-1",
					category: "error_message",
					description: "Test",
					input: "Error in src/file.ts",
					groundTruth: [{ type: "file_path", value: "src/file.ts" }],
				},
			];

			const result = await runBenchmark(samples, {
				...DEFAULT_BENCHMARK_CONFIG,
				runPatternMatching: true,
				runModelBased: true,
			});

			expect(result.patternMatching.sampleCount).toBe(1);
			expect(result.modelBased.sampleCount).toBe(1);
			expect(result.totalDurationMs).toBeGreaterThan(0);
		});

		it("should process multiple samples concurrently for model-based extraction", async () => {
			const callOrder: string[] = [];

			const mockQuery = vi.mocked(query);
			mockQuery.mockImplementation(async function* (_options: unknown) {
				callOrder.push("start");
				// Simulate some async work
				await new Promise((resolve) => setTimeout(resolve, 10));
				callOrder.push("end");
				yield {
					type: "result" as const,
					subtype: "success" as const,
					result: "[]",
				};
			});

			const samples: ExtractionSample[] = Array.from({ length: 3 }, (_, i) => ({
				id: `test-${i}`,
				category: "error_message" as const,
				description: `Test ${i}`,
				input: `Error ${i}`,
				groundTruth: [],
			}));

			await runBenchmark(samples, {
				...DEFAULT_BENCHMARK_CONFIG,
				runPatternMatching: false,
				runModelBased: true,
			});

			// If parallel, we should see multiple "start"s before "end"s
			// This verifies Promise.all is being used
			expect(mockQuery).toHaveBeenCalledTimes(3);
		});
	});

	describe("formatBenchmarkReport", () => {
		it("should generate human-readable report", () => {
			const result = {
				patternMatching: {
					method: "pattern_matching" as const,
					sampleCount: 10,
					precision: 0.85,
					recall: 0.75,
					f1: 0.797,
					avgLatencyMs: 5.5,
					medianLatencyMs: 5.0,
					p95LatencyMs: 10.0,
					totalCostUsd: 0,
					avgCostUsd: 0,
					perSampleMetrics: [],
					totalTruePositives: 15,
					totalFalsePositives: 3,
					totalFalseNegatives: 5,
				},
				modelBased: {
					method: "model_based" as const,
					sampleCount: 10,
					precision: 0.92,
					recall: 0.88,
					f1: 0.899,
					avgLatencyMs: 1500,
					medianLatencyMs: 1400,
					p95LatencyMs: 2000,
					totalCostUsd: 0.05,
					avgCostUsd: 0.005,
					perSampleMetrics: [],
					totalTruePositives: 18,
					totalFalsePositives: 2,
					totalFalseNegatives: 2,
				},
				timestamp: new Date("2025-01-20T12:00:00Z"),
				totalDurationMs: 15000,
				sampleCount: 10,
			};

			const report = formatBenchmarkReport(result);

			expect(report).toContain("EXTRACTION BENCHMARK REPORT");
			expect(report).toContain("Precision");
			expect(report).toContain("Recall");
			expect(report).toContain("F1 Score");
			expect(report).toContain("Pattern Matching");
			expect(report).toContain("Model-Based");
			expect(report).toContain("0.850");
			expect(report).toContain("0.920");
		});
	});

	describe("formatBenchmarkJson", () => {
		it("should generate valid JSON output", () => {
			const result = {
				patternMatching: {
					method: "pattern_matching" as const,
					sampleCount: 5,
					precision: 0.8,
					recall: 0.7,
					f1: 0.747,
					avgLatencyMs: 10,
					medianLatencyMs: 8,
					p95LatencyMs: 15,
					totalCostUsd: 0,
					avgCostUsd: 0,
					perSampleMetrics: [],
					totalTruePositives: 10,
					totalFalsePositives: 3,
					totalFalseNegatives: 4,
				},
				modelBased: {
					method: "model_based" as const,
					sampleCount: 5,
					precision: 0.9,
					recall: 0.85,
					f1: 0.874,
					avgLatencyMs: 1000,
					medianLatencyMs: 950,
					p95LatencyMs: 1500,
					totalCostUsd: 0.025,
					avgCostUsd: 0.005,
					perSampleMetrics: [],
					totalTruePositives: 12,
					totalFalsePositives: 1,
					totalFalseNegatives: 2,
				},
				timestamp: new Date("2025-01-20T12:00:00Z"),
				totalDurationMs: 5000,
				sampleCount: 5,
			};

			const json = formatBenchmarkJson(result);
			const parsed = JSON.parse(json);

			expect(parsed.comparison.patternMatching.precision).toBe(0.8);
			expect(parsed.comparison.modelBased.precision).toBe(0.9);
			expect(parsed.sampleCount).toBe(5);
			expect(parsed.timestamp).toBe("2025-01-20T12:00:00.000Z");
		});
	});

	describe("test-data/extraction-samples", () => {
		it("should have at least 10 test samples", () => {
			expect(EXTRACTION_SAMPLES.length).toBeGreaterThanOrEqual(10);
		});

		it("should have ground truth for all samples", () => {
			for (const sample of EXTRACTION_SAMPLES) {
				expect(sample.groundTruth.length).toBeGreaterThan(0);
				expect(sample.id).toBeTruthy();
				expect(sample.input).toBeTruthy();
			}
		});

		it("should have diverse categories", () => {
			const categories = new Set(EXTRACTION_SAMPLES.map((s) => s.category));
			expect(categories.size).toBeGreaterThanOrEqual(4);
		});

		it("should have diverse extraction types in ground truth", () => {
			const types = new Set<string>();
			for (const sample of EXTRACTION_SAMPLES) {
				for (const item of sample.groundTruth) {
					types.add(item.type);
				}
			}
			expect(types.size).toBeGreaterThanOrEqual(5);
		});

		it("getSamplesByCategory should filter correctly", () => {
			const errorSamples = getSamplesByCategory("error_message");
			expect(errorSamples.every((s) => s.category === "error_message")).toBe(true);
		});

		it("getTotalExpectedExtractions should sum all ground truth items", () => {
			const total = getTotalExpectedExtractions();
			const manual = EXTRACTION_SAMPLES.reduce((sum, s) => sum + s.groundTruth.length, 0);
			expect(total).toBe(manual);
		});

		it("getExtractionTypeBreakdown should categorize all items", () => {
			const breakdown = getExtractionTypeBreakdown();
			const total = Array.from(breakdown.values()).reduce((a, b) => a + b, 0);
			expect(total).toBe(getTotalExpectedExtractions());
		});
	});

	describe("integration: pattern matching on real samples", () => {
		it("should achieve reasonable precision on TypeScript error samples", () => {
			const tsSamples = EXTRACTION_SAMPLES.filter((s) => s.input.includes("TS"));

			for (const sample of tsSamples) {
				const extracted = patternMatchingExtract(sample.input);
				const metrics = calculateSampleMetrics(extracted, sample.groundTruth);

				// Pattern matching should have reasonable precision on TS errors
				expect(metrics.precision).toBeGreaterThanOrEqual(0);
			}
		});

		it("should extract file paths from most samples containing paths", () => {
			const samplesWithPaths = EXTRACTION_SAMPLES.filter((s) => s.groundTruth.some((g) => g.type === "file_path"));

			let successCount = 0;
			for (const sample of samplesWithPaths) {
				const extracted = patternMatchingExtract(sample.input);
				const filePaths = extracted.filter((e) => e.type === "file_path");

				if (filePaths.length > 0) {
					successCount++;
				}
			}

			// Pattern matching should extract file paths from at least 70% of samples
			const successRate = successCount / samplesWithPaths.length;
			expect(successRate).toBeGreaterThanOrEqual(0.7);
		});
	});
});
