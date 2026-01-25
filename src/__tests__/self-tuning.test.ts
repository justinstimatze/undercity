/**
 * Self-Tuning Module Tests
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeOptimalThresholds,
	formatProfileSummary,
	getRecommendedModel,
	getThreshold,
	loadRoutingProfile,
	type RoutingProfile,
	saveRoutingProfile,
	shouldSkipModel,
} from "../self-tuning.js";

describe("Self-Tuning Module", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "self-tuning-test-"));
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("loadRoutingProfile", () => {
		it("should return null when no profile exists", () => {
			const profile = loadRoutingProfile(testDir);
			expect(profile).toBeNull();
		});

		it("should load valid profile", () => {
			const testProfile: RoutingProfile = {
				version: 1,
				updatedAt: new Date().toISOString(),
				taskCount: 10,
				thresholds: {},
				modelSuccessRates: { haiku: 0.7, sonnet: 0.8, opus: 0.9 },
				recommendations: [],
			};
			writeFileSync(join(testDir, ".undercity/routing-profile.json"), JSON.stringify(testProfile));

			const profile = loadRoutingProfile(testDir);
			expect(profile).not.toBeNull();
			expect(profile?.taskCount).toBe(10);
		});
	});

	describe("saveRoutingProfile", () => {
		it("should save profile to disk", () => {
			const testProfile: RoutingProfile = {
				version: 1,
				updatedAt: new Date().toISOString(),
				taskCount: 5,
				thresholds: {},
				modelSuccessRates: { haiku: 0.6, sonnet: 0.7, opus: 0.8 },
				recommendations: ["Test recommendation"],
			};

			saveRoutingProfile(testProfile, testDir);

			const loaded = loadRoutingProfile(testDir);
			expect(loaded).not.toBeNull();
			expect(loaded?.taskCount).toBe(5);
			expect(loaded?.recommendations).toContain("Test recommendation");
		});
	});

	describe("getThreshold", () => {
		it("should return default threshold when no profile", () => {
			const threshold = getThreshold(null, "sonnet", "simple");
			expect(threshold.minSuccessRate).toBe(0.7);
			expect(threshold.skip).toBe(false);
		});

		it("should return specific threshold from profile", () => {
			const profile: RoutingProfile = {
				version: 1,
				updatedAt: new Date().toISOString(),
				taskCount: 20,
				thresholds: {
					"haiku:simple": { minSuccessRate: 0.6, minSamples: 5, skip: false },
				},
				modelSuccessRates: { haiku: 0.7, sonnet: 0.8, opus: 0.9 },
				recommendations: [],
			};

			const threshold = getThreshold(profile, "sonnet", "simple");
			expect(threshold.minSuccessRate).toBe(0.6);
			expect(threshold.minSamples).toBe(5);
		});
	});

	describe("shouldSkipModel", () => {
		it("should never skip opus", () => {
			expect(shouldSkipModel(null, "opus", "complex")).toBe(false);
			expect(shouldSkipModel(null, "opus", "critical")).toBe(false);
		});

		it("should skip sonnet for complex tasks by default", () => {
			expect(shouldSkipModel(null, "sonnet", "complex")).toBe(true);
			expect(shouldSkipModel(null, "sonnet", "critical")).toBe(true);
		});

		it("should not skip sonnet for simple tasks", () => {
			expect(shouldSkipModel(null, "sonnet", "simple")).toBe(false);
			expect(shouldSkipModel(null, "sonnet", "trivial")).toBe(false);
		});

		it("should respect profile skip flag", () => {
			const profile: RoutingProfile = {
				version: 1,
				updatedAt: new Date().toISOString(),
				taskCount: 30,
				thresholds: {
					"sonnet:standard": { minSuccessRate: 0.6, minSamples: 5, skip: true },
				},
				modelSuccessRates: { haiku: 0.7, sonnet: 0.4, opus: 0.9 },
				recommendations: [],
			};

			expect(shouldSkipModel(profile, "sonnet", "standard")).toBe(true);
		});
	});

	describe("getRecommendedModel", () => {
		it("should recommend sonnet for trivial tasks (haiku skipped)", () => {
			expect(getRecommendedModel("trivial", testDir)).toBe("sonnet");
		});

		it("should recommend sonnet for standard tasks", () => {
			expect(getRecommendedModel("standard", testDir)).toBe("sonnet");
		});

		it("should recommend opus for critical tasks", () => {
			expect(getRecommendedModel("critical", testDir)).toBe("opus");
		});
	});

	describe("computeOptimalThresholds", () => {
		it("should return empty profile when no metrics", () => {
			const profile = computeOptimalThresholds(testDir);
			expect(profile.taskCount).toBe(0);
			expect(profile.version).toBe(1);
		});

		it("should compute profile from metrics", () => {
			// Create test metrics
			const metrics = [
				{
					taskId: "1",
					objective: "test",
					success: true,
					durationMs: 1000,
					totalTokens: 100,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					finalModel: "sonnet",
					complexityLevel: "standard",
				},
				{
					taskId: "2",
					objective: "test2",
					success: true,
					durationMs: 2000,
					totalTokens: 200,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					finalModel: "sonnet",
					complexityLevel: "standard",
				},
			];
			writeFileSync(join(testDir, ".undercity/metrics.jsonl"), metrics.map((m) => JSON.stringify(m)).join("\n"));

			const profile = computeOptimalThresholds(testDir);
			expect(profile.taskCount).toBe(2);
			expect(profile.modelSuccessRates.sonnet).toBe(1.0);
		});
	});

	describe("formatProfileSummary", () => {
		it("should format profile as readable text", () => {
			const profile: RoutingProfile = {
				version: 1,
				updatedAt: "2025-01-01T00:00:00.000Z",
				taskCount: 100,
				thresholds: {
					"haiku:simple": { minSuccessRate: 0.7, minSamples: 5, skip: false },
				},
				modelSuccessRates: { haiku: 0.75, sonnet: 0.85, opus: 0.95 },
				recommendations: ["Test recommendation"],
			};

			const summary = formatProfileSummary(profile);

			expect(summary).toContain("Tasks analyzed: 100");
			expect(summary).toContain("haiku: 75%");
			expect(summary).toContain("sonnet: 85%");
			expect(summary).toContain("opus: 95%");
			expect(summary).toContain("Test recommendation");
		});

		it("should show skipped combinations", () => {
			const profile: RoutingProfile = {
				version: 1,
				updatedAt: "2025-01-01T00:00:00.000Z",
				taskCount: 50,
				thresholds: {
					"haiku:complex": { minSuccessRate: 0.7, minSamples: 5, skip: true },
				},
				modelSuccessRates: { haiku: 0.4, sonnet: 0.8, opus: 0.9 },
				recommendations: [],
			};

			const summary = formatProfileSummary(profile);

			expect(summary).toContain("Skipped");
			expect(summary).toContain("haiku:complex");
		});
	});
});
