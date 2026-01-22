/**
 * Tests for worker/agent-loop.ts
 *
 * Tests the agent execution loop logic including stop hooks.
 */

import { describe, expect, it, vi } from "vitest";
import { type AgentLoopState, buildStopHooks } from "../worker/agent-loop.js";

// Mock the logger to avoid noise - needs child() for transitive dependencies
vi.mock("../logger.js", () => {
	const mockLogger: Record<string, unknown> = {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => mockLogger),
	};
	return { sessionLogger: mockLogger };
});

// Mock decision-tracker to avoid its side effects
vi.mock("../decision-tracker.js", () => ({
	captureDecision: vi.fn(),
	parseAgentOutputForDecisions: vi.fn(() => []),
}));

// Mock dual-logger
vi.mock("../dual-logger.js", () => ({
	dualLogger: {
		writeLine: vi.fn(),
	},
}));

describe("worker/agent-loop", () => {
	describe("buildStopHooks", () => {
		const createState = (overrides: Partial<AgentLoopState> = {}): AgentLoopState => ({
			currentTaskId: "test-task",
			currentModel: "sonnet",
			attempts: 1,
			isCurrentTaskMeta: false,
			isCurrentTaskResearch: false,
			currentAgentSessionId: undefined,
			lastFeedback: undefined,
			lastPostMortem: undefined,
			writeCountThisExecution: 0,
			writesPerFile: new Map(),
			noOpEditCount: 0,
			consecutiveNoWriteAttempts: 0,
			taskAlreadyCompleteReason: null,
			invalidTargetReason: null,
			needsDecompositionReason: null,
			lastAgentOutput: "",
			lastAgentTurns: 0,
			tokenUsageThisTask: [],
			injectedLearningIds: [],
			...overrides,
		});

		it("returns empty hooks for meta tasks", () => {
			const state = createState({ isCurrentTaskMeta: true });
			const hooks = buildStopHooks(state, true);
			expect(hooks).toHaveLength(0);
		});

		it("returns hooks for non-meta tasks", () => {
			const state = createState();
			const hooks = buildStopHooks(state, false);
			expect(hooks).toHaveLength(1);
			expect(hooks[0].hooks).toHaveLength(1);
		});

		it("allows stop when task already complete reason exists", async () => {
			const state = createState({ taskAlreadyCompleteReason: "already done" });
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(true);
		});

		it("allows stop when no-op edits detected and no real writes", async () => {
			const state = createState({
				noOpEditCount: 1,
				writeCountThisExecution: 0,
			});
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(true);
		});

		it("allows stop when writes were made", async () => {
			const state = createState({ writeCountThisExecution: 3 });
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(true);
		});

		it("rejects stop when no writes and no special conditions", async () => {
			const state = createState({ writeCountThisExecution: 0 });
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(false);
			expect(result.reason).toContain("haven't made any code changes");
		});

		it("increments consecutiveNoWriteAttempts on rejection", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 0,
			});
			const hooks = buildStopHooks(state, false);
			await hooks[0].hooks[0]({}, "", {});

			expect(state.consecutiveNoWriteAttempts).toBe(1);
		});

		it("provides escalating feedback on second no-write attempt", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 1, // Will become 2 after hook runs
			});
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(false);
			expect(result.reason).toContain("still haven't made any code changes");
			expect(result.reason).toContain("NEEDS_DECOMPOSITION");
		});

		it("throws VAGUE_TASK error after 3 consecutive no-write attempts", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 2, // Will become 3 after hook runs
			});
			const hooks = buildStopHooks(state, false);

			await expect(hooks[0].hooks[0]({}, "", {})).rejects.toThrow("VAGUE_TASK");
		});

		it("throws error with correct message on fail fast", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 2,
			});
			const hooks = buildStopHooks(state, false);

			await expect(hooks[0].hooks[0]({}, "", {})).rejects.toThrow(
				/Agent attempted to finish 3 times without making changes/,
			);
		});

		it("does not reject when writes exist even with no-op edits", async () => {
			const state = createState({
				noOpEditCount: 2,
				writeCountThisExecution: 1,
			});
			const hooks = buildStopHooks(state, false);
			const result = await hooks[0].hooks[0]({}, "", {});

			expect(result.continue).toBe(true);
		});

		it("uses state by reference (mutations persist)", async () => {
			const state = createState({ consecutiveNoWriteAttempts: 0 });
			const hooks = buildStopHooks(state, false);

			// First call
			await hooks[0].hooks[0]({}, "", {});
			expect(state.consecutiveNoWriteAttempts).toBe(1);

			// Second call - state persists
			await hooks[0].hooks[0]({}, "", {});
			expect(state.consecutiveNoWriteAttempts).toBe(2);
		});

		it("respects isMetaTask parameter over state field", () => {
			// State says not meta, but parameter says meta
			const state = createState({ isCurrentTaskMeta: false });
			const hooks = buildStopHooks(state, true);
			expect(hooks).toHaveLength(0);
		});
	});
});
