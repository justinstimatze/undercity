/**
 * Automated Product Manager
 *
 * Handles judgment calls that would otherwise require human attention.
 * Uses research, past decisions, and knowledge base to make informed choices.
 * Only escalates truly ambiguous or high-stakes decisions to human.
 *
 * Designed for sustained autonomous operation.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	type ConfidenceLevel,
	type DecisionPoint,
	findSimilarDecisions,
	loadDecisionStore,
	resolveDecision,
} from "./decision-tracker.js";
import { findRelevantLearnings } from "./knowledge.js";
import { sessionLogger } from "./logger.js";
import { findRelevantFiles, getTaskFileStats } from "./task-file-patterns.js";

/**
 * PM decision result
 */
export interface PMDecisionResult {
	/** The decision made */
	decision: string;
	/** Reasoning behind decision */
	reasoning: string;
	/** Confidence level */
	confidence: ConfidenceLevel;
	/** Whether to escalate to human anyway */
	escalateToHuman: boolean;
	/** Tokens used */
	tokensUsed: number;
}

/**
 * Context gathered for PM to make decision
 */
interface PMContext {
	/** Similar past decisions and their outcomes */
	similarDecisions: Array<{
		question: string;
		decision: string;
		outcome: string;
	}>;
	/** Relevant knowledge from knowledge base */
	relevantKnowledge: string[];
	/** File patterns related to this decision */
	relevantFiles: string[];
	/** Project patterns and preferences */
	projectPatterns: string[];
}

/**
 * Gather context for PM decision-making
 */
async function gatherPMContext(decision: DecisionPoint, stateDir: string): Promise<PMContext> {
	const context: PMContext = {
		similarDecisions: [],
		relevantKnowledge: [],
		relevantFiles: [],
		projectPatterns: [],
	};

	// Find similar past decisions
	try {
		const similar = findSimilarDecisions(decision.keywords, 5, stateDir);
		context.similarDecisions = similar
			.filter((d) => d.resolution.outcome)
			.map((d) => ({
				question: d.question,
				decision: d.resolution.decision,
				outcome: d.resolution.outcome || "unknown",
			}));
	} catch {
		// Continue without similar decisions
	}

	// Search knowledge base
	try {
		const knowledge = findRelevantLearnings(decision.question, 5, stateDir);
		context.relevantKnowledge = knowledge.map((learning) => learning.content);
	} catch {
		// Continue without knowledge
	}

	// Find relevant files
	try {
		const files = findRelevantFiles(decision.question, 3, stateDir);
		context.relevantFiles = files.map((f) => f.file);
	} catch {
		// Continue without files
	}

	// Get project patterns (from task-file stats)
	try {
		const stats = getTaskFileStats(stateDir);
		if (stats.riskyKeywords.length > 0) {
			context.projectPatterns.push(`Risky keywords to watch: ${stats.riskyKeywords.map((k) => k.keyword).join(", ")}`);
		}
	} catch {
		// Continue without patterns
	}

	return context;
}

/**
 * Build PM prompt with gathered context
 */
function buildPMPrompt(decision: DecisionPoint, context: PMContext): string {
	const lines: string[] = [];

	lines.push("You are an automated Product Manager making a judgment call for an autonomous coding system.");
	lines.push("Your goal: Make a decision that keeps the system running efficiently without human intervention.");
	lines.push("");
	lines.push("## Decision Needed");
	lines.push(`Question: ${decision.question}`);
	lines.push(`Context: ${decision.context}`);
	if (decision.options && decision.options.length > 0) {
		lines.push(`Options: ${decision.options.join(" OR ")}`);
	}
	lines.push("");

	if (context.similarDecisions.length > 0) {
		lines.push("## Similar Past Decisions");
		for (const d of context.similarDecisions) {
			lines.push(`- "${d.question}" → Decided: "${d.decision}" → Outcome: ${d.outcome}`);
		}
		lines.push("");
	}

	if (context.relevantKnowledge.length > 0) {
		lines.push("## Relevant Knowledge");
		for (const k of context.relevantKnowledge) {
			lines.push(`- ${k}`);
		}
		lines.push("");
	}

	if (context.relevantFiles.length > 0) {
		lines.push("## Files Typically Involved");
		lines.push(context.relevantFiles.join(", "));
		lines.push("");
	}

	if (context.projectPatterns.length > 0) {
		lines.push("## Project Patterns");
		for (const p of context.projectPatterns) {
			lines.push(`- ${p}`);
		}
		lines.push("");
	}

	lines.push("## Decision Guidelines");
	lines.push("- Favor the simpler, less risky approach when outcomes are similar");
	lines.push("- If past similar decisions succeeded, follow that pattern");
	lines.push("- If this could break things badly, recommend escalating to human");
	lines.push("- Be decisive - avoid analysis paralysis");
	lines.push("");
	lines.push("## Response Format");
	lines.push("Respond with JSON only:");
	lines.push("```json");
	lines.push("{");
	lines.push('  "decision": "what to do",');
	lines.push('  "reasoning": "brief explanation",');
	lines.push('  "confidence": "high|medium|low",');
	lines.push('  "escalate": false');
	lines.push("}");
	lines.push("```");
	lines.push("");
	lines.push("Set escalate=true ONLY if:");
	lines.push("- This involves security/auth/payments");
	lines.push("- This could cause data loss");
	lines.push("- You genuinely can't decide (truly 50/50)");
	lines.push("- Breaking backwards compatibility");

	return lines.join("\n");
}

/**
 * Parse PM response
 */
function parsePMResponse(response: string): PMDecisionResult | null {
	try {
		// Extract JSON from response
		const jsonMatch = response.match(/\{[\s\S]*?\}/);
		if (!jsonMatch) {
			return null;
		}

		const parsed = JSON.parse(jsonMatch[0]);

		return {
			decision: parsed.decision || "proceed with default approach",
			reasoning: parsed.reasoning || "no reasoning provided",
			confidence: (parsed.confidence as ConfidenceLevel) || "medium",
			escalateToHuman: parsed.escalate === true,
			tokensUsed: 0, // Will be updated by caller
		};
	} catch {
		return null;
	}
}

/**
 * Have the automated PM make a decision
 */
export async function pmDecide(decision: DecisionPoint, stateDir: string = ".undercity"): Promise<PMDecisionResult> {
	const startTime = Date.now();
	let tokensUsed = 0;

	try {
		// Gather context
		const context = await gatherPMContext(decision, stateDir);

		// Check if we have strong precedent (3+ similar decisions with same outcome)
		const successfulPattern = context.similarDecisions.filter((d) => d.outcome === "success");
		if (successfulPattern.length >= 3) {
			// Strong precedent - decide without LLM
			const patternDecision = successfulPattern[0].decision;
			sessionLogger.info({ decisionId: decision.id, pattern: patternDecision }, "PM decided based on strong precedent");

			return {
				decision: patternDecision,
				reasoning: `Following pattern from ${successfulPattern.length} similar successful decisions`,
				confidence: "high",
				escalateToHuman: false,
				tokensUsed: 0,
			};
		}

		// Need LLM for nuanced decision
		const prompt = buildPMPrompt(decision, context);
		let result = "";

		for await (const message of query({
			prompt,
			options: {
				model: "claude-3-5-haiku-20241022", // Fast and cheap for PM decisions
				allowedTools: [],
			},
		})) {
			if (message.type === "result") {
				const msg = message as Record<string, unknown>;
				if (msg.subtype === "success") {
					result = msg.result as string;
				}
				// Extract token usage from result message
				const usage = msg.usage as { inputTokens?: number; outputTokens?: number } | undefined;
				if (usage) {
					tokensUsed = (usage.inputTokens || 0) + (usage.outputTokens || 0);
				}
			}
		}

		const parsed = parsePMResponse(result);
		if (!parsed) {
			// Couldn't parse - be safe, escalate
			sessionLogger.warn({ decisionId: decision.id }, "PM couldn't parse response, escalating");
			return {
				decision: "unable to decide",
				reasoning: "Failed to parse PM response",
				confidence: "low",
				escalateToHuman: true,
				tokensUsed,
			};
		}

		parsed.tokensUsed = tokensUsed;

		sessionLogger.info(
			{
				decisionId: decision.id,
				decision: parsed.decision,
				confidence: parsed.confidence,
				escalate: parsed.escalateToHuman,
				durationMs: Date.now() - startTime,
			},
			"PM made decision",
		);

		return parsed;
	} catch (error) {
		sessionLogger.error({ error: String(error), decisionId: decision.id }, "PM decision failed");

		// On error, escalate to human
		return {
			decision: "error occurred",
			reasoning: `PM error: ${String(error)}`,
			confidence: "low",
			escalateToHuman: true,
			tokensUsed,
		};
	}
}

/**
 * Process all pending PM-decidable decisions
 * Returns decisions that need human attention
 */
export async function processPendingDecisions(
	stateDir: string = ".undercity",
): Promise<{ processed: number; escalated: DecisionPoint[] }> {
	const store = loadDecisionStore(stateDir);
	const pmDecidable = store.pending.filter((d) => d.category === "pm_decidable");
	const escalated: DecisionPoint[] = [];
	let processed = 0;

	for (const decision of pmDecidable) {
		const result = await pmDecide(decision, stateDir);

		if (result.escalateToHuman) {
			escalated.push(decision);
		} else {
			// Resolve the decision
			resolveDecision(
				decision.id,
				{
					resolvedBy: "pm",
					decision: result.decision,
					reasoning: result.reasoning,
					confidence: result.confidence,
				},
				stateDir,
			);
			processed++;
		}
	}

	sessionLogger.info({ processed, escalated: escalated.length }, "PM processed pending decisions");

	return { processed, escalated };
}

/**
 * Quick decision for inline use during task execution
 * Returns decision string or null if should escalate
 */
export async function quickDecision(
	question: string,
	context: string,
	taskId: string,
	stateDir: string = ".undercity",
): Promise<string | null> {
	// Create temporary decision point
	const decision: DecisionPoint = {
		id: `quick-${Date.now().toString(36)}`,
		taskId,
		question,
		context,
		category: "pm_decidable",
		keywords: question
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 3),
		capturedAt: new Date().toISOString(),
	};

	const result = await pmDecide(decision, stateDir);

	if (result.escalateToHuman) {
		return null; // Caller should handle escalation
	}

	return result.decision;
}
