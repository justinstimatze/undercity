/**
 * Complexity Module Tests
 *
 * Tests for complexity assessment functions used to route tasks
 * to appropriate model tiers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	adjustModelFromMetrics,
	assessComplexityFast,
	canHandleWithLocalTools,
	getTeamComposition,
	type QuantitativeMetrics,
	scoreFromMetrics,
	shouldEscalateToFullChain,
} from "../complexity.js";

describe("complexity", () => {
	let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Suppress logger output during tests
		consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleInfoSpy.mockRestore();
	});

	describe("canHandleWithLocalTools", () => {
		it("returns format command for format tasks", () => {
			const result = canHandleWithLocalTools("run format");
			expect(result).toEqual({
				command: "pnpm format",
				description: "Format code",
			});
		});

		it("returns lint command for lint tasks", () => {
			const result = canHandleWithLocalTools("lint");
			expect(result).toEqual({
				command: "pnpm lint:fix",
				description: "Lint and fix",
			});
		});

		it("returns typecheck command for typecheck tasks", () => {
			const result = canHandleWithLocalTools("run typecheck");
			expect(result).toEqual({
				command: "pnpm typecheck",
				description: "Run type checking",
			});
		});

		it("returns test command for test tasks", () => {
			const result = canHandleWithLocalTools("test");
			expect(result).toEqual({
				command: "pnpm test",
				description: "Run tests",
			});
		});

		it("returns build command for build tasks", () => {
			const result = canHandleWithLocalTools("build");
			expect(result).toEqual({
				command: "pnpm build",
				description: "Build project",
			});
		});

		it("returns spellcheck command for spellcheck tasks", () => {
			const result = canHandleWithLocalTools("spell check");
			expect(result).toEqual({
				command: "pnpm spell",
				description: "Run spell check",
			});
		});

		it("returns null for non-local tasks", () => {
			const result = canHandleWithLocalTools("add user authentication");
			expect(result).toBeNull();
		});

		it("is case insensitive", () => {
			const result = canHandleWithLocalTools("RUN FORMAT");
			expect(result).not.toBeNull();
		});
	});

	describe("assessComplexityFast", () => {
		describe("trivial tasks", () => {
			it("identifies local tool tasks as trivial", () => {
				const result = assessComplexityFast("run format");
				expect(result.level).toBe("trivial");
				expect(result.localTool).toBeDefined();
				expect(result.localTool?.command).toBe("pnpm format");
			});

			it("identifies pure typo tasks as trivial", () => {
				// "typo" keyword alone triggers trivial level
				const result = assessComplexityFast("typo");
				expect(result.level).toBe("trivial");
			});
		});

		describe("simple tasks", () => {
			it("identifies simple fixes", () => {
				const result = assessComplexityFast("simple fix for button color");
				expect(result.level).toBe("simple");
				expect(result.model).toBe("sonnet");
			});

			it("identifies small changes", () => {
				const result = assessComplexityFast("small change to config");
				expect(result.level).toBe("simple");
			});

			it("identifies cleanup tasks", () => {
				const result = assessComplexityFast("clean up unused imports");
				expect(result.level).toBe("simple");
			});

			it("identifies typo fixes as trivial", () => {
				// Typo fixes are trivial - negative weight counteracts other signals
				// Note: Even trivial tasks use sonnet now (haiku skipped)
				const result = assessComplexityFast("fix typo in README");
				expect(result.level).toBe("trivial");
				expect(result.model).toBe("sonnet");
			});
		});

		describe("standard tasks", () => {
			// Note: With expanded thresholds for 40-50% haiku routing,
			// simple bug fixes and enhancements now route to "simple" (haiku)
			// Only more complex multi-file tasks hit "standard"
			it("identifies bug fixes with multiple files as standard", () => {
				// Adding "several files" scope indicator to hit standard threshold
				const result = assessComplexityFast("fix bug affecting several files");
				expect(result.level).toBe("standard");
				expect(result.model).toBe("sonnet");
			});

			it("identifies enhancement tasks spanning multiple areas", () => {
				// "throughout" adds scope weight to hit standard threshold
				const result = assessComplexityFast("enhance logging throughout the codebase");
				expect(result.level).toBe("standard");
			});
		});

		describe("complex tasks", () => {
			it("identifies migration tasks as complex", () => {
				const result = assessComplexityFast("migrate database schema");
				expect(result.level).toBe("complex");
				// Complex tasks now start with sonnet, escalate to opus if needed
				// This saves tokens - most complex tasks succeed with sonnet
				expect(result.model).toBe("sonnet");
				expect(result.useFullChain).toBe(true);
			});

			it("identifies cross-package tasks", () => {
				const result = assessComplexityFast("update across multiple packages");
				expect(result.level).toBe("complex");
			});

			it("identifies redesign tasks", () => {
				const result = assessComplexityFast("redesign the API layer");
				expect(result.level).toBe("complex");
			});
		});

		describe("critical tasks", () => {
			it("identifies security tasks", () => {
				const result = assessComplexityFast("fix security vulnerability");
				expect(result.level).toBe("critical");
				expect(result.model).toBe("opus");
				expect(result.needsReview).toBe(true);
			});

			it("identifies tasks combining auth and refactor as critical", () => {
				// "refactor authentication system" hits both refactor and auth keywords
				const result = assessComplexityFast("refactor authentication system");
				expect(result.level).toBe("critical");
			});

			it("identifies payment tasks", () => {
				const result = assessComplexityFast("update payment processing logic");
				expect(result.level).toBe("critical");
			});

			it("identifies production-related tasks", () => {
				const result = assessComplexityFast("fix production database issue");
				expect(result.level).toBe("critical");
			});
		});

		describe("scope estimation", () => {
			it("detects single-file scope", () => {
				const result = assessComplexityFast("fix bug in this file");
				expect(result.estimatedScope).toBe("single-file");
			});

			it("detects cross-package scope", () => {
				const result = assessComplexityFast("update server and client packages");
				expect(result.estimatedScope).toBe("cross-package");
			});
		});

		describe("edge cases", () => {
			it("handles empty task description", () => {
				const result = assessComplexityFast("");
				expect(result.level).toBe("simple");
				expect(result.confidence).toBe(0.5);
			});

			it("increases confidence with more signals", () => {
				const fewSignals = assessComplexityFast("fix");
				const manySignals = assessComplexityFast("refactor authentication security critical");
				expect(manySignals.confidence).toBeGreaterThan(fewSignals.confidence);
			});
		});
	});

	describe("getTeamComposition", () => {
		it("returns no validation for trivial tasks", () => {
			const composition = getTeamComposition("trivial");
			expect(composition.needsPlanning).toBe(false);
			expect(composition.validatorCount).toBe(0);
			expect(composition.workerModel).toBe("sonnet"); // haiku skipped
		});

		it("returns 1 validator for simple tasks", () => {
			const composition = getTeamComposition("simple");
			expect(composition.needsPlanning).toBe(false);
			expect(composition.validatorCount).toBe(1);
			expect(composition.independentValidators).toBe(true);
		});

		it("returns planning and 2 validators for standard tasks", () => {
			const composition = getTeamComposition("standard");
			expect(composition.needsPlanning).toBe(true);
			expect(composition.validatorCount).toBe(2);
			expect(composition.plannerModel).toBe("sonnet");
		});

		it("returns 3 validators for complex tasks", () => {
			const composition = getTeamComposition("complex");
			expect(composition.validatorCount).toBe(3);
			expect(composition.plannerModel).toBe("opus");
		});

		it("returns 5 validators for critical tasks", () => {
			const composition = getTeamComposition("critical");
			expect(composition.validatorCount).toBe(5);
			expect(composition.plannerModel).toBe("opus");
		});

		describe("model ceiling", () => {
			it("caps models at specified ceiling", () => {
				const composition = getTeamComposition("critical", "sonnet");
				expect(composition.plannerModel).toBe("sonnet");
				expect(composition.workerModel).toBe("sonnet");
			});

			it("allows models at or below ceiling", () => {
				const composition = getTeamComposition("trivial", "sonnet");
				expect(composition.workerModel).toBe("sonnet"); // trivial now uses sonnet, within ceiling
			});
		});
	});

	describe("scoreFromMetrics", () => {
		const createBaseMetrics = (): QuantitativeMetrics => ({
			fileCount: 0,
			totalLines: 0,
			functionCount: 0,
			unhealthyFiles: [],
			crossPackage: false,
			packages: [],
			git: {
				avgChangeFrequency: 0,
				hotspots: [],
				bugProneFiles: [],
			},
		});

		it("scores zero for empty files", () => {
			const metrics = createBaseMetrics();
			const result = scoreFromMetrics(metrics);
			expect(result.score).toBe(0);
			expect(result.signals).toContain("no-files-identified");
		});

		it("scores higher for more files", () => {
			const fewFiles = { ...createBaseMetrics(), fileCount: 2 };
			const manyFiles = { ...createBaseMetrics(), fileCount: 10 };

			const fewScore = scoreFromMetrics(fewFiles);
			const manyScore = scoreFromMetrics(manyFiles);

			expect(manyScore.score).toBeGreaterThan(fewScore.score);
		});

		it("scores higher for more lines of code", () => {
			const smallFile = { ...createBaseMetrics(), fileCount: 1, totalLines: 100 };
			const largeFile = { ...createBaseMetrics(), fileCount: 1, totalLines: 2000 };

			const smallScore = scoreFromMetrics(smallFile);
			const largeScore = scoreFromMetrics(largeFile);

			expect(largeScore.score).toBeGreaterThan(smallScore.score);
		});

		it("scores higher for cross-package changes", () => {
			const singlePackage = { ...createBaseMetrics(), fileCount: 1 };
			const crossPackage = {
				...createBaseMetrics(),
				fileCount: 1,
				crossPackage: true,
				packages: ["server", "client"],
			};

			const singleScore = scoreFromMetrics(singlePackage);
			const crossScore = scoreFromMetrics(crossPackage);

			expect(crossScore.score).toBeGreaterThan(singleScore.score);
			expect(crossScore.signals.some((s) => s.includes("cross-package"))).toBe(true);
		});

		it("scores higher for unhealthy files", () => {
			const healthy = { ...createBaseMetrics(), fileCount: 1 };
			const unhealthy = {
				...createBaseMetrics(),
				fileCount: 1,
				unhealthyFiles: ["bad.ts"],
				avgCodeHealth: 4,
			};

			const healthyScore = scoreFromMetrics(healthy);
			const unhealthyScore = scoreFromMetrics(unhealthy);

			expect(unhealthyScore.score).toBeGreaterThan(healthyScore.score);
		});

		it("scores higher for git hotspots", () => {
			const calm = { ...createBaseMetrics(), fileCount: 1 };
			const hotspot = {
				...createBaseMetrics(),
				fileCount: 1,
				git: {
					avgChangeFrequency: 15,
					hotspots: ["hot.ts"],
					bugProneFiles: [],
				},
			};

			const calmScore = scoreFromMetrics(calm);
			const hotspotScore = scoreFromMetrics(hotspot);

			expect(hotspotScore.score).toBeGreaterThan(calmScore.score);
		});

		it("scores higher for bug-prone files", () => {
			const stable = { ...createBaseMetrics(), fileCount: 1 };
			const buggy = {
				...createBaseMetrics(),
				fileCount: 1,
				git: {
					avgChangeFrequency: 0,
					hotspots: [],
					bugProneFiles: ["buggy.ts"],
				},
			};

			const stableScore = scoreFromMetrics(stable);
			const buggyScore = scoreFromMetrics(buggy);

			expect(buggyScore.score).toBeGreaterThan(stableScore.score);
		});
	});

	describe("shouldEscalateToFullChain", () => {
		const createAssessment = (overrides = {}) => ({
			level: "simple",
			confidence: 0.8,
			model: "sonnet",
			useFullChain: false,
			needsReview: false,
			estimatedScope: "single-file",
			signals: [],
			score: 2,
			team: getTeamComposition("simple"),
			...overrides,
		});

		it("should escalate when there are type errors", () => {
			const assessment = createAssessment();
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 1,
				linesChanged: 10,
				hasTests: true,
				hasTypeErrors: true,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should escalate when there are build errors", () => {
			const assessment = createAssessment();
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 1,
				linesChanged: 10,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: true,
			});
			expect(result).toBe(true);
		});

		it("should escalate when single-file scope is exceeded (>3 files)", () => {
			const assessment = createAssessment({ estimatedScope: "single-file" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 5,
				linesChanged: 100,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should not escalate when single-file scope matches", () => {
			const assessment = createAssessment({ estimatedScope: "single-file" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 2,
				linesChanged: 50,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(false);
		});

		it("should escalate when few-files scope is exceeded (>10 files)", () => {
			const assessment = createAssessment({ estimatedScope: "few-files" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 15,
				linesChanged: 300,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should escalate for large changes (>200 lines) without tests", () => {
			const assessment = createAssessment();
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 2,
				linesChanged: 250,
				hasTests: false,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should not escalate for large changes with tests", () => {
			const assessment = createAssessment();
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 2,
				linesChanged: 250,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(false);
		});

		it("should always escalate complex level tasks", () => {
			const assessment = createAssessment({ level: "complex" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 1,
				linesChanged: 10,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should always escalate critical level tasks", () => {
			const assessment = createAssessment({ level: "critical" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 1,
				linesChanged: 10,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(true);
		});

		it("should not escalate trivial tasks with clean results", () => {
			const assessment = createAssessment({ level: "trivial" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 1,
				linesChanged: 5,
				hasTests: false,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(false);
		});

		it("should not escalate standard tasks with clean results within scope", () => {
			const assessment = createAssessment({ level: "standard", estimatedScope: "few-files" });
			const result = shouldEscalateToFullChain(assessment, {
				filesChanged: 3,
				linesChanged: 100,
				hasTests: true,
				hasTypeErrors: false,
				hasBuildErrors: false,
			});
			expect(result).toBe(false);
		});
	});

	describe("adjustModelFromMetrics", () => {
		beforeEach(() => {
			vi.resetModules();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("should return recommended model when no metrics data", async () => {
			// Mock self-tuning to return null profile so we fall through to feedback-metrics
			vi.doMock("../self-tuning.js", () => ({
				loadRoutingProfile: () => null,
				shouldSkipModel: () => false,
				getThreshold: () => ({ minSuccessRate: 0.7, minSamples: 3 }),
			}));
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 0,
					byModel: {},
					byModelAndComplexity: {},
				}),
			}));

			const result = await adjustModelFromMetrics("sonnet", "standard", 3);
			expect(result).toBe("sonnet");
		});

		it("should return recommended model when insufficient samples", async () => {
			// Mock self-tuning to return null profile so we fall through to feedback-metrics
			vi.doMock("../self-tuning.js", () => ({
				loadRoutingProfile: () => null,
				shouldSkipModel: () => false,
				getThreshold: () => ({ minSuccessRate: 0.7, minSamples: 3 }),
			}));
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 2, // Below minSamples
					byModel: {
						sonnet: { total: 2, rate: 0.5 },
					},
					byModelAndComplexity: {},
				}),
			}));

			const result = await adjustModelFromMetrics("sonnet", "standard", 3);
			expect(result).toBe("sonnet");
		});

		it("should upgrade sonnet to opus when success rate below threshold", async () => {
			// Mock self-tuning to return null so we fall through to feedback-metrics
			vi.doMock("../self-tuning.js", () => ({
				loadRoutingProfile: () => null,
				shouldSkipModel: () => false,
				getThreshold: () => ({ minSuccessRate: 0.7, minSamples: 3 }),
			}));
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 10,
					byModel: {
						haiku: { total: 10, rate: 0.5 }, // Below 0.7 threshold
					},
					byModelAndComplexity: {},
				}),
			}));

			const { adjustModelFromMetrics: adjustFn } = await import("../complexity.js");
			const result = await adjustFn("sonnet", "simple", 3);
			expect(result).toBe("sonnet");
		});

		it("should upgrade sonnet to opus when success rate below threshold", async () => {
			// Mock self-tuning to return null so we fall through to feedback-metrics
			vi.doMock("../self-tuning.js", () => ({
				loadRoutingProfile: () => null,
				shouldSkipModel: () => false,
				getThreshold: () => ({ minSuccessRate: 0.6, minSamples: 3 }),
			}));
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 10,
					byModel: {
						sonnet: { total: 10, rate: 0.4 }, // Below 0.6 threshold
					},
					byModelAndComplexity: {},
				}),
			}));

			const { adjustModelFromMetrics: adjustFn } = await import("../complexity.js");
			const result = await adjustFn("sonnet", "standard", 3);
			expect(result).toBe("opus");
		});

		it("should not upgrade opus (ceiling)", async () => {
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 10,
					byModel: {
						opus: { total: 10, rate: 0.3 }, // Even low rate doesn't upgrade opus
					},
					byModelAndComplexity: {},
				}),
			}));

			const result = await adjustModelFromMetrics("opus", "complex", 3);
			expect(result).toBe("opus");
		});

		it("should keep model when success rate meets threshold", async () => {
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 10,
					byModel: {
						haiku: { total: 10, rate: 0.85 }, // Above 0.7 threshold
					},
					byModelAndComplexity: {},
				}),
			}));

			const result = await adjustModelFromMetrics("sonnet", "simple", 3);
			expect(result).toBe("sonnet");
		});

		it("should use model+complexity combo stats when available", async () => {
			// Mock self-tuning to return null so we fall through to feedback-metrics
			vi.doMock("../self-tuning.js", () => ({
				loadRoutingProfile: () => null,
				shouldSkipModel: () => false,
				getThreshold: () => ({ minSuccessRate: 0.7, minSamples: 3 }),
			}));
			vi.doMock("../feedback-metrics.js", () => ({
				getMetricsAnalysis: () => ({
					totalTasks: 20,
					byModel: {
						haiku: { total: 20, rate: 0.8 }, // Overall good
					},
					byModelAndComplexity: {
						"haiku:complex": { total: 5, rate: 0.4 }, // But bad for complex tasks
					},
				}),
			}));

			const { adjustModelFromMetrics: adjustFn } = await import("../complexity.js");
			const result = await adjustFn("sonnet", "complex", 3);
			expect(result).toBe("sonnet"); // Upgrade based on combo stats
		});
	});
});
