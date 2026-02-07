/**
 * Tests for worker/stop-hooks.ts
 *
 * Logic for determining when an agent should stop execution.
 */

import { describe, expect, it, vi } from "vitest";
import { createStandardStopHooks, getMaxTurnsForModel, type StopHookState } from "../worker/stop-hooks.js";

// Mock the logger to avoid noise
vi.mock("../logger.js", () => ({
	sessionLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

describe("worker/stop-hooks", () => {
	describe("getMaxTurnsForModel", () => {
		it("returns 25 for sonnet", () => {
			expect(getMaxTurnsForModel("sonnet")).toBe(25);
		});

		it("returns 40 for opus", () => {
			expect(getMaxTurnsForModel("opus")).toBe(40);
		});

		it("returns 15 as default for haiku (not yet implemented)", () => {
			// Comment in source says haiku should be 10, but not implemented yet
			// Falls back to default of 15
			expect(getMaxTurnsForModel("haiku")).toBe(15);
		});

		it("returns 15 as default for unknown model", () => {
			// Type assertion to test edge case
			expect(getMaxTurnsForModel("unknown" as "sonnet")).toBe(15);
		});

		it("returns 15 for empty string model", () => {
			// Type assertion to test edge case
			expect(getMaxTurnsForModel("" as "sonnet")).toBe(15);
		});
	});

	describe("createStandardStopHooks", () => {
		const createState = (overrides: Partial<StopHookState> = {}): StopHookState => ({
			taskAlreadyCompleteReason: null,
			noOpEditCount: 0,
			writeCountThisExecution: 0,
			consecutiveNoWriteAttempts: 0,
			currentModel: "sonnet",
			...overrides,
		});

		it("allows stop when task already complete reason exists", async () => {
			const state = createState({ taskAlreadyCompleteReason: "already done" });
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
			expect(onNoWriteAttempt).not.toHaveBeenCalled();
		});

		it("allows stop when no-op edits detected and no real writes", async () => {
			const state = createState({
				noOpEditCount: 1,
				writeCountThisExecution: 0,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
		});

		it("allows stop when writes were made", async () => {
			const state = createState({ writeCountThisExecution: 3 });
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
			expect(onNoWriteAttempt).not.toHaveBeenCalled();
		});

		it("rejects stop and calls onNoWriteAttempt when no writes", async () => {
			const state = createState({ writeCountThisExecution: 0 });
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(false);
			expect(result.reason).toContain("haven't made any code changes");
			expect(onNoWriteAttempt).toHaveBeenCalled();
		});

		it("provides escalating feedback on second no-write attempt", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 2,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(false);
			expect(result.reason).toContain("still haven't made any code changes");
			expect(result.reason).toContain("NEEDS_DECOMPOSITION");
		});

		it("calls onFailFast after 3 consecutive no-write attempts", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 3,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn(() => {
				throw new Error("fail fast called");
			}) as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);

			await expect(hooks[0].hooks[0]()).rejects.toThrow("fail fast called");
			expect(onFailFast).toHaveBeenCalledWith(expect.stringContaining("VAGUE_TASK"));
		});

		it("does not reject when no-op edits detected even with real writes", async () => {
			const state = createState({
				noOpEditCount: 2,
				writeCountThisExecution: 1, // Has real writes, no-op check shouldn't prevent stop
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
		});

		it("returns hook structure with correct shape", () => {
			const hooks = createStandardStopHooks(() => createState(), vi.fn(), vi.fn() as unknown as (msg: string) => never);

			expect(hooks).toHaveLength(1);
			expect(hooks[0]).toHaveProperty("hooks");
			expect(hooks[0].hooks).toHaveLength(1);
			expect(typeof hooks[0].hooks[0]).toBe("function");
		});

		// Edge case: consecutiveNoWriteAttempts boundary conditions
		it("rejects with standard feedback on first no-write attempt (consecutiveNoWriteAttempts = 1)", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 1,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(false);
			expect(result.reason).toContain("haven't made any code changes");
			expect(result.reason).not.toContain("still haven't");
			expect(result.reason).not.toContain("NEEDS_DECOMPOSITION");
			expect(onNoWriteAttempt).toHaveBeenCalled();
			expect(onFailFast).not.toHaveBeenCalled();
		});

		// Edge case: taskAlreadyCompleteReason with non-zero writes
		it("allows stop when taskAlreadyCompleteReason is set even with non-zero writes", async () => {
			const state = createState({
				taskAlreadyCompleteReason: "files already in correct state",
				writeCountThisExecution: 5, // Has writes, but reason takes precedence
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
			expect(onNoWriteAttempt).not.toHaveBeenCalled();
		});

		// Edge case: noOpEditCount = 0 with writeCount = 0
		it("rejects when noOpEditCount is 0 and no writes made", async () => {
			const state = createState({
				noOpEditCount: 0,
				writeCountThisExecution: 0,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(false);
			expect(onNoWriteAttempt).toHaveBeenCalled();
		});

		// Edge case: noOpEditCount = 1 exactly with writeCount = 0
		it("allows stop when noOpEditCount is exactly 1 with no writes", async () => {
			const state = createState({
				noOpEditCount: 1,
				writeCountThisExecution: 0,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
		});

		// Edge case: large noOpEditCount with writeCount = 0
		it("allows stop when noOpEditCount is large with no writes", async () => {
			const state = createState({
				noOpEditCount: 100,
				writeCountThisExecution: 0,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(true);
		});

		// Edge case: consecutiveNoWriteAttempts exactly at fail-fast threshold
		it("calls onFailFast when consecutiveNoWriteAttempts is exactly 3", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 3,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn(() => {
				throw new Error("fail fast called");
			}) as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);

			await expect(hooks[0].hooks[0]()).rejects.toThrow("fail fast called");
			expect(onFailFast).toHaveBeenCalledTimes(1);
			expect(onFailFast).toHaveBeenCalledWith(expect.stringContaining("VAGUE_TASK"));
		});

		// Edge case: consecutiveNoWriteAttempts beyond fail-fast threshold
		it("calls onFailFast when consecutiveNoWriteAttempts exceeds 3", async () => {
			const state = createState({
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 5,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn(() => {
				throw new Error("fail fast called");
			}) as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);

			await expect(hooks[0].hooks[0]()).rejects.toThrow("fail fast called");
		});

		// Edge case: all counters at zero
		it("rejects when all counters are at zero", async () => {
			const state = createState({
				taskAlreadyCompleteReason: null,
				noOpEditCount: 0,
				writeCountThisExecution: 0,
				consecutiveNoWriteAttempts: 0,
			});
			const onNoWriteAttempt = vi.fn();
			const onFailFast = vi.fn() as unknown as (msg: string) => never;

			const hooks = createStandardStopHooks(() => state, onNoWriteAttempt, onFailFast);
			const result = await hooks[0].hooks[0]();

			expect(result.continue).toBe(false);
			expect(onNoWriteAttempt).toHaveBeenCalled();
		});

		// Edge case: hook returns a promise (async behavior)
		it("returns a promise that resolves to StopHookResult", async () => {
			const state = createState({ writeCountThisExecution: 1 });
			const hooks = createStandardStopHooks(() => state, vi.fn(), vi.fn() as unknown as (msg: string) => never);

			const hookResult = hooks[0].hooks[0]();
			expect(hookResult).toBeInstanceOf(Promise);

			const result = await hookResult;
			expect(result).toHaveProperty("continue");
			expect(typeof result.continue).toBe("boolean");
		});
	});
});
