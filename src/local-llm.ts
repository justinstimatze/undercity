/**
 * Local LLM Integration via Ollama
 *
 * Uses local models for token-saving tasks:
 * - File summarization (before sending to Claude)
 * - Error interpretation (simple errors)
 * - Trivial task handling (very simple fixes)
 * - Pre-filtering (does this need Claude at all?)
 *
 * Falls back gracefully if Ollama isn't available.
 */

import { execSync, spawn } from "node:child_process";
import { raidLogger } from "./logger.js";

/**
 * Available local model tiers
 */
export type LocalModelTier = "tiny" | "small" | "medium";

/**
 * Model configurations
 */
const LOCAL_MODELS: Record<LocalModelTier, { name: string; fallback: string }> = {
	tiny: { name: "tinyllama", fallback: "phi3:mini" },
	small: { name: "phi3", fallback: "mistral" },
	medium: { name: "deepseek-coder:6.7b", fallback: "codellama:7b" },
};

/**
 * Check if Ollama is available
 */
export function isOllamaAvailable(): boolean {
	try {
		execSync("which ollama", { encoding: "utf-8", timeout: 1000 });
		// Also check if server is running
		execSync("ollama list", { encoding: "utf-8", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get available local models
 */
export function getAvailableModels(): string[] {
	try {
		const output = execSync("ollama list", { encoding: "utf-8", timeout: 5000 });
		const lines = output.split("\n").slice(1); // Skip header
		return lines.map((line) => line.split(/\s+/)[0]).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Find best available model for tier
 */
function findModelForTier(tier: LocalModelTier): string | null {
	const available = getAvailableModels();
	const config = LOCAL_MODELS[tier];

	if (available.includes(config.name)) return config.name;
	if (available.includes(config.fallback)) return config.fallback;

	// Try any code-focused model
	const codeModels = available.filter((m) => m.includes("code") || m.includes("coder") || m.includes("deepseek"));
	if (codeModels.length > 0) return codeModels[0];

	// Fall back to any available model
	return available[0] || null;
}

/**
 * Query local LLM
 */
export async function queryLocal(
	prompt: string,
	options: {
		tier?: LocalModelTier;
		timeout?: number;
		maxTokens?: number;
	} = {},
): Promise<string | null> {
	const tier = options.tier ?? "small";
	const timeout = options.timeout ?? 30000;

	if (!isOllamaAvailable()) {
		raidLogger.debug("Ollama not available, skipping local LLM");
		return null;
	}

	const model = findModelForTier(tier);
	if (!model) {
		raidLogger.debug("No suitable local model found");
		return null;
	}

	try {
		return await runOllama(model, prompt, timeout);
	} catch (error) {
		raidLogger.debug({ error: String(error) }, "Local LLM query failed");
		return null;
	}
}

/**
 * Run Ollama command
 */
async function runOllama(model: string, prompt: string, timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("ollama", ["run", model], {
			timeout,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let output = "";
		let error = "";

		proc.stdout.on("data", (data) => {
			output += data.toString();
		});

		proc.stderr.on("data", (data) => {
			error += data.toString();
		});

		proc.on("close", (code) => {
			if (code === 0) {
				resolve(output.trim());
			} else {
				reject(new Error(error || `Exit code ${code}`));
			}
		});

		proc.on("error", reject);

		// Send prompt
		proc.stdin.write(prompt);
		proc.stdin.end();
	});
}

/**
 * Summarize a file using local LLM
 * Returns null if local LLM not available
 */
export async function summarizeFileLocal(content: string, filePath: string): Promise<string | null> {
	// Truncate content to avoid overwhelming small models
	const truncated = content.slice(0, 4000);

	const prompt = `Summarize this code file in 2-3 sentences. Focus on: main purpose, key exports, dependencies.

File: ${filePath}

\`\`\`
${truncated}
\`\`\`

Summary:`;

	return queryLocal(prompt, { tier: "small", timeout: 20000 });
}

/**
 * Interpret a TypeScript error using local LLM
 */
export async function interpretErrorLocal(error: string, context?: string): Promise<string | null> {
	const prompt = `Explain this TypeScript error in one sentence and suggest a fix:

Error: ${error}
${context ? `\nContext:\n${context}` : ""}

Explanation and fix:`;

	return queryLocal(prompt, { tier: "tiny", timeout: 15000 });
}

/**
 * Check if a task is trivial enough for local LLM
 */
export async function canHandleLocally(task: string): Promise<boolean> {
	// Quick heuristic check first
	const trivialPatterns = [
		/^fix\s+typo/i,
		/^add\s+comment/i,
		/^update\s+version/i,
		/^rename\s+\w+\s+to\s+\w+/i,
		/^remove\s+unused/i,
	];

	if (trivialPatterns.some((p) => p.test(task))) {
		return true;
	}

	// More complex check via local LLM
	if (!isOllamaAvailable()) {
		return false;
	}

	const prompt = `Is this coding task trivial (single file, simple change) or complex? Answer only "trivial" or "complex".

Task: ${task}

Answer:`;

	const result = await queryLocal(prompt, { tier: "tiny", timeout: 10000 });
	return result?.toLowerCase().includes("trivial") ?? false;
}

/**
 * Batch process trivial tasks locally
 */
export async function batchTrivialTasks(
	tasks: string[],
): Promise<Array<{ task: string; handled: boolean; result?: string }>> {
	const results: Array<{ task: string; handled: boolean; result?: string }> = [];

	for (const task of tasks) {
		const canHandle = await canHandleLocally(task);
		if (canHandle) {
			// For now, just mark as potentially handleable
			// Full implementation would actually do the work
			results.push({ task, handled: false, result: "Marked for local processing" });
		} else {
			results.push({ task, handled: false });
		}
	}

	return results;
}

/**
 * Pre-filter context to reduce tokens sent to Claude
 * Uses local LLM to summarize large files
 */
export async function compressContextForClaude(
	files: Array<{ path: string; content: string }>,
): Promise<Array<{ path: string; content: string; summary?: string }>> {
	const result: Array<{ path: string; content: string; summary?: string }> = [];

	for (const file of files) {
		if (file.content.length > 2000) {
			// Large file - try to summarize
			const summary = await summarizeFileLocal(file.content, file.path);
			if (summary) {
				result.push({
					path: file.path,
					content: file.content.slice(0, 500) + "\n...\n[truncated]",
					summary,
				});
				continue;
			}
		}
		result.push(file);
	}

	return result;
}
