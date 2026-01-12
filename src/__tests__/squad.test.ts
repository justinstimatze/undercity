/**
 * Squad Module Tests
 *
 * Tests for generateAgentId and createAgent functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent, generateAgentId } from "../squad.js";
import type { AgentType } from "../types.js";
import { ALL_AGENT_TYPES, createMockTask } from "./helpers.js";

describe("generateAgentId", () => {
	beforeEach(() => {
		// Mock Date.now for deterministic timestamp testing
		vi.spyOn(Date, "now").mockReturnValue(1704067200000); // 2024-01-01T00:00:00.000Z
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("generates ID in correct format: {agentType}-{timestamp}-{random}", () => {
		const id = generateAgentId("scout");

		// timestamp: 1704067200000.toString(36) = "lqu5m2o0"
		// random: 6 hex characters from crypto.randomBytes(3)
		expect(id).toMatch(/^scout-lqu5m2o0-[0-9a-f]{6}$/);
	});

	it.each(ALL_AGENT_TYPES)("uses correct prefix for agent type: %s", (type: AgentType) => {
		const id = generateAgentId(type);

		expect(id).toMatch(new RegExp(`^${type}-`));
	});

	it("generates unique IDs for consecutive calls", () => {
		// Restore original implementations for this test
		vi.restoreAllMocks();

		const id1 = generateAgentId("builder");
		const id2 = generateAgentId("builder");

		expect(id1).not.toBe(id2);
	});

	it("generates unique IDs for different agent types at the same time", () => {
		const fluteId = generateAgentId("scout");
		const logisticsId = generateAgentId("planner");
		const builderId = generateAgentId("builder");
		const sheriffId = generateAgentId("reviewer");

		// All IDs should be unique (even with mocked time/random, types differ)
		const allIds = [fluteId, logisticsId, builderId, sheriffId];
		const uniqueIds = new Set(allIds);
		expect(uniqueIds.size).toBe(4);
	});
});

describe("createAgent", () => {
	const mockDate = new Date("2024-01-01T12:00:00.000Z");

	beforeEach(() => {
		// Mock Date constructor and Date.now for consistent timestamps
		vi.useFakeTimers();
		vi.setSystemTime(mockDate);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("without step", () => {
		it("creates squad member with idle status", () => {
			const member = createAgent("scout");

			expect(member.status).toBe("idle");
		});

		it("creates squad member with undefined step", () => {
			const member = createAgent("builder");

			expect(member.step).toBeUndefined();
		});
	});

	describe("with step", () => {
		it("creates squad member with working status", () => {
			const step = createMockTask({ description: "Build feature" });
			const member = createAgent("builder", step);

			expect(member.status).toBe("working");
		});

		it("assigns the step to the squad member", () => {
			const step = createMockTask({
				id: "step-abc",
				description: "Build feature",
			});
			const member = createAgent("builder", step);

			expect(member.step).toBe(step);
			expect(member.step?.id).toBe("step-abc");
		});
	});

	describe("type property", () => {
		it.each(ALL_AGENT_TYPES)("sets correct type for agent: %s", (type: AgentType) => {
			const member = createAgent(type);

			expect(member.type).toBe(type);
		});
	});

	describe("timestamps", () => {
		it("sets spawnedAt and lastActivityAt to equal Date instances", () => {
			const member = createAgent("reviewer");

			expect(member.spawnedAt).toBeInstanceOf(Date);
			expect(member.lastActivityAt).toBeInstanceOf(Date);
			expect(member.spawnedAt.getTime()).toBe(member.lastActivityAt.getTime());
		});

		it("uses current time for timestamps", () => {
			const member = createAgent("planner");

			expect(member.spawnedAt.getTime()).toBe(mockDate.getTime());
			expect(member.lastActivityAt.getTime()).toBe(mockDate.getTime());
		});
	});

	describe("id property", () => {
		it("generates a valid ID", () => {
			const member = createAgent("scout");

			expect(member.id).toBeDefined();
			expect(typeof member.id).toBe("string");
			expect(member.id.length).toBeGreaterThan(0);
		});

		it.each(ALL_AGENT_TYPES)("ID contains agent type prefix for: %s", (type: AgentType) => {
			const member = createAgent(type);

			expect(member.id).toMatch(new RegExp(`^${type}-`));
		});
	});
});
