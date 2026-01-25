/**
 * Output module tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compat,
	configureOutput,
	createProgressTracker,
	debug,
	error,
	getOutputMode,
	header,
	info,
	isHumanMode,
	keyValue,
	list,
	metrics,
	progress,
	section,
	status,
	success,
	summary,
	taskComplete,
	taskFailed,
	taskStart,
	warning,
	workerAttempt,
	workerEscalation,
	workerPhase,
	workerReview,
	workerVerification,
} from "../output.js";

describe("output", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		// Reset to agent mode (default for testing)
		configureOutput({ mode: "agent", verbose: false });
	});

	describe("mode detection and configuration", () => {
		it("should default to agent mode in non-TTY", () => {
			// In test environment, stdout is not a TTY
			configureOutput({ mode: "agent" });
			expect(getOutputMode()).toBe("agent");
			expect(isHumanMode()).toBe(false);
		});

		it("should allow switching to human mode", () => {
			configureOutput({ mode: "human" });
			expect(getOutputMode()).toBe("human");
			expect(isHumanMode()).toBe(true);
		});
	});

	describe("agent mode (JSON output)", () => {
		beforeEach(() => {
			configureOutput({ mode: "agent" });
		});

		it("should output JSON for info", () => {
			info("Test message");
			expect(consoleSpy).toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("info");
			expect(output.message).toBe("Test message");
			expect(output.timestamp).toBeDefined();
		});

		it("should output JSON for success", () => {
			success("Task done");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("success");
			expect(output.message).toBe("Task done");
		});

		it("should output JSON for error", () => {
			error("Something failed", { code: 500 });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("error");
			expect(output.message).toBe("Something failed");
			expect(output.data?.code).toBe(500);
		});

		it("should output JSON for warning", () => {
			warning("Be careful");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("warning");
		});

		it("should output JSON for progress", () => {
			progress("Processing", { current: 5, total: 10, label: "items" });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("progress");
			expect(output.data?.progress.current).toBe(5);
			expect(output.data?.progress.total).toBe(10);
		});

		it("should output JSON for status", () => {
			status("Running");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("status");
		});

		it("should output JSON for taskStart", () => {
			taskStart("task-123", "Starting build");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("task_start");
			expect(output.data?.taskId).toBe("task-123");
		});

		it("should output JSON for taskComplete", () => {
			taskComplete("task-123", "Build finished");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("task_complete");
			expect(output.data?.taskId).toBe("task-123");
		});

		it("should output JSON for taskFailed", () => {
			taskFailed("task-123", "Build failed", "Syntax error");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("task_failed");
			expect(output.data?.taskId).toBe("task-123");
			expect(output.data?.error).toBe("Syntax error");
		});

		it("should output JSON for metrics", () => {
			metrics("Performance", { cpu: 50, memory: 100 });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("metrics");
			expect(output.data?.cpu).toBe(50);
		});

		it("should not output debug in non-verbose mode", () => {
			debug("Debug info");
			expect(consoleSpy).not.toHaveBeenCalled();
		});

		it("should output debug in verbose mode", () => {
			configureOutput({ mode: "agent", verbose: true });
			debug("Debug info");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("debug");
		});

		it("should output JSON for header", () => {
			header("Title", "Subtitle");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("info");
			expect(output.message).toBe("Title");
			expect(output.data?.subtitle).toBe("Subtitle");
		});

		it("should output JSON for section", () => {
			section("Phase 1");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("status");
			expect(output.message).toBe("Phase 1");
		});

		it("should output JSON for summary", () => {
			summary("Results", [
				{ label: "Passed", value: 10, status: "good" },
				{ label: "Failed", value: 2, status: "bad" },
			]);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("metrics");
			expect(output.data?.Passed).toBe(10);
			expect(output.data?.Failed).toBe(2);
		});

		it("should output JSON for keyValue", () => {
			keyValue("key", "value");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("info");
			expect(output.data?.key).toBe("value");
		});

		it("should output JSON for list", () => {
			list(["item1", "item2", "item3"]);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("info");
			expect(output.data?.items).toEqual(["item1", "item2", "item3"]);
		});
	});

	describe("human mode (formatted output)", () => {
		beforeEach(() => {
			configureOutput({ mode: "human" });
		});

		it("should output formatted text for info", () => {
			info("Test message");
			expect(consoleSpy).toHaveBeenCalled();
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("Test message");
		});

		it("should output formatted text for success", () => {
			success("Task done");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("Task done");
			expect(output).toContain("✓");
		});

		it("should output formatted text for error", () => {
			error("Something failed");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("Something failed");
			expect(output).toContain("✗");
		});

		it("should output formatted text for warning", () => {
			warning("Be careful");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("Be careful");
			expect(output).toContain("⚠");
		});
	});

	describe("progress tracker", () => {
		beforeEach(() => {
			configureOutput({ mode: "agent" });
		});

		it("should create progress tracker and track increments", () => {
			const tracker = createProgressTracker(10, "items");
			tracker.increment("Item 1");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("progress");
			expect(output.data?.progress.current).toBe(1);
			expect(output.data?.progress.total).toBe(10);
		});

		it("should output success on complete", () => {
			const tracker = createProgressTracker(2, "items");
			tracker.increment();
			tracker.complete("All done");

			// Last call should be success
			const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0];
			const output = JSON.parse(lastCall);
			expect(output.type).toBe("success");
			expect(output.message).toContain("All done");
		});

		it("should output default message on complete without message", () => {
			const tracker = createProgressTracker(1, "items");
			tracker.increment();
			tracker.complete();

			const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0];
			const output = JSON.parse(lastCall);
			expect(output.type).toBe("success");
			expect(output.message).toContain("items complete");
		});
	});

	describe("worker-level events (agent mode)", () => {
		beforeEach(() => {
			configureOutput({ mode: "agent" });
		});

		it("should output worker phase event", () => {
			workerPhase("task-123", "analyzing");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_phase");
			expect(output.data?.taskId).toBe("task-123");
			expect(output.data?.phase).toBe("analyzing");
		});

		it("should output worker attempt event", () => {
			workerAttempt("task-123", 1, 3, "sonnet");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_attempt");
			expect(output.message).toContain("Attempt 1/3");
			expect(output.data?.model).toBe("sonnet");
		});

		it("should output worker verification passed", () => {
			workerVerification("task-123", true);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_verification");
			expect(output.message).toBe("Verification passed");
			expect(output.data?.passed).toBe(true);
		});

		it("should output worker verification failed with issues", () => {
			workerVerification("task-123", false, ["lint error", "type error"]);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_verification");
			expect(output.message).toContain("lint error");
			expect(output.data?.passed).toBe(false);
		});

		it("should output worker escalation event", () => {
			workerEscalation("task-123", "sonnet", "sonnet", "complexity");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_escalation");
			expect(output.message).toContain("sonnet → opus");
			expect(output.message).toContain("complexity");
		});

		it("should output worker escalation without reason", () => {
			workerEscalation("task-123", "sonnet", "opus");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.message).toBe("Escalating: sonnet → opus");
		});

		it("should output worker review passed", () => {
			workerReview("task-123", "fast", 1, 2, "passed");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe("worker_review");
			expect(output.message).toContain("Review 1/2");
			expect(output.data?.result).toBe("passed");
		});

		it("should output worker review fixing", () => {
			workerReview("task-123", "slow", 2, 3, "fixing");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.message).toContain("fixing issues");
		});

		it("should output worker review escalating", () => {
			workerReview("task-123", "opus", 3, 3, "escalating");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.message).toContain("escalating");
		});
	});

	describe("human mode formatting", () => {
		beforeEach(() => {
			configureOutput({ mode: "human" });
		});

		it("should output header with title and subtitle", () => {
			header("Title", "Subtitle");
			// Human mode outputs multiple lines
			expect(consoleSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
			const calls = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
			expect(calls).toContain("Title");
		});

		it("should output header with just title", () => {
			header("Just Title");
			const calls = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
			expect(calls).toContain("Just Title");
		});

		it("should output section divider", () => {
			section("Section Title");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("Section Title");
		});

		it("should output summary with colored status", () => {
			summary("Results", [
				{ label: "Good", value: 10, status: "good" },
				{ label: "Bad", value: 2, status: "bad" },
				{ label: "Neutral", value: 5, status: "neutral" },
			]);
			const calls = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
			expect(calls).toContain("Results");
			expect(calls).toContain("Good:");
		});

		it("should output key-value pair", () => {
			keyValue("key", "value");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("key:");
			expect(output).toContain("value");
		});

		it("should output list items", () => {
			list(["item1", "item2"]);
			expect(consoleSpy.mock.calls).toHaveLength(2);
		});

		it("should output list items with custom prefix", () => {
			list(["first"], "-");
			const output = consoleSpy.mock.calls[0][0];
			expect(output).toContain("-");
			expect(output).toContain("first");
		});
	});

	describe("compat layer", () => {
		it("should pass through in human mode", () => {
			configureOutput({ mode: "human" });
			compat.log("test message");
			expect(consoleSpy.mock.calls[0][0]).toBe("test message");
		});

		it("should strip ANSI codes in agent mode", () => {
			configureOutput({ mode: "agent" });
			compat.log("\x1b[32mcolored\x1b[0m");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.message).toBe("colored");
		});
	});
});
