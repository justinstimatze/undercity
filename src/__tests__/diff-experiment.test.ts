/**
 * Test diff generation experiment functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExperimentFramework } from "../experiments/framework.js";
import { ExperimentTemplates } from "../experiments/examples.js";
import { DiffGenerationService } from "../experiments/diff-generator.js";
import { rmSync, existsSync, mkdirSync } from "node:fs";

const TEST_STORAGE_DIR = ".undercity-test";
const TEST_STORAGE_PATH = `${TEST_STORAGE_DIR}/test-experiments.json`;

describe("Diff Generation Experiments", () => {
  let framework: ExperimentFramework;
  let templates: ExperimentTemplates;
  let diffService: DiffGenerationService;

  beforeEach(() => {
    // Clean up any existing test storage
    if (existsSync(TEST_STORAGE_DIR)) {
      rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_STORAGE_DIR, { recursive: true });

    framework = new ExperimentFramework(TEST_STORAGE_PATH);
    templates = new ExperimentTemplates(framework);
    diffService = new DiffGenerationService(framework);
  });

  afterEach(() => {
    // Clean up test storage
    if (existsSync(TEST_STORAGE_DIR)) {
      rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  it("should create Ollama vs Haiku diff experiment", () => {
    const experimentId = templates.createOllamaDiffExperiment();

    expect(experimentId).toBeTruthy();

    const experiment = framework.getExperiment(experimentId);
    expect(experiment).toBeTruthy();
    expect(experiment!.name).toBe("Ollama vs Haiku Comprehensive Diff Generation");
    expect(experiment!.variants).toHaveLength(4);

    // Check that control variant is properly marked
    const controlVariant = experiment!.variants.find(v => v.isControl);
    expect(controlVariant).toBeTruthy();
    expect(controlVariant!.name).toBe("Haiku Cloud API (Control)");
  });

  it("should create comprehensive diff experiment", () => {
    const experimentId = templates.createOllamaVsHaikuDiffExperiment();

    const experiment = framework.getExperiment(experimentId);
    expect(experiment).toBeTruthy();
    expect(experiment!.tags).toContain("diff-generation");
    expect(experiment!.tags).toContain("ollama");
  });

  it("should generate sample edit tasks", () => {
    const tasks = diffService.generateSampleTasks();

    expect(tasks).toHaveLength(5);
    expect(tasks[0]).toMatchObject({
      id: "task-001",
      filePath: "src/example.ts",
      difficulty: "simple",
    });

    // Check that we have different difficulty levels
    const difficulties = new Set(tasks.map(t => t.difficulty));
    expect(difficulties).toContain("simple");
    expect(difficulties).toContain("medium");
    expect(difficulties).toContain("complex");
  });

  it("should simulate Haiku diff generation", async () => {
    const task = diffService.generateSampleTasks()[0];
    const result = await diffService.testHaikuDiffGeneration(task);

    expect(result.taskId).toBe(task.id);
    expect(result.model).toBe("haiku");
    expect(result.executionTimeMs).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.diffGenerated).toBe("boolean");
    expect(typeof result.diffApplied).toBe("boolean");
  });

  it("should handle experiment assignment and outcome recording", () => {
    const experimentId = templates.createOllamaDiffExperiment();
    framework.startExperiment(experimentId);

    const questId = "test-quest-001";
    const assignment = framework.assignQuestToVariant(questId, experimentId);

    expect(assignment).toBeTruthy();
    expect(assignment!.questId).toBe(questId);
    expect(assignment!.experimentId).toBe(experimentId);

    // Record a test outcome
    framework.recordOutcome(experimentId, questId, {
      success: true,
      tokensUsed: 150,
      executionTimeMs: 500,
      reworkCount: 0,
      diffMetrics: {
        diffGenerated: true,
        diffApplied: true,
        diffGenerationTimeMs: 500,
        diffModel: "qwen2:1.5b",
        diffSize: 50,
      },
    });

    const analysis = framework.analyzeExperiment(experimentId);
    expect(analysis.sampleSizes).toBeDefined();
    expect(Object.values(analysis.sampleSizes).some(size => size > 0)).toBe(true);
  });

  it("should handle Ollama availability testing", async () => {
    // Mock Ollama as unavailable for this test
    vi.mock("../local-llm.js", () => ({
      isOllamaAvailable: () => false,
      getAvailableModels: () => [],
      testOllamaModel: vi.fn(),
    }));

    const setup = await diffService.testOllamaSetup();
    expect(setup.available).toBe(false);
    expect(setup.models).toEqual([]);
  });

  it("should calculate diff-specific metrics", () => {
    // Create a simple single-variant experiment for testing metrics
    const testExperiment = framework.createExperiment(
      "Test Diff Metrics",
      "Test diff-specific metric calculations",
      "Should calculate metrics correctly",
      [
        {
          name: "Test Variant",
          description: "Single variant for testing",
          weight: 1.0,
          isControl: true,
          parameters: {
            useLocalLLM: true,
            localModel: "qwen2:1.5b",
          },
        },
      ],
      { targetSampleSize: 10 }
    );

    framework.startExperiment(testExperiment.id);

    // Record some outcomes with diff metrics
    for (let i = 0; i < 3; i++) {
      const questId = `test-quest-${i}`;
      framework.assignQuestToVariant(questId, testExperiment.id);

      framework.recordOutcome(testExperiment.id, questId, {
        success: i < 2, // 2/3 success rate
        tokensUsed: 100 + i * 50,
        executionTimeMs: 300 + i * 100,
        reworkCount: i > 1 ? 1 : 0,
        diffMetrics: {
          diffGenerated: true,
          diffApplied: i < 2, // Only first 2 (i=0,1) should be applied
          diffGenerationTimeMs: 300 + i * 100,
          diffModel: "test-model",
          diffSize: 40 + i * 10,
        },
      });
    }

    const analysis = framework.analyzeExperiment(testExperiment.id);
    const firstVariantId = Object.keys(analysis.variantMetrics)[0];
    const metrics = analysis.variantMetrics[firstVariantId];
    const sampleSize = analysis.sampleSizes[firstVariantId];

    expect(sampleSize).toBe(3);
    expect(metrics.diffSuccessRate).toBeCloseTo(1.0); // All generated diffs
    expect(metrics.diffApplicationSuccessRate).toBeCloseTo(2/3); // 2/3 applied successfully
    expect(metrics.avgDiffGenerationTimeMs).toBeGreaterThan(0);
  });
});