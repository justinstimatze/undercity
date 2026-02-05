/**
 * Tests for file prediction tracking in MetricsTracker and effectiveness-analysis.ts
 *
 * Covers three areas:
 * 1. MetricsTracker state updates: recordPredictedFiles() and recordActualFilesModified()
 *    correctly store arrays, verified through completeTask() return values
 * 2. TaskMetrics completion: completeTask() includes/excludes predictedFiles and
 *    actualFilesModified fields based on whether arrays are populated
 * 3. File prediction metric calculations: precision, recall, and F1 score computation
 *    for exact matches, partial overlaps, no overlaps, empty arrays, duplicates,
 *    multiple task aggregation, and topAccurateFiles filtering
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeEffectiveness } from "../effectiveness-analysis.js";
import { MetricsTracker } from "../metrics.js";
import type { TaskMetrics } from "../types.js";

// Suppress console.error from logMetricsToFile (writes to disk asynchronously)
vi.spyOn(console, "error").mockImplementation(() => {});

/**
 * Create a mock TaskMetrics object suitable for file prediction testing.
 *
 * @param overrides - Partial fields to override defaults
 * @returns A complete TaskMetrics object with sensible defaults
 *
 * @example
 * ```typescript
 * const metrics = createMockTaskMetrics({
 *   predictedFiles: ["a.ts", "b.ts"],
 *   actualFilesModified: ["a.ts", "c.ts"],
 * });
 * ```
 */
function createMockTaskMetrics(overrides: Partial<TaskMetrics> = {}): TaskMetrics {
	const baseDate = new Date("2026-01-15T10:00:00Z");
	return {
		taskId: `task-${Math.random().toString(36).slice(2, 9)}`,
		sessionId: `session-${Math.random().toString(36).slice(2, 9)}`,
		objective: "Test task for file prediction",
		success: true,
		durationMs: 60000,
		totalTokens: 1000,
		agentsSpawned: 1,
		agentTypes: ["builder"],
		startedAt: baseDate,
		completedAt: new Date(baseDate.getTime() + 60000),
		complexityLevel: "simple",
		...overrides,
	};
}

/**
 * Write an array of TaskMetrics to a metrics.jsonl file in the given directory.
 *
 * @param dir - Directory to write into (creates metrics.jsonl inside it)
 * @param metrics - Array of TaskMetrics to serialize as JSONL
 *
 * @example
 * ```typescript
 * writeMetricsJsonl("/tmp/test-dir", [
 *   createMockTaskMetrics({ predictedFiles: ["a.ts"] }),
 * ]);
 * ```
 */
function writeMetricsJsonl(dir: string, metrics: TaskMetrics[]): void {
	const lines = metrics.map((m) => JSON.stringify(m)).join("\n");
	writeFileSync(join(dir, "metrics.jsonl"), `${lines}\n`, "utf-8");
}

// ==========================================================================
// Group 1: MetricsTracker state updates
// ==========================================================================

describe("MetricsTracker file prediction state", () => {
	let tracker: MetricsTracker;

	beforeEach(() => {
		tracker = new MetricsTracker();
		tracker.startTask("task-001", "Test objective", "session-001", "sonnet");
	});

	it("recordPredictedFiles stores predicted files in completeTask output", () => {
		tracker.recordPredictedFiles(["a.ts", "b.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toEqual(["a.ts", "b.ts"]);
	});

	it("recordActualFilesModified stores actual files in completeTask output", () => {
		tracker.recordActualFilesModified(["c.ts", "d.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toEqual(["c.ts", "d.ts"]);
	});

	it("calling recordPredictedFiles twice replaces the array (not appends)", () => {
		tracker.recordPredictedFiles(["first.ts"]);
		tracker.recordPredictedFiles(["second.ts", "third.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toEqual(["second.ts", "third.ts"]);
	});

	it("calling recordActualFilesModified twice replaces the array (not appends)", () => {
		tracker.recordActualFilesModified(["first.ts"]);
		tracker.recordActualFilesModified(["second.ts", "third.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toEqual(["second.ts", "third.ts"]);
	});

	it("duplicate files in predicted array are preserved in TaskMetrics", () => {
		tracker.recordPredictedFiles(["a.ts", "a.ts", "b.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		// Deduplication happens in calculateFilePredictionMetrics via Set, not here
		expect(metrics!.predictedFiles).toEqual(["a.ts", "a.ts", "b.ts"]);
	});

	it("recordPredictedFiles creates a copy (mutation safety)", () => {
		const files = ["a.ts", "b.ts"];
		tracker.recordPredictedFiles(files);
		files.push("c.ts"); // Mutate the original
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toEqual(["a.ts", "b.ts"]);
	});

	it("recordActualFilesModified creates a copy (mutation safety)", () => {
		const files = ["a.ts", "b.ts"];
		tracker.recordActualFilesModified(files);
		files.push("c.ts"); // Mutate the original
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toEqual(["a.ts", "b.ts"]);
	});
});

// ==========================================================================
// Group 2: TaskMetrics completion field inclusion
// ==========================================================================

describe("MetricsTracker completeTask file prediction fields", () => {
	let tracker: MetricsTracker;

	beforeEach(() => {
		tracker = new MetricsTracker();
		tracker.startTask("task-002", "Test objective", "session-002", "sonnet");
	});

	it("includes predictedFiles when non-empty array was recorded", () => {
		tracker.recordPredictedFiles(["a.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toBeDefined();
		expect(metrics!.predictedFiles).toEqual(["a.ts"]);
	});

	it("includes actualFilesModified when non-empty array was recorded", () => {
		tracker.recordActualFilesModified(["b.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toBeDefined();
		expect(metrics!.actualFilesModified).toEqual(["b.ts"]);
	});

	it("includes both fields when both are populated", () => {
		tracker.recordPredictedFiles(["a.ts", "b.ts"]);
		tracker.recordActualFilesModified(["b.ts", "c.ts"]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toEqual(["a.ts", "b.ts"]);
		expect(metrics!.actualFilesModified).toEqual(["b.ts", "c.ts"]);
	});

	it("excludes predictedFiles (undefined) when never recorded", () => {
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toBeUndefined();
	});

	it("excludes predictedFiles (undefined) when recorded with empty array", () => {
		tracker.recordPredictedFiles([]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.predictedFiles).toBeUndefined();
	});

	it("excludes actualFilesModified (undefined) when never recorded", () => {
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toBeUndefined();
	});

	it("excludes actualFilesModified (undefined) when recorded with empty array", () => {
		tracker.recordActualFilesModified([]);
		const metrics = tracker.completeTask(true);

		expect(metrics).not.toBeNull();
		expect(metrics!.actualFilesModified).toBeUndefined();
	});

	it("returns null when startTask was never called", () => {
		const freshTracker = new MetricsTracker();
		const metrics = freshTracker.completeTask(true);

		expect(metrics).toBeNull();
	});
});

// ==========================================================================
// Group 3: calculateFilePredictionMetrics logic
// Tested through analyzeEffectiveness() which reads JSONL and calls
// the internal calculateFilePredictionMetrics function.
// ==========================================================================

describe("calculateFilePredictionMetrics via analyzeEffectiveness", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `metrics-fp-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("exact match: precision=1.0, recall=1.0, f1=1.0", () => {
		writeMetricsJsonl(tempDir, [
			createMockTaskMetrics({
				predictedFiles: ["a.ts", "b.ts"],
				actualFilesModified: ["a.ts", "b.ts"],
			}),
		]);

		const report = analyzeEffectiveness(tempDir);

		expect(report.filePrediction.tasksWithPredictions).toBe(1);
		expect(report.filePrediction.avgPrecision).toBeCloseTo(1.0, 5);
		expect(report.filePrediction.avgRecall).toBeCloseTo(1.0, 5);
		expect(report.filePrediction.f1Score).toBeCloseTo(1.0, 5);
	});

	it("partial overlap: predicted 2/3 correct, recalled 2/3 actual", () => {
		writeMetricsJsonl(tempDir, [
			createMockTaskMetrics({
				predictedFiles: ["a.ts", "b.ts", "c.ts"],
				actualFilesModified: ["b.ts", "c.ts", "d.ts"],
			}),
		]);

		const report = analyzeEffectiveness(tempDir);

		// Precision: 2 correct / 3 predicted = 0.667
		expect(report.filePrediction.avgPrecision).toBeCloseTo(2 / 3, 3);
		// Recall: 2 correct / 3 actual = 0.667
		expect(report.filePrediction.avgRecall).toBeCloseTo(2 / 3, 3);
		// F1: 2 * (2/3 * 2/3) / (2/3 + 2/3) = 0.667
		expect(report.filePrediction.f1Score).toBeCloseTo(2 / 3, 3);
	});

	it("asymmetric partial overlap: precision=2/3, recall=2/4", () => {
		writeMetricsJsonl(tempDir, [
			createMockTaskMetrics({
				predictedFiles: ["a.ts", "b.ts", "c.ts"],
				actualFilesModified: ["a.ts", "b.ts", "d.ts", "e.ts"],
			}),
		]);

		const report = analyzeEffectiveness(tempDir);

		// Precision: 2 correct / 3 predicted = 0.667
		expect(report.filePrediction.avgPrecision).toBeCloseTo(2 / 3, 3);
		// Recall: 2 correct / 4 actual = 0.5
		expect(report.filePrediction.avgRecall).toBeCloseTo(0.5, 3);
		// F1: 2 * (0.667 * 0.5) / (0.667 + 0.5) = 0.571
		const expectedF1 = (2 * (2 / 3) * 0.5) / (2 / 3 + 0.5);
		expect(report.filePrediction.f1Score).toBeCloseTo(expectedF1, 3);
	});

	it("no overlap: precision=0, recall=0, f1=0", () => {
		writeMetricsJsonl(tempDir, [
			createMockTaskMetrics({
				predictedFiles: ["x.ts"],
				actualFilesModified: ["y.ts"],
			}),
		]);

		const report = analyzeEffectiveness(tempDir);

		expect(report.filePrediction.avgPrecision).toBe(0);
		expect(report.filePrediction.avgRecall).toBe(0);
		expect(report.filePrediction.f1Score).toBe(0);
	});

	describe("edge cases", () => {
		it("empty predictions with non-empty actual: task filtered out, tasksWithPredictions=0", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: [],
					actualFilesModified: ["a.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			// Task filtered out because predictedFiles is empty
			expect(report.filePrediction.tasksWithPredictions).toBe(0);
			expect(report.filePrediction.avgPrecision).toBe(0);
			expect(report.filePrediction.avgRecall).toBe(0);
			expect(report.filePrediction.f1Score).toBe(0);
		});

		it("non-empty predictions with empty actual: task filtered out", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: ["a.ts"],
					actualFilesModified: [],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			// Task filtered out because actualFilesModified is empty
			expect(report.filePrediction.tasksWithPredictions).toBe(0);
		});

		it("both arrays empty: task filtered out", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: [],
					actualFilesModified: [],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.tasksWithPredictions).toBe(0);
		});

		it("undefined predictedFiles: task filtered out", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: undefined,
					actualFilesModified: ["a.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.tasksWithPredictions).toBe(0);
		});

		it("undefined actualFilesModified: task filtered out", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: ["a.ts"],
					actualFilesModified: undefined,
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.tasksWithPredictions).toBe(0);
		});

		it("duplicate files in predictions are deduplicated via Set", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: ["a.ts", "a.ts"],
					actualFilesModified: ["a.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			// Set deduplicates: predicted = {a.ts}, actual = {a.ts}
			// Precision: 1/1 = 1.0, Recall: 1/1 = 1.0
			expect(report.filePrediction.avgPrecision).toBeCloseTo(1.0, 5);
			expect(report.filePrediction.avgRecall).toBeCloseTo(1.0, 5);
		});

		it("no metrics file: returns zero values", () => {
			// tempDir exists but has no metrics.jsonl
			const emptyDir = join(tmpdir(), `metrics-fp-empty-${Date.now()}`);
			mkdirSync(emptyDir, { recursive: true });

			try {
				const report = analyzeEffectiveness(emptyDir);

				expect(report.filePrediction.tasksWithPredictions).toBe(0);
				expect(report.filePrediction.avgPrecision).toBe(0);
				expect(report.filePrediction.avgRecall).toBe(0);
				expect(report.filePrediction.f1Score).toBe(0);
				expect(report.filePrediction.topAccurateFiles).toEqual([]);
			} finally {
				rmSync(emptyDir, { recursive: true, force: true });
			}
		});
	});

	describe("multiple tasks aggregation", () => {
		it("averages precision and recall across multiple tasks", () => {
			writeMetricsJsonl(tempDir, [
				// Task 1: perfect prediction (precision=1.0, recall=1.0)
				createMockTaskMetrics({
					predictedFiles: ["a.ts"],
					actualFilesModified: ["a.ts"],
				}),
				// Task 2: no overlap (precision=0, recall=0)
				createMockTaskMetrics({
					predictedFiles: ["b.ts"],
					actualFilesModified: ["c.ts"],
				}),
				// Task 3: partial (precision=0.5, recall=1.0)
				createMockTaskMetrics({
					predictedFiles: ["d.ts", "e.ts"],
					actualFilesModified: ["d.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.tasksWithPredictions).toBe(3);
			// avgPrecision = (1.0 + 0 + 0.5) / 3 = 0.5
			expect(report.filePrediction.avgPrecision).toBeCloseTo(0.5, 3);
			// avgRecall = (1.0 + 0 + 1.0) / 3 = 0.667
			expect(report.filePrediction.avgRecall).toBeCloseTo(2 / 3, 3);
		});

		it("f1 score is harmonic mean of averaged precision and recall", () => {
			writeMetricsJsonl(tempDir, [
				// Task 1: precision=1.0, recall=0.5 (predicted 1 of 2)
				createMockTaskMetrics({
					predictedFiles: ["a.ts"],
					actualFilesModified: ["a.ts", "b.ts"],
				}),
				// Task 2: precision=0.5, recall=1.0 (predicted 2, 1 wrong)
				createMockTaskMetrics({
					predictedFiles: ["c.ts", "d.ts"],
					actualFilesModified: ["c.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			// avgPrecision = (1.0 + 0.5) / 2 = 0.75
			// avgRecall = (0.5 + 1.0) / 2 = 0.75
			// f1 = 2 * 0.75 * 0.75 / (0.75 + 0.75) = 0.75
			expect(report.filePrediction.avgPrecision).toBeCloseTo(0.75, 3);
			expect(report.filePrediction.avgRecall).toBeCloseTo(0.75, 3);
			expect(report.filePrediction.f1Score).toBeCloseTo(0.75, 3);
		});

		it("f1 score is 0 when both precision and recall are 0 (avoids division by zero)", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({
					predictedFiles: ["x.ts"],
					actualFilesModified: ["y.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.avgPrecision).toBe(0);
			expect(report.filePrediction.avgRecall).toBe(0);
			// f1 = 0 because avgPrecision + avgRecall = 0
			expect(report.filePrediction.f1Score).toBe(0);
		});
	});

	describe("topAccurateFiles", () => {
		it("requires >= 3 predictions to appear in topAccurateFiles", () => {
			writeMetricsJsonl(tempDir, [
				// "rare.ts" predicted only 2 times - should NOT appear
				createMockTaskMetrics({
					predictedFiles: ["rare.ts"],
					actualFilesModified: ["rare.ts"],
				}),
				createMockTaskMetrics({
					predictedFiles: ["rare.ts"],
					actualFilesModified: ["rare.ts"],
				}),
				// "common.ts" predicted 3 times - should appear
				createMockTaskMetrics({
					predictedFiles: ["common.ts"],
					actualFilesModified: ["common.ts"],
				}),
				createMockTaskMetrics({
					predictedFiles: ["common.ts"],
					actualFilesModified: ["common.ts"],
				}),
				createMockTaskMetrics({
					predictedFiles: ["common.ts"],
					actualFilesModified: ["common.ts"],
				}),
			]);

			const report = analyzeEffectiveness(tempDir);

			const topFiles = report.filePrediction.topAccurateFiles;
			const topFileNames = topFiles.map((f) => f.file);

			expect(topFileNames).toContain("common.ts");
			expect(topFileNames).not.toContain("rare.ts");
		});

		it("sorts by precision descending", () => {
			writeMetricsJsonl(tempDir, [
				// "accurate.ts" predicted 3 times, always correct -> precision=1.0
				createMockTaskMetrics({ predictedFiles: ["accurate.ts"], actualFilesModified: ["accurate.ts"] }),
				createMockTaskMetrics({ predictedFiles: ["accurate.ts"], actualFilesModified: ["accurate.ts"] }),
				createMockTaskMetrics({ predictedFiles: ["accurate.ts"], actualFilesModified: ["accurate.ts"] }),
				// "inaccurate.ts" predicted 3 times, correct only once -> precision=0.33
				createMockTaskMetrics({ predictedFiles: ["inaccurate.ts"], actualFilesModified: ["inaccurate.ts"] }),
				createMockTaskMetrics({ predictedFiles: ["inaccurate.ts"], actualFilesModified: ["other.ts"] }),
				createMockTaskMetrics({ predictedFiles: ["inaccurate.ts"], actualFilesModified: ["other2.ts"] }),
			]);

			const report = analyzeEffectiveness(tempDir);

			const topFiles = report.filePrediction.topAccurateFiles;
			expect(topFiles.length).toBeGreaterThanOrEqual(2);
			// First entry should be the most accurate
			expect(topFiles[0].file).toBe("accurate.ts");
			expect(topFiles[0].precision).toBeCloseTo(1.0, 3);
			// Second entry should be less accurate
			const inaccurateEntry = topFiles.find((f) => f.file === "inaccurate.ts");
			expect(inaccurateEntry).toBeDefined();
			expect(inaccurateEntry!.precision).toBeCloseTo(1 / 3, 3);
		});

		it("returns empty when no file has >= 3 predictions", () => {
			writeMetricsJsonl(tempDir, [
				createMockTaskMetrics({ predictedFiles: ["a.ts"], actualFilesModified: ["a.ts"] }),
				createMockTaskMetrics({ predictedFiles: ["b.ts"], actualFilesModified: ["b.ts"] }),
			]);

			const report = analyzeEffectiveness(tempDir);

			expect(report.filePrediction.topAccurateFiles).toEqual([]);
		});
	});
});
