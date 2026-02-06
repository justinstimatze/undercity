/**
 * Concurrency Utility Tests
 *
 * Tests for runWithConcurrency semaphore-based batch executor.
 */

import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../concurrency.js";

describe("runWithConcurrency", () => {
	it("returns empty array for empty input", async () => {
		const results = await runWithConcurrency([], 3);
		expect(results).toEqual([]);
	});

	it("executes all tasks and returns results in order", async () => {
		const tasks = [async () => "a", async () => "b", async () => "c"];

		const results = await runWithConcurrency(tasks, 2);
		expect(results).toEqual(["a", "b", "c"]);
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;

		const createTask = (value: number) => async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			// Yield to event loop so other tasks can start
			await new Promise((resolve) => setTimeout(resolve, 10));
			running--;
			return value;
		};

		const tasks = Array.from({ length: 10 }, (_, i) => createTask(i));
		const results = await runWithConcurrency(tasks, 3);

		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(maxRunning).toBeLessThanOrEqual(3);
	});

	it("handles limit larger than task count", async () => {
		const tasks = [async () => 1, async () => 2];
		const results = await runWithConcurrency(tasks, 100);
		expect(results).toEqual([1, 2]);
	});

	it("uses default limit of 5", async () => {
		let running = 0;
		let maxRunning = 0;

		const createTask = (value: number) => async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 10));
			running--;
			return value;
		};

		const tasks = Array.from({ length: 15 }, (_, i) => createTask(i));
		await runWithConcurrency(tasks);

		expect(maxRunning).toBeLessThanOrEqual(5);
	});

	it("propagates errors from tasks", async () => {
		const tasks = [
			async () => "ok",
			async () => {
				throw new Error("task failed");
			},
			async () => "never reached",
		];

		await expect(runWithConcurrency(tasks, 2)).rejects.toThrow("task failed");
	});

	it("clamps limit to minimum 1", async () => {
		const tasks = [async () => "a", async () => "b"];
		const results = await runWithConcurrency(tasks, 0);
		expect(results).toEqual(["a", "b"]);
	});
});
