/**
 * Names Module Tests
 *
 * Tests Docker-style worker name generation.
 */

import { describe, expect, it } from "vitest";
import {
	generateBranchName,
	generateWorkerName,
	getWorkerDisplayName,
	nameFromId,
	parseWorkerNameFromBranch,
} from "../names.js";

describe("names", () => {
	describe("generateWorkerName", () => {
		it("should generate a name in adjective-animal format", () => {
			const name = generateWorkerName();
			expect(name).toMatch(/^[a-z]+-[a-z]+$/);
		});

		it("should generate different names on subsequent calls (statistically)", () => {
			const names = new Set<string>();
			// Generate 20 names - with 40x40 combinations, collisions should be rare
			for (let i = 0; i < 20; i++) {
				names.add(generateWorkerName());
			}
			// Should have at least 10 unique names (allowing for some collisions)
			expect(names.size).toBeGreaterThanOrEqual(10);
		});
	});

	describe("nameFromId", () => {
		it("should generate deterministic name from ID", () => {
			const id = "task-abc123";
			const name1 = nameFromId(id);
			const name2 = nameFromId(id);
			expect(name1).toBe(name2);
		});

		it("should generate different names for different IDs", () => {
			const name1 = nameFromId("task-abc123");
			const name2 = nameFromId("task-xyz789");
			expect(name1).not.toBe(name2);
		});

		it("should return adjective-animal format", () => {
			const name = nameFromId("test-session-123");
			expect(name).toMatch(/^[a-z]+-[a-z]+$/);
		});
	});

	describe("parseWorkerNameFromBranch", () => {
		it("should extract worker name from valid branch", () => {
			const branch = "undercity/swift-fox/task-abc123";
			const name = parseWorkerNameFromBranch(branch);
			expect(name).toBe("swift-fox");
		});

		it("should return null for non-undercity branches", () => {
			const branch = "feature/my-feature";
			const name = parseWorkerNameFromBranch(branch);
			expect(name).toBeNull();
		});

		it("should return null for invalid format", () => {
			const branch = "undercity/";
			const name = parseWorkerNameFromBranch(branch);
			expect(name).toBeNull();
		});
	});

	describe("generateBranchName", () => {
		it("should generate branch with worker name and task ID", () => {
			const taskId = "task-abc123";
			const branch = generateBranchName(taskId);
			expect(branch).toMatch(/^undercity\/[a-z]+-[a-z]+\/task-abc123$/);
		});

		it("should be deterministic for same task ID", () => {
			const taskId = "task-xyz789";
			const branch1 = generateBranchName(taskId);
			const branch2 = generateBranchName(taskId);
			expect(branch1).toBe(branch2);
		});
	});

	describe("getWorkerDisplayName", () => {
		it("should return worker name for task ID", () => {
			const taskId = "task-abc123";
			const displayName = getWorkerDisplayName(taskId);
			const expectedName = nameFromId(taskId);
			expect(displayName).toBe(expectedName);
		});
	});
});
