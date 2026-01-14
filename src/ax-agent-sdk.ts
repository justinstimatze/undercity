/**
 * Ax AI Service adapter for Claude Agent SDK
 *
 * Wraps the Agent SDK query() function to work with Ax's AxAIService interface.
 * This allows using Ax's DSPy-style signatures and self-improving prompts
 * while authenticating via Claude Max OAuth instead of API keys.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	AxAIFeatures,
	AxAIModelList,
	AxAIService,
	AxAIServiceMetrics,
	AxAIServiceOptions,
	AxChatRequest,
	AxChatResponse,
	AxEmbedRequest,
	AxEmbedResponse,
	AxLoggerFunction,
	AxModelConfig,
} from "@ax-llm/ax";
import { sessionLogger } from "./logger.js";
import { MODEL_NAMES, type ModelTier } from "./types.js";

const logger = sessionLogger.child({ module: "ax-agent-sdk" });

/**
 * Convert Ax chat prompt to a string prompt for the Agent SDK
 */
function chatPromptToString(chatPrompt: AxChatRequest["chatPrompt"]): string {
	const parts: string[] = [];

	for (const message of chatPrompt) {
		if (message.role === "system") {
			parts.push(`[System]\n${message.content}\n`);
		} else if (message.role === "user") {
			const content = typeof message.content === "string" ? message.content : "[complex content]";
			parts.push(`[User]\n${content}\n`);
		} else if (message.role === "assistant") {
			const content = typeof message.content === "string" ? message.content : "[complex content]";
			parts.push(`[Assistant]\n${content}\n`);
		}
	}

	return parts.join("\n");
}

/**
 * Resolve model key to actual model name
 */
function resolveModel(model: string | undefined): string {
	if (!model) return MODEL_NAMES.haiku;

	// Check if it's a tier key
	if (model in MODEL_NAMES) {
		return MODEL_NAMES[model as ModelTier];
	}

	// Check if it's already a full model name
	if (model.includes("claude")) {
		return model;
	}

	// Default to haiku
	return MODEL_NAMES.haiku;
}

/**
 * AxAIService implementation using Claude Agent SDK
 *
 * Uses Claude Max OAuth authentication instead of API keys.
 * Designed for single-turn completions (Ax programs), not multi-turn agents.
 */
export class AxAgentSDK implements AxAIService<string, string, ModelTier> {
	private options: AxAIServiceOptions = {};
	private lastModel: string | undefined;
	private metrics: AxAIServiceMetrics = {
		latency: {
			chat: { mean: 0, p95: 0, p99: 0, samples: [] },
			embed: { mean: 0, p95: 0, p99: 0, samples: [] },
		},
		errors: {
			chat: { count: 0, rate: 0, total: 0 },
			embed: { count: 0, rate: 0, total: 0 },
		},
	};

	getId(): string {
		return "ax-agent-sdk";
	}

	getName(): string {
		return "Claude Agent SDK (Claude Max)";
	}

	getFeatures(_model?: string): AxAIFeatures {
		return {
			functions: false, // We disable tool use for Ax programs
			streaming: false,
			structuredOutputs: false,
			media: {
				images: { supported: false, formats: [] },
				audio: { supported: false, formats: [] },
				files: { supported: false, formats: [], uploadMethod: "none" },
				urls: { supported: false, webSearch: false, contextFetching: false },
			},
			caching: { supported: false, types: [] },
			thinking: false,
			multiTurn: false,
		};
	}

	getModelList(): AxAIModelList<ModelTier> {
		return [
			{ key: "haiku", description: "Fast, cheap model for simple tasks", model: MODEL_NAMES.haiku },
			{ key: "sonnet", description: "Balanced model for most tasks", model: MODEL_NAMES.sonnet },
			{ key: "opus", description: "Most capable model for complex tasks", model: MODEL_NAMES.opus },
		];
	}

	getMetrics(): AxAIServiceMetrics {
		return this.metrics;
	}

	getLogger(): AxLoggerFunction {
		return (data) => {
			logger.debug(data, "Ax logger");
		};
	}

	getLastUsedChatModel(): string | undefined {
		return this.lastModel;
	}

	getLastUsedEmbedModel(): string | undefined {
		return undefined; // We don't support embeddings
	}

	getLastUsedModelConfig(): AxModelConfig | undefined {
		// AxModelConfig contains generation parameters, not model name
		// Return undefined as we don't track per-call config changes
		return undefined;
	}

	setOptions(options: Readonly<AxAIServiceOptions>): void {
		this.options = { ...options };
	}

	getOptions(): Readonly<AxAIServiceOptions> {
		return this.options;
	}

	/**
	 * Main chat completion method
	 *
	 * Converts Ax's chat request to Agent SDK query format,
	 * executes with maxTurns: 1, and converts response back.
	 */
	async chat(
		req: Readonly<AxChatRequest<string | ModelTier>>,
		_options?: Readonly<AxAIServiceOptions>,
	): Promise<AxChatResponse> {
		const startTime = Date.now();
		const model = resolveModel(req.model);
		this.lastModel = model;

		// Convert chat prompt to string
		const prompt = chatPromptToString(req.chatPrompt);

		logger.debug({ model, promptLength: prompt.length }, "Ax chat request via Agent SDK");

		try {
			let result = "";

			// Use Agent SDK query with single turn (no tool use)
			for await (const message of query({
				prompt,
				options: {
					model,
					maxTurns: 1,
					permissionMode: "bypassPermissions",
				},
			})) {
				if (message.type === "result" && message.subtype === "success") {
					result = message.result;
				}
			}

			// Record latency
			const latency = Date.now() - startTime;
			this.metrics.latency.chat.samples.push(latency);
			if (this.metrics.latency.chat.samples.length > 100) {
				this.metrics.latency.chat.samples.shift();
			}
			this.metrics.latency.chat.mean =
				this.metrics.latency.chat.samples.reduce((a, b) => a + b, 0) / this.metrics.latency.chat.samples.length;

			logger.debug({ model, latency, resultLength: result.length }, "Ax chat response via Agent SDK");

			// Convert to Ax response format
			return {
				results: [
					{
						index: 0,
						content: result,
						finishReason: "stop",
					},
				],
			};
		} catch (error) {
			// Record error
			this.metrics.errors.chat.count++;
			this.metrics.errors.chat.total++;

			logger.warn({ model, error: String(error) }, "Ax chat request failed");

			throw error;
		}
	}

	/**
	 * Embedding is not supported via Agent SDK
	 */
	async embed(_req: Readonly<AxEmbedRequest<string | ModelTier>>): Promise<AxEmbedResponse> {
		throw new Error("Embeddings not supported via Agent SDK adapter. Use direct Anthropic API for embeddings.");
	}
}

/**
 * Singleton instance for reuse
 */
let instance: AxAgentSDK | null = null;

/**
 * Get the AxAgentSDK instance (singleton)
 */
export function getAxAgentSDK(): AxAgentSDK {
	if (!instance) {
		instance = new AxAgentSDK();
	}
	return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetAxAgentSDK(): void {
	instance = null;
}
