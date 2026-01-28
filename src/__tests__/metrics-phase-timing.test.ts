/**
 * Metrics Phase Timing Tests
 *
 * Tests for phase timing functionality in the MetricsTracker class,
 * covering sequential phases, overlapping phases, incomplete phases,
 * and invalid transitions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsTracker } from "../metrics.js";

describe("MetricsTracker - Phase Timing", () => {
	let tracker: MetricsTracker;

	beforeEach(() => {
		// Create fresh tracker instance for each test
		tracker = new MetricsTracker();
		// Mock Date.now for deterministic timing
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("basic operations", () => {
		describe("startPhase", () => {
			it("starts a new phase with current timestamp", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");
				const _startTime = Date.now();

				tracker.startPhase("planning");

				// Advance time and end phase to verify timing was captured
				vi.advanceTimersByTime(1000);
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(1000);
			});

			it("starts multiple sequential phases", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				// Planning phase
				tracker.startPhase("planning");
				vi.advanceTimersByTime(500);
				tracker.endPhase();

				// Execution phase
				tracker.startPhase("execution");
				vi.advanceTimersByTime(1000);
				tracker.endPhase();

				// Verification phase
				tracker.startPhase("verification");
				vi.advanceTimersByTime(300);
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(500);
				expect(timing.executionMs).toBe(1000);
				expect(timing.verificationMs).toBe(300);
			});

			it("automatically ends previous phase when starting a new one", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				// Start planning
				tracker.startPhase("planning");
				vi.advanceTimersByTime(500);

				// Start execution without explicitly ending planning
				tracker.startPhase("execution");
				vi.advanceTimersByTime(1000);
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				// Planning should be recorded even though we didn't call endPhase
				expect(timing.planningMs).toBe(500);
				expect(timing.executionMs).toBe(1000);
			});
		});

		describe("endPhase", () => {
			it("ends an active phase and records duration", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.startPhase("execution");
				vi.advanceTimersByTime(2000);
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				expect(timing.executionMs).toBe(2000);
			});

			it("does nothing when called without an active phase", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				// Call endPhase without startPhase
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				expect(Object.keys(timing)).toHaveLength(0);
			});

			it("can be called multiple times safely", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.startPhase("planning");
				vi.advanceTimersByTime(500);
				tracker.endPhase();

				// Call endPhase again - should be safe
				tracker.endPhase();

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(500);
			});
		});

		describe("recordPhaseTimings", () => {
			it("records phase timings from external source", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.recordPhaseTimings({
					planning: 800,
					execution: 2000,
					verification: 400,
				});

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(800);
				expect(timing.executionMs).toBe(2000);
				expect(timing.verificationMs).toBe(400);
			});

			it("accumulates when called multiple times", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.recordPhaseTimings({
					planning: 500,
					execution: 1000,
				});

				tracker.recordPhaseTimings({
					planning: 300,
					execution: 1500,
				});

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(800); // 500 + 300
				expect(timing.executionMs).toBe(2500); // 1000 + 1500
			});

			it("maps worker phase names to standard names", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.recordPhaseTimings({
					contextPrep: 600,
					agentExecution: 1800,
				});

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(600); // contextPrep maps to planning
				expect(timing.executionMs).toBe(1800); // agentExecution maps to execution
			});

			it("handles both standard and worker phase names", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.recordPhaseTimings({
					contextPrep: 400,
					planning: 200,
					agentExecution: 1000,
					execution: 500,
				});

				const timing = tracker.getPhaseTiming();
				expect(timing.planningMs).toBe(600); // 400 + 200
				expect(timing.executionMs).toBe(1500); // 1000 + 500
			});
		});

		describe("getPhaseTiming", () => {
			it("returns empty object when no phases recorded", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				const timing = tracker.getPhaseTiming();

				expect(timing).toEqual({});
			});

			it("returns a copy of timing data, not reference", () => {
				tracker.startTask("task-1", "test objective", "session-1", "sonnet");

				tracker.startPhase("planning");
				vi.advanceTimersByTime(500);
				tracker.endPhase();

				const timing1 = tracker.getPhaseTiming();
				const timing2 = tracker.getPhaseTiming();

				// Modify one copy
				timing1.planningMs = 9999;

				// Other copy should be unchanged
				expect(timing2.planningMs).toBe(500);
			});
		});
	});

	describe("edge cases", () => {
		it("handles overlapping phases by auto-ending previous", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			// Start planning
			tracker.startPhase("planning");
			vi.advanceTimersByTime(500);

			// Start execution without ending planning
			tracker.startPhase("execution");
			vi.advanceTimersByTime(1000);

			// Start verification without ending execution
			tracker.startPhase("verification");
			vi.advanceTimersByTime(300);

			tracker.endPhase();

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(500);
			expect(timing.executionMs).toBe(1000);
			expect(timing.verificationMs).toBe(300);
		});

		it("handles phase without endPhase call", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.startPhase("planning");
			vi.advanceTimersByTime(500);
			tracker.endPhase();

			// Start execution but don't end it
			tracker.startPhase("execution");
			vi.advanceTimersByTime(1000);

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(500);
			// Execution hasn't ended, so it won't be in timing yet
			expect(timing.executionMs).toBeUndefined();
		});

		it("accumulates timing when same phase runs multiple times", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			// First verification pass
			tracker.startPhase("verification");
			vi.advanceTimersByTime(300);
			tracker.endPhase();

			// Second verification pass
			tracker.startPhase("verification");
			vi.advanceTimersByTime(200);
			tracker.endPhase();

			// Third verification pass
			tracker.startPhase("verification");
			vi.advanceTimersByTime(250);
			tracker.endPhase();

			const timing = tracker.getPhaseTiming();
			expect(timing.verificationMs).toBe(750); // 300 + 200 + 250
		});

		it("handles zero-duration phases", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.startPhase("planning");
			// Don't advance time
			tracker.endPhase();

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(0);
		});

		it("resets phase timing when startTask is called", () => {
			// First task
			tracker.startTask("task-1", "first objective", "session-1", "sonnet");
			tracker.startPhase("planning");
			vi.advanceTimersByTime(500);
			tracker.endPhase();

			// Second task
			tracker.startTask("task-2", "second objective", "session-1", "sonnet");

			const timing = tracker.getPhaseTiming();
			// Should be empty after reset
			expect(Object.keys(timing)).toHaveLength(0);
		});

		it("handles all phase types in sequence", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			const phases: Array<"planning" | "execution" | "verification" | "review" | "merge"> = [
				"planning",
				"execution",
				"verification",
				"review",
				"merge",
			];

			for (const phase of phases) {
				tracker.startPhase(phase);
				vi.advanceTimersByTime(100);
				tracker.endPhase();
			}

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(100);
			expect(timing.executionMs).toBe(100);
			expect(timing.verificationMs).toBe(100);
			expect(timing.reviewMs).toBe(100);
			expect(timing.mergeMs).toBe(100);
		});

		it("handles mixed manual and recorded phase timings", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			// Manual phase timing
			tracker.startPhase("planning");
			vi.advanceTimersByTime(500);
			tracker.endPhase();

			// Recorded phase timing
			tracker.recordPhaseTimings({
				execution: 1000,
				verification: 400,
			});

			// More manual timing
			tracker.startPhase("review");
			vi.advanceTimersByTime(300);
			tracker.endPhase();

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(500);
			expect(timing.executionMs).toBe(1000);
			expect(timing.verificationMs).toBe(400);
			expect(timing.reviewMs).toBe(300);
		});

		it("accumulates recorded timings with manual timings", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			// Manual timing
			tracker.startPhase("execution");
			vi.advanceTimersByTime(800);
			tracker.endPhase();

			// Recorded timing for same phase
			tracker.recordPhaseTimings({
				execution: 700,
			});

			const timing = tracker.getPhaseTiming();
			expect(timing.executionMs).toBe(1500); // 800 + 700
		});
	});

	describe("integration with task lifecycle", () => {
		it("includes phase timing in completeTask output", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.startPhase("planning");
			vi.advanceTimersByTime(400);
			tracker.endPhase();

			tracker.startPhase("execution");
			vi.advanceTimersByTime(1200);
			tracker.endPhase();

			const metrics = tracker.completeTask(true);

			expect(metrics).toBeDefined();
			expect(metrics?.phaseTiming).toBeDefined();
			expect(metrics?.phaseTiming?.planningMs).toBe(400);
			expect(metrics?.phaseTiming?.executionMs).toBe(1200);
		});

		it("omits phaseTiming when no phases recorded", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			const metrics = tracker.completeTask(true);

			expect(metrics).toBeDefined();
			expect(metrics?.phaseTiming).toBeUndefined();
		});

		it("handles phase timing across retries", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			// First attempt
			tracker.startPhase("execution");
			vi.advanceTimersByTime(800);
			tracker.endPhase();

			tracker.startPhase("verification");
			vi.advanceTimersByTime(200);
			tracker.endPhase();

			// Second attempt (after failure)
			tracker.startPhase("execution");
			vi.advanceTimersByTime(600);
			tracker.endPhase();

			tracker.startPhase("verification");
			vi.advanceTimersByTime(150);
			tracker.endPhase();

			const timing = tracker.getPhaseTiming();
			expect(timing.executionMs).toBe(1400); // 800 + 600
			expect(timing.verificationMs).toBe(350); // 200 + 150
		});

		it("preserves phase timing through task completion", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.recordPhaseTimings({
				planning: 500,
				execution: 2000,
				verification: 400,
				review: 300,
				merge: 100,
			});

			const metrics = tracker.completeTask(true);

			expect(metrics?.phaseTiming).toEqual({
				planningMs: 500,
				executionMs: 2000,
				verificationMs: 400,
				reviewMs: 300,
				mergeMs: 100,
			});
		});
	});

	describe("worker phase name mapping", () => {
		it("maps contextPrep to planning", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.recordPhaseTimings({ contextPrep: 500 });

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(500);
		});

		it("maps agentExecution to execution", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.recordPhaseTimings({ agentExecution: 1500 });

			const timing = tracker.getPhaseTiming();
			expect(timing.executionMs).toBe(1500);
		});

		it("accepts standard phase names", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			tracker.recordPhaseTimings({
				planning: 400,
				execution: 1200,
				verification: 300,
				review: 200,
				merge: 100,
			});

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(400);
			expect(timing.executionMs).toBe(1200);
			expect(timing.verificationMs).toBe(300);
			expect(timing.reviewMs).toBe(200);
			expect(timing.mergeMs).toBe(100);
		});

		it("handles undefined phase values gracefully", () => {
			tracker.startTask("task-1", "test objective", "session-1", "sonnet");

			const timings: Record<string, number | undefined> = {
				planning: 400,
				execution: undefined,
				verification: 300,
			};

			tracker.recordPhaseTimings(timings as Record<string, number>);

			const timing = tracker.getPhaseTiming();
			expect(timing.planningMs).toBe(400);
			expect(timing.executionMs).toBeUndefined();
			expect(timing.verificationMs).toBe(300);
		});
	});
});
