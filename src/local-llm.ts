/**
 * Local LLM Integration Module
 *
 * Provides interface to Ollama for local LLM inference,
 * specifically for code diff generation experiments.
 */

import { execSync } from "node:child_process";
import { raidLogger } from "./logger.js";

/**
 * Available Ollama models for code generation
 */
export const LOCAL_MODELS = [
  "qwen2:0.5b",
  "qwen2:1.5b",
  "qwen2:3b",
  "codellama:7b-code",
  "deepseek-coder:6.7b-base",
  "deepseek-coder:6.7b-instruct",
] as const;

export type LocalModel = typeof LOCAL_MODELS[number];

/**
 * Ollama response structure
 */
export interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Diff generation request
 */
export interface DiffRequest {
  filePath: string;
  oldContent: string;
  instruction: string;
  model?: LocalModel;
}

/**
 * Diff generation result
 */
export interface DiffResult {
  success: boolean;
  diff?: string;
  newContent?: string;
  model: string;
  tokensUsed: number;
  executionTimeMs: number;
  error?: string;
}

/**
 * Check if Ollama is available and running
 */
export function isOllamaAvailable(): boolean {
  try {
    execSync("ollama list", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of available models from Ollama
 */
export function getAvailableModels(): string[] {
  try {
    const output = execSync("ollama list", {
      encoding: "utf-8",
      timeout: 10000
    });

    const lines = output.split("\n").slice(1); // Skip header
    return lines
      .filter(line => line.trim())
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch (error) {
    raidLogger.warn({ error: String(error) }, "Failed to get Ollama models");
    return [];
  }
}

/**
 * Check if a specific model is available
 */
export function isModelAvailable(model: LocalModel): boolean {
  const available = getAvailableModels();
  return available.includes(model);
}

/**
 * Query Ollama for diff generation
 */
export async function queryLocal(
  prompt: string,
  model: LocalModel = "qwen2:1.5b"
): Promise<OllamaResponse> {
  if (!isOllamaAvailable()) {
    throw new Error("Ollama is not available");
  }

  if (!isModelAvailable(model)) {
    throw new Error(`Model ${model} is not available`);
  }

  try {
    const requestPayload = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1, // Low temperature for consistent code generation
        num_predict: 2048, // Reasonable limit for diff generation
      },
    });

    const output = execSync(`echo '${requestPayload}' | curl -s -X POST http://localhost:11434/api/generate -d @-`, {
      encoding: "utf-8",
      timeout: 60000, // 1 minute timeout
    });

    const response: OllamaResponse = JSON.parse(output);

    if (!response.done) {
      throw new Error("Ollama response not complete");
    }

    return response;
  } catch (error) {
    raidLogger.error({ error: String(error), model, prompt: prompt.substring(0, 100) }, "Ollama query failed");
    throw error;
  }
}

/**
 * Generate a diff for a code file using local LLM
 */
export async function generateDiffWithOllama({
  filePath,
  oldContent,
  instruction,
  model = "qwen2:1.5b"
}: DiffRequest): Promise<DiffResult> {
  const startTime = Date.now();

  try {
    const prompt = `You are a code diff generator. Generate a minimal diff to apply the following change:

File: ${filePath}
Instruction: ${instruction}

Current content:
\`\`\`
${oldContent}
\`\`\`

Respond with ONLY the modified content, no explanations, no markdown formatting, just the updated code:`;

    const response = await queryLocal(prompt, model);
    const executionTimeMs = Date.now() - startTime;

    // Extract the new content from the response
    const newContent = response.response.trim();

    // Generate a simple diff (could be enhanced with a proper diff library)
    const diff = generateSimpleDiff(oldContent, newContent);

    return {
      success: true,
      diff,
      newContent,
      model,
      tokensUsed: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      executionTimeMs,
    };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    return {
      success: false,
      model,
      tokensUsed: 0,
      executionTimeMs,
      error: String(error),
    };
  }
}

/**
 * Simple diff generation (for basic comparison)
 * In production, would use a proper diff library like 'diff'
 */
function generateSimpleDiff(oldContent: string, newContent: string): string {
  if (oldContent === newContent) {
    return "No changes";
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const diff: string[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";

    if (oldLine !== newLine) {
      if (oldLine) {
        diff.push(`-${oldLine}`);
      }
      if (newLine) {
        diff.push(`+${newLine}`);
      }
    }
  }

  return diff.length > 0 ? diff.join("\n") : "No changes";
}

/**
 * Test Ollama model with a simple code generation task
 */
export async function testOllamaModel(model: LocalModel): Promise<{
  success: boolean;
  responseTime: number;
  tokensPerSecond?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const testPrompt = `Write a simple TypeScript function that adds two numbers:`;

    const response = await queryLocal(testPrompt, model);
    const responseTime = Date.now() - startTime;

    const tokensPerSecond = response.eval_count && response.eval_duration
      ? (response.eval_count / (response.eval_duration / 1000000000)) // Convert nanoseconds to seconds
      : undefined;

    return {
      success: true,
      responseTime,
      tokensPerSecond,
    };
  } catch (error) {
    return {
      success: false,
      responseTime: Date.now() - startTime,
      error: String(error),
    };
  }
}