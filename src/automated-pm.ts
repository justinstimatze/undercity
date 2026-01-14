/**
 * Automated Product Manager
 *
 * Handles judgment calls that would otherwise require human attention.
 * Uses Ax/DSPy for self-improving decisions based on past outcomes.
 * Only escalates truly ambiguous or high-stakes decisions to human.
 *
 * Designed for sustained autonomous operation.
 */

import { makeDecisionAx } from "./ax-programs.js";
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
 * Have the automated PM make a decision
 */
export async function pmDecide(decision: DecisionPoint, stateDir: string = ".undercity"): Promise<PMDecisionResult> {
	const startTime = Date.now();

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

		// Use Ax/DSPy for self-improving decision making
		const similarDecisionsStr = context.similarDecisions
			.map((d) => `Q: ${d.question}\nDecision: ${d.decision}\nOutcome: ${d.outcome}`)
			.join("\n\n");

		const relevantKnowledgeStr = context.relevantKnowledge.join("\n");

		const axResult = await makeDecisionAx(
			decision.question,
			decision.context,
			decision.options?.join(", ") || "No specific options provided",
			similarDecisionsStr || "No similar past decisions",
			relevantKnowledgeStr || "No relevant knowledge available",
			stateDir,
		);

		const pmResult: PMDecisionResult = {
			decision: axResult.decision,
			reasoning: axResult.reasoning,
			confidence: axResult.confidence,
			escalateToHuman: axResult.escalate,
			tokensUsed: 0, // Ax doesn't expose token usage directly
		};

		sessionLogger.info(
			{
				decisionId: decision.id,
				decision: pmResult.decision,
				confidence: pmResult.confidence,
				escalate: pmResult.escalateToHuman,
				durationMs: Date.now() - startTime,
			},
			"PM made decision via Ax",
		);

		return pmResult;
	} catch (error) {
		sessionLogger.error({ error: String(error), decisionId: decision.id }, "PM decision failed");

		// On error, escalate to human
		return {
			decision: "error occurred",
			reasoning: `PM error: ${String(error)}`,
			confidence: "low",
			escalateToHuman: true,
			tokensUsed: 0,
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
