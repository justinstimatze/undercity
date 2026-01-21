/**
 * Tests for worker/model-selection.ts
 *
 * Pure functions for determining which model tier to use for tasks.
 */

import { describe, expect, it } from "vitest";
import type { ComplexityAssessment } from "../types.js";
import {
	capAtMaxTier,
	determineReviewLevel,
	determineStartingModel,
	getNextModelTier,
	MODEL_TIERS,
	type ReviewLevelConfig,
	type StartingModelConfig,
} from "../worker/model-selection.js";

const createAssessment = (level: ComplexityAssessment["level"]): ComplexityAssessment => ({
	level,
	confidence: 0.8,
	estimatedFiles: 2,
	reasoning: "test assessment",
});

describe("worker/model-selection", () => {
	describe("MODEL_TIERS", () => {
		it("has correct order", () => {
			expect(MODEL_TIERS).toEqual(["haiku", "sonnet", "opus"]);
		});
	});

	describe("capAtMaxTier", () => {
		it("returns tier when below max", () => {
			expect(capAtMaxTier("haiku", "opus")).toBe("haiku");
			expect(capAtMaxTier("sonnet", "opus")).toBe("sonnet");
		});

		it("returns tier when equal to max", () => {
			expect(capAtMaxTier("sonnet", "sonnet")).toBe("sonnet");
			expect(capAtMaxTier("opus", "opus")).toBe("opus");
		});

		it("caps tier when above max", () => {
			expect(capAtMaxTier("opus", "sonnet")).toBe("sonnet");
			expect(capAtMaxTier("opus", "haiku")).toBe("haiku");
			expect(capAtMaxTier("sonnet", "haiku")).toBe("haiku");
		});

		it("handles all tier combinations", () => {
			// Comprehensive matrix test
			const tiers = MODEL_TIERS;
			for (const tier of tiers) {
				for (const maxTier of tiers) {
					const result = capAtMaxTier(tier, maxTier);
					const tierIndex = MODEL_TIERS.indexOf(tier);
					const maxIndex = MODEL_TIERS.indexOf(maxTier);
					const expectedIndex = Math.min(tierIndex, maxIndex);
					expect(result).toBe(MODEL_TIERS[expectedIndex]);
				}
			}
		});
	});

	describe("determineStartingModel", () => {
		const defaultConfig: StartingModelConfig = {
			startingModelOverride: "sonnet",
			maxTier: "opus",
			isTestTask: false,
		};

		describe("override behavior", () => {
			it("uses override when not sonnet", () => {
				const config = { ...defaultConfig, startingModelOverride: "opus" as const };
				const result = determineStartingModel(createAssessment("trivial"), config);
				expect(result).toBe("opus");
			});

			it("uses override haiku when explicitly set", () => {
				const config = { ...defaultConfig, startingModelOverride: "haiku" as const };
				const result = determineStartingModel(createAssessment("complex"), config);
				expect(result).toBe("haiku");
			});

			it("caps override at maxTier", () => {
				const config = { ...defaultConfig, startingModelOverride: "opus" as const, maxTier: "sonnet" as const };
				const result = determineStartingModel(createAssessment("trivial"), config);
				expect(result).toBe("sonnet");
			});
		});

		describe("test task handling", () => {
			it("uses sonnet minimum for trivial test tasks", () => {
				const config = { ...defaultConfig, isTestTask: true };
				const result = determineStartingModel(createAssessment("trivial"), config);
				expect(result).toBe("sonnet");
			});

			it("uses sonnet minimum for simple test tasks", () => {
				const config = { ...defaultConfig, isTestTask: true };
				const result = determineStartingModel(createAssessment("simple"), config);
				expect(result).toBe("sonnet");
			});

			it("follows normal assessment for complex test tasks", () => {
				const config = { ...defaultConfig, isTestTask: true };
				const result = determineStartingModel(createAssessment("complex"), config);
				expect(result).toBe("sonnet"); // Complex → sonnet anyway
			});
		});

		describe("complexity-based selection", () => {
			it("returns sonnet for trivial tasks", () => {
				const result = determineStartingModel(createAssessment("trivial"), defaultConfig);
				expect(result).toBe("sonnet");
			});

			it("returns sonnet for simple tasks", () => {
				const result = determineStartingModel(createAssessment("simple"), defaultConfig);
				expect(result).toBe("sonnet");
			});

			it("returns sonnet for standard tasks", () => {
				const result = determineStartingModel(createAssessment("standard"), defaultConfig);
				expect(result).toBe("sonnet");
			});

			it("returns sonnet for complex tasks", () => {
				const result = determineStartingModel(createAssessment("complex"), defaultConfig);
				expect(result).toBe("sonnet");
			});

			it("returns opus for critical tasks", () => {
				const result = determineStartingModel(createAssessment("critical"), defaultConfig);
				expect(result).toBe("opus");
			});

			it("caps critical task at maxTier", () => {
				const config = { ...defaultConfig, maxTier: "sonnet" as const };
				const result = determineStartingModel(createAssessment("critical"), config);
				expect(result).toBe("sonnet");
			});
		});

		describe("edge cases", () => {
			it("handles unknown complexity level gracefully", () => {
				const assessment = { ...createAssessment("standard"), level: "unknown" as ComplexityAssessment["level"] };
				const result = determineStartingModel(assessment, defaultConfig);
				expect(result).toBe("sonnet");
			});
		});
	});

	describe("determineReviewLevel", () => {
		const defaultConfig: ReviewLevelConfig = {
			multiLensAtOpus: false,
			reviewPassesEnabled: true,
			maxTier: "opus",
		};

		describe("multi-lens override", () => {
			it("enables full escalation when multiLensAtOpus is true", () => {
				const config = { ...defaultConfig, multiLensAtOpus: true };
				const result = determineReviewLevel(createAssessment("trivial"), config);
				expect(result.review).toBe(true);
				expect(result.multiLens).toBe(true);
				expect(result.maxReviewTier).toBe("opus");
			});

			it("disables multiLens when capped below opus", () => {
				const config = { ...defaultConfig, multiLensAtOpus: true, maxTier: "sonnet" as const };
				const result = determineReviewLevel(createAssessment("trivial"), config);
				expect(result.review).toBe(true);
				expect(result.multiLens).toBe(false);
				expect(result.maxReviewTier).toBe("sonnet");
			});
		});

		describe("reviews disabled", () => {
			it("returns no review when disabled", () => {
				const config = { ...defaultConfig, reviewPassesEnabled: false };
				const result = determineReviewLevel(createAssessment("critical"), config);
				expect(result.review).toBe(false);
				expect(result.multiLens).toBe(false);
			});

			it("still caps maxReviewTier when reviews disabled", () => {
				const config = { ...defaultConfig, reviewPassesEnabled: false, maxTier: "haiku" as const };
				const result = determineReviewLevel(createAssessment("critical"), config);
				expect(result.maxReviewTier).toBe("haiku");
			});
		});

		describe("complexity-based review levels", () => {
			it("caps at sonnet for trivial tasks", () => {
				const result = determineReviewLevel(createAssessment("trivial"), defaultConfig);
				expect(result.review).toBe(true);
				expect(result.multiLens).toBe(false);
				expect(result.maxReviewTier).toBe("sonnet");
			});

			it("caps at sonnet for simple tasks", () => {
				const result = determineReviewLevel(createAssessment("simple"), defaultConfig);
				expect(result.maxReviewTier).toBe("sonnet");
				expect(result.multiLens).toBe(false);
			});

			it("caps at sonnet for standard tasks", () => {
				const result = determineReviewLevel(createAssessment("standard"), defaultConfig);
				expect(result.maxReviewTier).toBe("sonnet");
			});

			it("caps at sonnet for complex tasks", () => {
				const result = determineReviewLevel(createAssessment("complex"), defaultConfig);
				expect(result.maxReviewTier).toBe("sonnet");
				expect(result.multiLens).toBe(false);
			});

			it("allows opus for critical tasks", () => {
				const result = determineReviewLevel(createAssessment("critical"), defaultConfig);
				expect(result.review).toBe(true);
				expect(result.multiLens).toBe(true);
				expect(result.maxReviewTier).toBe("opus");
			});

			it("caps critical review at maxTier", () => {
				const config = { ...defaultConfig, maxTier: "sonnet" as const };
				const result = determineReviewLevel(createAssessment("critical"), config);
				expect(result.maxReviewTier).toBe("sonnet");
				expect(result.multiLens).toBe(false); // Can't multiLens without opus
			});
		});

		describe("edge cases", () => {
			it("handles unknown complexity level gracefully", () => {
				const assessment = { ...createAssessment("standard"), level: "unknown" as ComplexityAssessment["level"] };
				const result = determineReviewLevel(assessment, defaultConfig);
				expect(result.maxReviewTier).toBe("sonnet");
			});
		});
	});

	describe("getNextModelTier", () => {
		it("escalates haiku to sonnet", () => {
			const result = getNextModelTier("haiku", "opus");
			expect(result.canEscalate).toBe(true);
			expect(result.nextTier).toBe("sonnet");
		});

		it("escalates sonnet to opus", () => {
			const result = getNextModelTier("sonnet", "opus");
			expect(result.canEscalate).toBe(true);
			expect(result.nextTier).toBe("opus");
		});

		it("cannot escalate past opus", () => {
			const result = getNextModelTier("opus", "opus");
			expect(result.canEscalate).toBe(false);
			expect(result.nextTier).toBe("opus");
		});

		it("cannot escalate past maxTier", () => {
			const result = getNextModelTier("sonnet", "sonnet");
			expect(result.canEscalate).toBe(false);
			expect(result.nextTier).toBe("sonnet");
		});

		it("cannot escalate haiku past haiku maxTier", () => {
			const result = getNextModelTier("haiku", "haiku");
			expect(result.canEscalate).toBe(false);
			expect(result.nextTier).toBe("haiku");
		});

		it("can escalate haiku to sonnet when maxTier is sonnet", () => {
			const result = getNextModelTier("haiku", "sonnet");
			expect(result.canEscalate).toBe(true);
			expect(result.nextTier).toBe("sonnet");
		});
	});
});
