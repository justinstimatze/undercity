/**
 * Tests for orchestrator/health-monitoring.ts
 *
 * Tests worker health monitoring, stuck detection, and recovery nudging.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkWorkerHealth,
	createHealthMonitorState,
	type HealthMonitorConfig,
	type HealthMonitorDependencies,
	type HealthMonitorState,
	handleStuckWorker,
	startHealthMonitoring,
	stopHealthMonitoring,
} from "../orchestrator/health-monitoring.js";
import type { ActiveTaskState } from "../types.js";

// Mock modules
vi.mock("node:fs", () => ({
	writeFileSync: vi.fn(),
}));

vi.mock("../output.js", () => ({
	debug: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../names.js", () => ({
	nameFromId: vi.fn((id: string) => `worker-${id.slice(0, 6)}`),
}));

vi.mock("../persistence.js", () => ({
	readTaskAssignment: vi.fn(),
}));

describe("orchestrator/health-monitoring", () => {
	const createConfig = (overrides: Partial<HealthMonitorConfig> = {}): HealthMonitorConfig => ({
		enabled: true,
		checkIntervalMs: 60000,
		stuckThresholdMs: 300000,
		attemptRecovery: true,
		maxRecoveryAttempts: 2,
		...overrides,
	});

	const createActiveTask = (overrides: Partial<ActiveTaskState> = {}): ActiveTaskState => ({
		taskId: "task-abc123",
		task: "Test task",
		status: "running",
		startedAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
		worktreePath: "/tmp/worktree-abc",
		branch: "task-abc123",
		...overrides,
	});

	describe("createHealthMonitorState", () => {
		it("creates initial state with null interval handle", () => {
			const state = createHealthMonitorState();
			expect(state.intervalHandle).toBeNull();
		});

		it("creates initial state with empty recovery attempts map", () => {
			const state = createHealthMonitorState();
			expect(state.recoveryAttempts).toBeInstanceOf(Map);
			expect(state.recoveryAttempts.size).toBe(0);
		});
	});

	describe("startHealthMonitoring", () => {
		let state: HealthMonitorState;

		beforeEach(() => {
			vi.useFakeTimers();
			state = createHealthMonitorState();
		});

		afterEach(() => {
			stopHealthMonitoring(state);
			vi.useRealTimers();
		});

		it("sets interval handle when enabled", () => {
			const config = createConfig();
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: vi.fn(() => []),
			};

			startHealthMonitoring(state, config, deps);

			expect(state.intervalHandle).not.toBeNull();
		});

		it("does not set interval when disabled", () => {
			const config = createConfig({ enabled: false });
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: vi.fn(() => []),
			};

			startHealthMonitoring(state, config, deps);

			expect(state.intervalHandle).toBeNull();
		});

		it("calls checkWorkerHealth at configured interval", () => {
			const config = createConfig({ checkIntervalMs: 1000 });
			const scanActiveTasks = vi.fn(() => []);
			const deps: HealthMonitorDependencies = { scanActiveTasks };

			startHealthMonitoring(state, config, deps);

			// Should not be called immediately
			expect(scanActiveTasks).not.toHaveBeenCalled();

			// Advance time by one interval
			vi.advanceTimersByTime(1000);
			expect(scanActiveTasks).toHaveBeenCalledTimes(1);

			// Advance again
			vi.advanceTimersByTime(1000);
			expect(scanActiveTasks).toHaveBeenCalledTimes(2);
		});

		it("clears existing interval before starting new one", () => {
			const config = createConfig({ checkIntervalMs: 1000 });
			const scanActiveTasks1 = vi.fn(() => []);
			const scanActiveTasks2 = vi.fn(() => []);

			startHealthMonitoring(state, config, { scanActiveTasks: scanActiveTasks1 });
			const firstHandle = state.intervalHandle;

			startHealthMonitoring(state, config, { scanActiveTasks: scanActiveTasks2 });
			const secondHandle = state.intervalHandle;

			// Should have different handles
			expect(secondHandle).not.toBe(firstHandle);

			// Advance time - only second scanner should be called
			vi.advanceTimersByTime(1000);
			expect(scanActiveTasks1).not.toHaveBeenCalled();
			expect(scanActiveTasks2).toHaveBeenCalledTimes(1);
		});
	});

	describe("stopHealthMonitoring", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("clears interval handle", () => {
			const state = createHealthMonitorState();
			const config = createConfig();
			const deps: HealthMonitorDependencies = { scanActiveTasks: vi.fn(() => []) };

			startHealthMonitoring(state, config, deps);
			expect(state.intervalHandle).not.toBeNull();

			stopHealthMonitoring(state);
			expect(state.intervalHandle).toBeNull();
		});

		it("clears recovery attempts", () => {
			const state = createHealthMonitorState();
			state.recoveryAttempts.set("task-1", 2);
			state.recoveryAttempts.set("task-2", 1);

			stopHealthMonitoring(state);

			expect(state.recoveryAttempts.size).toBe(0);
		});

		it("is safe to call when not started", () => {
			const state = createHealthMonitorState();

			// Should not throw
			expect(() => stopHealthMonitoring(state)).not.toThrow();
			expect(state.intervalHandle).toBeNull();
		});
	});

	describe("checkWorkerHealth", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("skips pending tasks", async () => {
			const { readTaskAssignment } = await import("../persistence.js");
			const state = createHealthMonitorState();
			const config = createConfig();
			const task = createActiveTask({ status: "pending" });
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(readTaskAssignment).not.toHaveBeenCalled();
		});

		it("checks running tasks for checkpoint staleness", async () => {
			const { readTaskAssignment } = await import("../persistence.js");
			vi.mocked(readTaskAssignment).mockReturnValue({
				taskId: "task-abc123",
				task: "Test task",
				baseCommit: "abc",
				assignedAt: new Date().toISOString(),
				checkpoint: {
					phase: "executing",
					model: "sonnet",
					attempts: 1,
					savedAt: new Date().toISOString(), // Recent checkpoint
				},
			});

			const state = createHealthMonitorState();
			const config = createConfig();
			const task = createActiveTask();
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(readTaskAssignment).toHaveBeenCalledWith("/tmp/worktree-abc");
		});

		it("detects stuck worker with stale checkpoint", async () => {
			const { readTaskAssignment } = await import("../persistence.js");
			const outputMock = await import("../output.js");

			// Checkpoint is 10 minutes old (over 5 min threshold)
			vi.mocked(readTaskAssignment).mockReturnValue({
				taskId: "task-abc123",
				task: "Test task",
				baseCommit: "abc",
				assignedAt: new Date().toISOString(),
				checkpoint: {
					phase: "verifying",
					model: "sonnet",
					attempts: 1,
					savedAt: new Date(Date.now() - 600000).toISOString(), // 10 min ago
				},
			});

			const state = createHealthMonitorState();
			const config = createConfig({ stuckThresholdMs: 300000 }); // 5 min threshold
			const task = createActiveTask();
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("stuck in 'verifying' phase"));
		});

		it("detects worker with no checkpoint after threshold", async () => {
			const { readTaskAssignment } = await import("../persistence.js");
			const outputMock = await import("../output.js");

			// No checkpoint data
			vi.mocked(readTaskAssignment).mockReturnValue(null);

			const state = createHealthMonitorState();
			const config = createConfig({ stuckThresholdMs: 60000 }); // 1 min threshold
			// Task started 2 minutes ago
			const task = createActiveTask({
				startedAt: new Date(Date.now() - 120000).toISOString(),
			});
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("has no checkpoint after"));
		});

		it("does not flag worker within threshold", async () => {
			const { readTaskAssignment } = await import("../persistence.js");
			const outputMock = await import("../output.js");

			// Recent checkpoint (1 min old, threshold is 5 min)
			vi.mocked(readTaskAssignment).mockReturnValue({
				taskId: "task-abc123",
				task: "Test task",
				baseCommit: "abc",
				assignedAt: new Date().toISOString(),
				checkpoint: {
					phase: "executing",
					model: "sonnet",
					attempts: 1,
					savedAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
				},
			});

			const state = createHealthMonitorState();
			const config = createConfig({ stuckThresholdMs: 300000 }); // 5 min threshold
			const task = createActiveTask();
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(outputMock.warning).not.toHaveBeenCalled();
		});

		it("skips tasks without worktreePath", async () => {
			const { readTaskAssignment } = await import("../persistence.js");

			const state = createHealthMonitorState();
			const config = createConfig();
			const task = createActiveTask({ worktreePath: undefined });
			const deps: HealthMonitorDependencies = {
				scanActiveTasks: () => [task],
			};

			checkWorkerHealth(state, config, deps);

			expect(readTaskAssignment).not.toHaveBeenCalled();
		});
	});

	describe("handleStuckWorker", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("increments recovery attempts on first nudge", async () => {
			const outputMock = await import("../output.js");

			const state = createHealthMonitorState();
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "executing");

			expect(state.recoveryAttempts.get("task-abc123")).toBe(1);
			expect(outputMock.info).toHaveBeenCalledWith(expect.stringContaining("recovery attempt 1/2"));
		});

		it("writes nudge file on recovery attempt", async () => {
			const { writeFileSync } = await import("node:fs");

			const state = createHealthMonitorState();
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "verifying");

			expect(writeFileSync).toHaveBeenCalledWith(
				"/tmp/worktree/.undercity-nudge",
				expect.stringContaining("verifying"),
				"utf-8",
			);
		});

		it("logs error after max recovery attempts", async () => {
			const outputMock = await import("../output.js");

			const state = createHealthMonitorState();
			state.recoveryAttempts.set("task-abc123", 2); // Already at max
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "executing");

			expect(outputMock.error).toHaveBeenCalledWith(expect.stringContaining("unresponsive after 2 recovery attempts"));
		});

		it("clears recovery attempts after giving up", async () => {
			const state = createHealthMonitorState();
			state.recoveryAttempts.set("task-abc123", 2); // At max
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "executing");

			expect(state.recoveryAttempts.has("task-abc123")).toBe(false);
		});

		it("skips recovery when disabled", async () => {
			const outputMock = await import("../output.js");
			const { writeFileSync } = await import("node:fs");

			const state = createHealthMonitorState();
			const config = createConfig({ attemptRecovery: false, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "executing");

			// Should go straight to error logging
			expect(outputMock.error).toHaveBeenCalled();
			expect(writeFileSync).not.toHaveBeenCalled();
		});

		it("tracks recovery attempts per task independently", async () => {
			const state = createHealthMonitorState();
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 3 });

			handleStuckWorker(state, config, "task-1", "/tmp/wt1", "executing");
			handleStuckWorker(state, config, "task-2", "/tmp/wt2", "verifying");
			handleStuckWorker(state, config, "task-1", "/tmp/wt1", "executing");

			expect(state.recoveryAttempts.get("task-1")).toBe(2);
			expect(state.recoveryAttempts.get("task-2")).toBe(1);
		});
	});

	describe("nudge file content", () => {
		it("includes timestamp, reason, attempt, and message", async () => {
			const { writeFileSync } = await import("node:fs");
			vi.mocked(writeFileSync).mockClear();

			const state = createHealthMonitorState();
			const config = createConfig({ attemptRecovery: true, maxRecoveryAttempts: 2 });

			handleStuckWorker(state, config, "task-abc123", "/tmp/worktree", "reviewing");

			expect(writeFileSync).toHaveBeenCalled();
			const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
			const parsed = JSON.parse(content);

			expect(parsed).toHaveProperty("timestamp");
			expect(parsed.reason).toBe("Stuck in reviewing phase");
			expect(parsed.attempt).toBe(1);
			expect(parsed.message).toContain("Health check detected inactivity");
		});
	});
});
