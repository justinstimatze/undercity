/**
 * Diff Generation Service for Experiments
 *
 * Service to run diff generation experiments comparing Ollama models vs Haiku
 */

import { readFileSync, writeFileSync } from "node:fs";
import { generateDiffWithOllama, isOllamaAvailable, type LocalModel, testOllamaModel } from "../local-llm.js";
import { sessionLogger } from "../logger.js";
import type { ExperimentFramework } from "./framework.js";
import { ExperimentOutcome, VariantParameters } from "./types.js";

/**
 * Simple edit instruction for testing
 */
export interface SimpleEditTask {
	id: string;
	filePath: string;
	originalContent: string;
	instruction: string;
	expectedResult?: string;
	difficulty: "simple" | "medium" | "complex";
}

/**
 * Diff generation test result
 */
export interface DiffTestResult {
	taskId: string;
	success: boolean;
	diffGenerated: boolean;
	diffApplied: boolean;
	executionTimeMs: number;
	tokensUsed: number;
	model: string;
	diffSize?: number;
	error?: string;
	actualResult?: string;
}

/**
 * Service to run diff generation experiments
 */
export class DiffGenerationService {
	constructor(private experimentFramework: ExperimentFramework) {}

	/**
	 * Generate sample edit tasks for testing
	 */
	generateSampleTasks(): SimpleEditTask[] {
		return [
			{
				id: "task-001",
				filePath: "src/example.ts",
				originalContent: `export function add(a: number, b: number): number {
  return a + b;
}`,
				instruction: "Add input validation to check if numbers are finite",
				difficulty: "simple",
			},
			{
				id: "task-002",
				filePath: "src/user.ts",
				originalContent: `interface User {
  id: string;
  name: string;
}`,
				instruction: "Add an optional email field to the User interface",
				difficulty: "simple",
			},
			{
				id: "task-003",
				filePath: "src/api.ts",
				originalContent: `export async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}`,
				instruction: "Add error handling for failed requests and non-JSON responses",
				difficulty: "medium",
			},
			{
				id: "task-004",
				filePath: "src/math.ts",
				originalContent: `export class Calculator {
  add(a: number, b: number) {
    return a + b;
  }
}`,
				instruction: "Add subtract, multiply, and divide methods with proper error handling for division by zero",
				difficulty: "medium",
			},
			{
				id: "task-005",
				filePath: "src/complex.ts",
				originalContent: `export class DataProcessor {
  constructor(private config: ProcessorConfig) {}

  process(data: unknown[]): ProcessedResult[] {
    return data.map(item => ({ processed: true, value: item }));
  }
}`,
				instruction: "Add type safety with generics, validation, and async processing with proper error boundaries",
				difficulty: "complex",
			},
		];
	}

	/**
	 * Test diff generation with Haiku (cloud API)
	 */
	async testHaikuDiffGeneration(task: SimpleEditTask): Promise<DiffTestResult> {
		const startTime = Date.now();

		try {
			// For this experiment, we'll simulate Haiku diff generation
			// In practice, this would use the Claude API
			sessionLogger.info({ taskId: task.id }, "Simulating Haiku diff generation");

			// Simulate API latency
			await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 200));

			// For the experiment, we'll create a basic diff simulation
			// In practice, this would use actual Claude Haiku API
			const simulatedResult = this.simulateHaikuDiff(task);

			return {
				taskId: task.id,
				success: simulatedResult.success,
				diffGenerated: simulatedResult.success,
				diffApplied: simulatedResult.success,
				executionTimeMs: Date.now() - startTime,
				tokensUsed: simulatedResult.tokensUsed,
				model: "haiku",
				diffSize: simulatedResult.diffSize,
				actualResult: simulatedResult.content,
			};
		} catch (error) {
			return {
				taskId: task.id,
				success: false,
				diffGenerated: false,
				diffApplied: false,
				executionTimeMs: Date.now() - startTime,
				tokensUsed: 0,
				model: "haiku",
				error: String(error),
			};
		}
	}

	/**
	 * Test diff generation with Ollama
	 */
	async testOllamaDiffGeneration(task: SimpleEditTask, model: LocalModel): Promise<DiffTestResult> {
		const startTime = Date.now();

		try {
			if (!isOllamaAvailable()) {
				throw new Error("Ollama is not available");
			}

			const result = await generateDiffWithOllama({
				filePath: task.filePath,
				oldContent: task.originalContent,
				instruction: task.instruction,
				model,
			});

			const success = result.success && result.newContent !== undefined;

			return {
				taskId: task.id,
				success,
				diffGenerated: result.success,
				diffApplied: success,
				executionTimeMs: result.executionTimeMs,
				tokensUsed: result.tokensUsed,
				model: result.model,
				diffSize: result.diff?.length,
				actualResult: result.newContent,
				error: result.error,
			};
		} catch (error) {
			return {
				taskId: task.id,
				success: false,
				diffGenerated: false,
				diffApplied: false,
				executionTimeMs: Date.now() - startTime,
				tokensUsed: 0,
				model,
				error: String(error),
			};
		}
	}

	/**
	 * Run a batch of diff generation experiments
	 */
	async runDiffExperiment(experimentId: string, tasks: SimpleEditTask[], trialsPerTask: number = 3): Promise<void> {
		const experiment = this.experimentFramework.getExperiment(experimentId);
		if (!experiment) {
			throw new Error(`Experiment ${experimentId} not found`);
		}

		sessionLogger.info(
			{
				experimentId,
				taskCount: tasks.length,
				trialsPerTask,
			},
			"Starting diff generation experiment",
		);

		let trialCount = 0;
		const totalTrials = tasks.length * trialsPerTask;

		for (const task of tasks) {
			for (let trial = 0; trial < trialsPerTask; trial++) {
				trialCount++;
				const taskId = `${task.id}-trial-${trial}`;

				sessionLogger.info(
					{
						trialId: taskId,
						originalTaskId: task.id,
						trial: trial + 1,
						progress: `${trialCount}/${totalTrials}`,
					},
					"Running trial",
				);

				// Assign to experiment variant
				const assignment = this.experimentFramework.assignTaskToVariant(taskId, experimentId);
				if (!assignment) {
					sessionLogger.warn({ taskId, experimentId }, "Failed to assign to experiment variant");
					continue;
				}

				const variantParams = this.experimentFramework.getVariantParameters(taskId, experimentId);
				if (!variantParams) {
					sessionLogger.warn({ taskId, experimentId }, "No variant parameters found");
					continue;
				}

				// Run the diff generation test
				let result: DiffTestResult;

				if (variantParams.useLocalLLM && variantParams.localModel) {
					result = await this.testOllamaDiffGeneration(task, variantParams.localModel);
				} else {
					result = await this.testHaikuDiffGeneration(task);
				}

				// Record outcome
				const outcome: Parameters<typeof this.experimentFramework.recordOutcome>[2] = {
					success: result.success,
					tokensUsed: result.tokensUsed,
					executionTimeMs: result.executionTimeMs,
					reworkCount: result.success ? 0 : 1,
					metadata: {
						taskId: task.id,
						taskDifficulty: task.difficulty,
						model: result.model,
						error: result.error,
						variantParams,
					},
					diffMetrics: {
						diffGenerated: result.diffGenerated,
						diffApplied: result.diffApplied,
						diffGenerationTimeMs: result.executionTimeMs,
						diffModel: result.model,
						diffSize: result.diffSize,
					},
				};

				try {
					this.experimentFramework.recordOutcome(experimentId, taskId, outcome);
					sessionLogger.info(
						{
							taskId,
							success: result.success,
							model: result.model,
							executionTimeMs: result.executionTimeMs,
						},
						"Recorded experiment outcome",
					);
				} catch (error) {
					sessionLogger.error({ taskId, error }, "Failed to record experiment outcome");
				}

				// Small delay between trials to avoid overwhelming the system
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		sessionLogger.info({ experimentId, totalTrials }, "Diff generation experiment completed");
	}

	/**
	 * Simulate Haiku diff generation for baseline comparison
	 */
	private simulateHaikuDiff(task: SimpleEditTask): {
		success: boolean;
		tokensUsed: number;
		diffSize: number;
		content?: string;
	} {
		// Simulate different success rates based on difficulty
		const baseSuccessRate = task.difficulty === "simple" ? 0.95 : task.difficulty === "medium" ? 0.85 : 0.7;

		const success = Math.random() < baseSuccessRate;

		if (!success) {
			return {
				success: false,
				tokensUsed: 50 + Math.random() * 100,
				diffSize: 0,
			};
		}

		// Simulate realistic token usage for Haiku
		const baseTokens = task.difficulty === "simple" ? 150 : task.difficulty === "medium" ? 300 : 500;
		const tokensUsed = baseTokens + Math.random() * 100;

		// Generate a simple modified version for simulation
		const modifiedContent = this.generateSimpleModification(task);

		return {
			success: true,
			tokensUsed: Math.round(tokensUsed),
			diffSize: modifiedContent.length - task.originalContent.length,
			content: modifiedContent,
		};
	}

	/**
	 * Generate a simple code modification for simulation
	 */
	private generateSimpleModification(task: SimpleEditTask): string {
		// Very basic modifications based on common patterns
		let modified = task.originalContent;

		if (task.instruction.includes("validation") || task.instruction.includes("check")) {
			// Add simple validation
			modified = modified.replace(
				/^(\s*)(.*?): number[^{]*{/m,
				'$1$2: number {\n$1  if (!isFinite(a) || !isFinite(b)) throw new Error("Invalid input");\n$1',
			);
		} else if (task.instruction.includes("email field")) {
			// Add email field
			modified = modified.replace(/(\s+name: string;)/, "$1\n  email?: string;");
		} else if (task.instruction.includes("error handling")) {
			// Add basic error handling
			modified = modified.replace(
				/return response\.json\(\);/,
				`if (!response.ok) throw new Error('Request failed');
  return response.json();`,
			);
		}

		return modified;
	}

	/**
	 * Test Ollama availability and models
	 */
	async testOllamaSetup(): Promise<{ available: boolean; models: string[]; testResults: Record<string, any> }> {
		const available = isOllamaAvailable();

		if (!available) {
			return { available: false, models: [], testResults: {} };
		}

		const models = ["qwen2:1.5b", "deepseek-coder:6.7b-instruct", "codellama:7b-code"];
		const testResults: Record<string, any> = {};

		for (const model of models) {
			try {
				const result = await testOllamaModel(model as LocalModel);
				testResults[model] = result;
			} catch (error) {
				testResults[model] = { success: false, error: String(error) };
			}
		}

		return { available, models, testResults };
	}
}
