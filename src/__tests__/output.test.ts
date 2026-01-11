/**
 * Output module tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
	});
});
