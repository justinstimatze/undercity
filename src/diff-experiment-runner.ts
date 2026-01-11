/**
 * Diff Generation Experiment Runner
 *
 * Runs controlled experiments to compare Ollama local models
 * against cloud models for simple code diff generation tasks.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ExperimentFramework } from "./experiments/framework.js";
import { QuestExperimentIntegrator } from "./experiments/integration.js";
import type { ExperimentOutcome } from "./experiments/types.js";
import { generateDiffWithOllama, isOllamaAvailable, type DiffRequest } from "./local-llm.js";
import { raidLogger } from "./logger.js";

/**
 * Test case for diff generation
 */
export interface DiffTestCase {
  id: string;
  description: string;
  filePath: string;
  originalContent: string;
  instruction: string;
  expectedPattern?: RegExp;
  difficulty: "trivial" | "simple" | "medium";
}

/**
 * Result of a single diff generation test
 */
export interface DiffTestResult {
  testCaseId: string;
  success: boolean;
  diffGenerated: boolean;
  diffApplied: boolean;
  executionTimeMs: number;
  tokensUsed: number;
  model: string;
  error?: string;
  generatedDiff?: string;
}

/**
 * Sample test cases for diff generation experiments
 */
const SAMPLE_TEST_CASES: DiffTestCase[] = [
  {
    id: "typo-fix",
    description: "Fix a simple typo in a comment",
    filePath: "example.ts",
    originalContent: `// This is a simple functoin
function add(a: number, b: number): number {
  return a + b;
}`,
    instruction: "Fix the typo in the comment (functoin -> function)",
    expectedPattern: /function/,
    difficulty: "trivial"
  },
  {
    id: "add-comment",
    description: "Add a JSDoc comment to a function",
    filePath: "math.ts",
    originalContent: `function multiply(x: number, y: number): number {
  return x * y;
}`,
    instruction: "Add a JSDoc comment explaining what this function does",
    expectedPattern: /\/\*\*.*\*\//s,
    difficulty: "simple"
  },
  {
    id: "rename-variable",
    description: "Rename a variable for better clarity",
    filePath: "utils.ts",
    originalContent: `function processData(d: any[]): number {
  let c = 0;
  for (const item of d) {
    if (item.active) {
      c++;
    }
  }
  return c;
}`,
    instruction: "Rename variable 'd' to 'data' and 'c' to 'count'",
    expectedPattern: /data.*count/s,
    difficulty: "simple"
  },
  {
    id: "add-type-annotation",
    description: "Add proper TypeScript type annotations",
    filePath: "config.ts",
    originalContent: `const config = {
  port: 3000,
  host: "localhost",
  debug: true
};`,
    instruction: "Add a proper TypeScript interface for the config object",
    expectedPattern: /interface.*Config/s,
    difficulty: "medium"
  },
  {
    id: "error-handling",
    description: "Add basic error handling to a function",
    filePath: "api.ts",
    originalContent: `function parseJSON(jsonString: string) {
  return JSON.parse(jsonString);
}`,
    instruction: "Add try-catch error handling and return null on parse errors",
    expectedPattern: /try.*catch/s,
    difficulty: "medium"
  }
];

/**
 * Diff Generation Experiment Runner
 */
export class DiffExperimentRunner {
  public framework: ExperimentFramework;
  private integrator: QuestExperimentIntegrator;

  constructor() {
    this.framework = new ExperimentFramework();
    this.integrator = new QuestExperimentIntegrator(this.framework);
  }

  /**
   * Run a single diff generation test case
   */
  async runDiffTest(
    testCase: DiffTestCase,
    useOllama: boolean = true,
    model: string = "qwen2:1.5b"
  ): Promise<DiffTestResult> {
    const startTime = Date.now();

    try {
      if (useOllama) {
        if (!isOllamaAvailable()) {
          throw new Error("Ollama is not available");
        }

        const result = await generateDiffWithOllama({
          filePath: testCase.filePath,
          oldContent: testCase.originalContent,
          instruction: testCase.instruction,
          model: model as any
        });

        const diffApplied = testCase.expectedPattern
          ? testCase.expectedPattern.test(result.newContent || "")
          : true;

        return {
          testCaseId: testCase.id,
          success: result.success && diffApplied,
          diffGenerated: result.success,
          diffApplied,
          executionTimeMs: result.executionTimeMs,
          tokensUsed: result.tokensUsed,
          model: result.model,
          error: result.error,
          generatedDiff: result.diff
        };
      } else {
        // Simulate Haiku API call (would need actual implementation)
        const executionTimeMs = Date.now() - startTime;

        // For now, just simulate a successful result
        return {
          testCaseId: testCase.id,
          success: true,
          diffGenerated: true,
          diffApplied: true,
          executionTimeMs,
          tokensUsed: 150, // Estimated tokens for Haiku
          model: "haiku",
          generatedDiff: "simulated diff"
        };
      }
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      return {
        testCaseId: testCase.id,
        success: false,
        diffGenerated: false,
        diffApplied: false,
        executionTimeMs,
        tokensUsed: 0,
        model,
        error: String(error)
      };
    }
  }

  /**
   * Run a batch of diff tests for an experiment
   */
  async runExperimentBatch(
    experimentId: string,
    testCases: DiffTestCase[] = SAMPLE_TEST_CASES,
    trials: number = 5
  ): Promise<void> {
    raidLogger.info({ experimentId, testCases: testCases.length, trials }, "Starting diff experiment batch");

    const experiment = this.framework.getExperiment(experimentId);
    if (!experiment) {
      throw new Error(`Experiment ${experimentId} not found`);
    }

    for (let trial = 0; trial < trials; trial++) {
      for (const testCase of testCases) {
        // Create a mock quest for this test case
        const questId = `diff-test-${testCase.id}-${trial}`;

        // Assign to experiment variant
        const assignment = this.framework.assignQuestToVariant(questId, experimentId);

        if (!assignment) {
          raidLogger.warn({ questId, experimentId }, "No assignment created");
          continue;
        }

        // Get variant parameters
        const variant = experiment.variants.find(v => v.id === assignment.variantId);
        if (!variant) {
          raidLogger.warn({ variantId: assignment.variantId }, "Variant not found");
          continue;
        }

        const useOllama = variant.parameters.useLocalLLM || false;
        const model = useOllama
          ? (variant.parameters.localModel || "qwen2:1.5b")
          : "haiku";

        // Run the test
        const result = await this.runDiffTest(testCase, useOllama, model);

        // Record outcome
        const outcome: Omit<ExperimentOutcome, 'id' | 'recordedAt'> = {
          experimentId,
          variantId: assignment.variantId,
          questId,
          success: result.success,
          tokensUsed: result.tokensUsed,
          executionTimeMs: result.executionTimeMs,
          reworkCount: result.success ? 0 : 1,
          metadata: {
            testCaseId: testCase.id,
            testDescription: testCase.description,
            difficulty: testCase.difficulty
          },
          diffMetrics: {
            diffGenerated: result.diffGenerated,
            diffApplied: result.diffApplied,
            diffGenerationTimeMs: result.executionTimeMs,
            diffModel: result.model,
            diffSize: result.generatedDiff?.length || 0
          }
        };

        this.framework.recordOutcome(experimentId, questId, outcome);

        raidLogger.debug({
          questId,
          testCaseId: testCase.id,
          success: result.success,
          model: result.model,
          executionTimeMs: result.executionTimeMs
        }, "Test case completed");
      }
    }

    // Analyze results
    const analysis = this.framework.analyzeExperiment(experimentId);

    raidLogger.info({
      experimentId,
      status: analysis.status,
      recommendation: analysis.recommendation,
      sampleSizes: analysis.sampleSizes
    }, "Experiment batch completed");

    console.log(`\n🧪 Experiment ${experimentId} Results:`);
    console.log(`Status: ${analysis.status}`);
    console.log(`Recommendation: ${analysis.recommendation}`);

    if (analysis.winningVariant) {
      const winner = experiment.variants.find(v => v.id === analysis.winningVariant);
      console.log(`Winner: ${winner?.name} (${(analysis.confidence * 100).toFixed(1)}% confidence)`);
    }
  }

  /**
   * Generate a simple experiment report
   */
  generateReport(experimentId: string): string {
    return this.integrator.generateExperimentReport(experimentId);
  }

  /**
   * Save experiment results to a file
   */
  saveResults(experimentId: string, outputPath: string): void {
    const report = this.generateReport(experimentId);
    writeFileSync(outputPath, report);
    console.log(`✅ Results saved to: ${outputPath}`);
  }
}

/**
 * Create and run a quick Ollama vs Haiku experiment
 */
export async function runQuickOllamaExperiment(): Promise<string> {
  const runner = new DiffExperimentRunner();

  // Create experiment
  const experimentId = runner.framework.createExperiment(
    "Quick Ollama vs Haiku Test",
    "Quick comparison of local Ollama vs Haiku for simple diff generation",
    "Ollama will be faster but Haiku may have better quality",
    [
      {
        name: "Haiku Control",
        description: "Claude Haiku via API",
        weight: 0.5,
        isControl: true,
        parameters: {
          useLocalLLM: false,
          customParameters: { diffProvider: "haiku" }
        }
      },
      {
        name: "Ollama Qwen2 1.5B",
        description: "Local Ollama Qwen2:1.5B",
        weight: 0.5,
        parameters: {
          useLocalLLM: true,
          localModel: "qwen2:1.5b" as const,
          customParameters: { diffProvider: "ollama" }
        }
      }
    ],
    {
      targetSampleSize: 10,
      minimumDetectableEffect: 0.2,
      tags: ["quick-test", "ollama", "diff-generation"]
    }
  ).id;

  // Start experiment
  runner.framework.startExperiment(experimentId);

  // Run batch with fewer trials for quick test
  await runner.runExperimentBatch(experimentId, SAMPLE_TEST_CASES.slice(0, 3), 2);

  return experimentId;
}