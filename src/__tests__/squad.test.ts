/**
 * Squad Module Tests
 *
 * Tests for generateSquadMemberId and createSquadMember functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSquadMember, generateSquadMemberId } from "../squad.js";
import type { AgentType } from "../types.js";
import { ALL_AGENT_TYPES, createMockTask } from "./helpers.js";

describe("generateSquadMemberId", () => {
	beforeEach(() => {
		// Mock Date.now and Math.random for deterministic testing
		vi.spyOn(Date, "now").mockReturnValue(1704067200000); // 2024-01-01T00:00:00.000Z
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("generates ID in correct format: {agentType}-{timestamp}-{random}", () => {
		const id = generateSquadMemberId("scout");

		// timestamp: 1704067200000.toString(36) = "lqu5m2o0"
		// random: 0.123456789.toString(36).substring(2, 6) = "4fzz"
		expect(id).toBe("scout-lqu5m2o0-4fzz");
	});

	it.each(ALL_AGENT_TYPES)("uses correct prefix for agent type: %s", (type: AgentType) => {
		const id = generateSquadMemberId(type);

		expect(id).toMatch(new RegExp(`^${type}-`));
	});

	it("generates unique IDs for consecutive calls", () => {
		// Restore original implementations for this test
		vi.restoreAllMocks();

		const id1 = generateSquadMemberId("fabricator");
		const id2 = generateSquadMemberId("fabricator");

		expect(id1).not.toBe(id2);
	});

	it("generates unique IDs for different agent types at the same time", () => {
		const scoutId = generateSquadMemberId("scout");
		const plannerId = generateSquadMemberId("planner");
		const fabricatorId = generateSquadMemberId("fabricator");
		const auditorId = generateSquadMemberId("auditor");

		// All IDs should be unique (even with mocked time/random, types differ)
		const allIds = [scoutId, plannerId, fabricatorId, auditorId];
		const uniqueIds = new Set(allIds);
		expect(uniqueIds.size).toBe(4);
	});
});

describe("createSquadMember", () => {
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

	describe("without waypoint", () => {
		it("creates squad member with idle status", () => {
			const member = createSquadMember("scout");

			expect(member.status).toBe("idle");
		});

		it("creates squad member with undefined waypoint", () => {
			const member = createSquadMember("fabricator");

			expect(member.waypoint).toBeUndefined();
		});
	});

	describe("with waypoint", () => {
		it("creates squad member with working status", () => {
			const waypoint = createMockTask({ description: "Build feature" });
			const member = createSquadMember("fabricator", waypoint);

			expect(member.status).toBe("working");
		});

		it("assigns the waypoint to the squad member", () => {
			const waypoint = createMockTask({
				id: "waypoint-abc",
				description: "Build feature",
			});
			const member = createSquadMember("fabricator", waypoint);

			expect(member.waypoint).toBe(waypoint);
			expect(member.waypoint?.id).toBe("waypoint-abc");
		});
	});

	describe("type property", () => {
		it.each(ALL_AGENT_TYPES)("sets correct type for agent: %s", (type: AgentType) => {
			const member = createSquadMember(type);

			expect(member.type).toBe(type);
		});
	});

	describe("timestamps", () => {
		it("sets spawnedAt and lastActivityAt to equal Date instances", () => {
			const member = createSquadMember("auditor");

			expect(member.spawnedAt).toBeInstanceOf(Date);
			expect(member.lastActivityAt).toBeInstanceOf(Date);
			expect(member.spawnedAt.getTime()).toBe(member.lastActivityAt.getTime());
		});

		it("uses current time for timestamps", () => {
			const member = createSquadMember("planner");

			expect(member.spawnedAt.getTime()).toBe(mockDate.getTime());
			expect(member.lastActivityAt.getTime()).toBe(mockDate.getTime());
		});
	});

	describe("id property", () => {
		it("generates a valid ID", () => {
			const member = createSquadMember("scout");

			expect(member.id).toBeDefined();
			expect(typeof member.id).toBe("string");
			expect(member.id.length).toBeGreaterThan(0);
		});

		it.each(ALL_AGENT_TYPES)("ID contains agent type prefix for: %s", (type: AgentType) => {
			const member = createSquadMember(type);

			expect(member.id).toMatch(new RegExp(`^${type}-`));
		});
	});
});
