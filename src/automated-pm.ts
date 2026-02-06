/**
 * Automated Product Manager
 *
 * Handles judgment calls that would otherwise require human attention.
 * Uses Ax/DSPy for self-improving decisions based on past outcomes.
 * Only escalates truly ambiguous or high-stakes decisions to human.
 *
 * Designed for sustained autonomous operation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDecisionAx } from "./ax-programs.js";
import { MAX_TURNS_EXTENDED_PLANNING, MAX_TURNS_PLANNING, MAX_TURNS_SINGLE } from "./constants.js";
import { sanitizeContent, wrapUntrustedContent } from "./content-sanitizer.js";
import {
	type ConfidenceLevel,
	type DecisionPoint,
	findSimilarDecisions,
	loadDecisionStore,
	recordResearchConclusion,
	resolveDecision,
} from "./decision-tracker.js";
import { analyzeEffectiveness, type EffectivenessReport } from "./effectiveness-analysis.js";
import { getLastGrindSummary } from "./grind-events.js";
import { findRelevantLearnings } from "./knowledge.js";
import { sessionLogger } from "./logger.js";
import { constrainResearchResult, PMResearchResultSchema, TaskProposalSchema } from "./pm-schemas.js";
import { getRAGEngine } from "./rag/index.js";
import { assessResearchROI, createResearchConclusion, gatherResearchROIContext } from "./research-roi.js";
import { findRelevantFiles, getTaskFileStats } from "./task-file-patterns.js";
import { getTaskType } from "./task-schema.js";
import { filterSafeProposals } from "./task-security.js";
import type { ResearchConclusion } from "./types.js";
import { extractAndValidateURLs, logURLsForAudit } from "./url-validator.js";

// =============================================================================
// Project Context and Quality Filters
// =============================================================================

/**
 * Detect project tech stack from actual project files.
 * Returns a context string describing what the project IS and IS NOT.
 */
function detectProjectContext(cwd: string = process.cwd()): string {
	const parts: string[] = ["PROJECT TECH STACK (auto-detected):"];
	const antiParts: string[] = ["THIS PROJECT DOES NOT USE:"];

	// Check package.json for dependencies
	const pkgPath = join(cwd, "package.json");
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
	if (existsSync(pkgPath)) {
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		} catch {
			// Ignore parse errors
		}
	}

	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
	const depNames = Object.keys(allDeps);

	// Detect runtime
	if (existsSync(join(cwd, "tsconfig.json"))) {
		parts.push("- TypeScript");
	} else if (depNames.some((d) => d.includes("typescript"))) {
		parts.push("- TypeScript");
	}

	if (existsSync(join(cwd, "package.json"))) {
		parts.push("- Node.js");
	}

	// Detect package manager
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
		parts.push("- pnpm");
	} else if (existsSync(join(cwd, "yarn.lock"))) {
		parts.push("- yarn");
	} else if (existsSync(join(cwd, "package-lock.json"))) {
		parts.push("- npm");
	}

	// Detect test framework
	if (depNames.includes("vitest")) {
		parts.push("- vitest for testing");
	} else if (depNames.includes("jest")) {
		parts.push("- jest for testing");
	} else if (depNames.includes("mocha")) {
		parts.push("- mocha for testing");
	}

	// Detect frontend framework (or lack thereof)
	const hasFrontend =
		depNames.includes("react") ||
		depNames.includes("vue") ||
		depNames.includes("angular") ||
		depNames.includes("svelte") ||
		depNames.includes("next") ||
		depNames.includes("nuxt");

	if (hasFrontend) {
		if (depNames.includes("react")) parts.push("- React");
		if (depNames.includes("vue")) parts.push("- Vue");
		if (depNames.includes("next")) parts.push("- Next.js");
	} else {
		antiParts.push("- Frontend frameworks (React, Vue, Angular)");
	}

	// Detect database
	const hasPostgres = depNames.includes("pg") || depNames.includes("postgres");
	const hasMongo = depNames.includes("mongodb") || depNames.includes("mongoose");
	const hasSqlite = depNames.includes("better-sqlite3") || depNames.includes("sqlite3");

	if (hasPostgres) parts.push("- PostgreSQL");
	if (hasMongo) parts.push("- MongoDB");
	if (hasSqlite) parts.push("- SQLite");

	if (!hasPostgres && !hasMongo) {
		if (hasSqlite) {
			antiParts.push("- PostgreSQL, MongoDB (uses SQLite only)");
		}
	}

	// Detect cloud/infra (or lack thereof)
	const hasK8s = depNames.some((d) => d.includes("kubernetes"));
	const hasAWS = depNames.some((d) => d.includes("aws-sdk") || d.includes("@aws-"));
	const hasTerraform = existsSync(join(cwd, "terraform")) || existsSync(join(cwd, "main.tf"));

	if (!hasK8s && !hasAWS && !hasTerraform) {
		antiParts.push("- Cloud infrastructure (Kubernetes, AWS, Terraform)");
	}

	// Check for CLI indicators
	const isCLI =
		depNames.includes("commander") ||
		depNames.includes("yargs") ||
		depNames.includes("meow") ||
		existsSync(join(cwd, "bin"));

	if (isCLI && !hasFrontend) {
		parts.push("- CLI application (command-line tool)");
	}

	// Build final context
	if (parts.length <= 1) {
		return ""; // No meaningful context detected
	}

	const result = [parts.join("\n")];
	if (antiParts.length > 1) {
		result.push(antiParts.join("\n"));
	}

	return result.join("\n\n");
}

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
	/** Semantically similar content from RAG index */
	ragResults: Array<{
		content: string;
		source: string;
		score: number;
	}>;
}

// =============================================================================
// Type Guards for Runtime Validation
// =============================================================================

/**
 * Type guard: Check if value is a valid DecisionPoint
 *
 * @param value - Value to check
 * @returns True if value is a valid DecisionPoint
 */
function isDecisionPoint(value: unknown): value is DecisionPoint {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
		return false;
	}

	if (typeof obj.taskId !== "string" || obj.taskId.trim().length === 0) {
		return false;
	}

	if (typeof obj.question !== "string" || obj.question.trim().length === 0) {
		return false;
	}

	if (typeof obj.context !== "string") {
		return false;
	}

	if (typeof obj.category !== "string") {
		return false;
	}

	if (!Array.isArray(obj.keywords)) {
		return false;
	}

	if (!obj.keywords.every((kw) => typeof kw === "string")) {
		return false;
	}

	if (typeof obj.capturedAt !== "string") {
		return false;
	}

	// Optional fields
	if (obj.options !== undefined) {
		if (!Array.isArray(obj.options)) {
			return false;
		}
		if (!obj.options.every((opt) => typeof opt === "string")) {
			return false;
		}
	}

	return true;
}

/**
 * Type guard: Check if value is a valid PMDecisionResult
 *
 * @param value - Value to check
 * @returns True if value is a valid PMDecisionResult
 */
export function isPMDecisionResult(value: unknown): value is PMDecisionResult {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (typeof obj.decision !== "string") {
		return false;
	}

	if (typeof obj.reasoning !== "string") {
		return false;
	}

	const validConfidence = ["high", "medium", "low"];
	if (typeof obj.confidence !== "string" || !validConfidence.includes(obj.confidence)) {
		return false;
	}

	if (typeof obj.escalateToHuman !== "boolean") {
		return false;
	}

	if (typeof obj.tokensUsed !== "number" || obj.tokensUsed < 0) {
		return false;
	}

	return true;
}

/**
 * Type guard: Check if value is a valid TaskProposal
 *
 * @param value - Value to check
 * @returns True if value is a valid TaskProposal
 */
export function isTaskProposal(value: unknown): value is TaskProposal {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (typeof obj.objective !== "string" || obj.objective.trim().length === 0) {
		return false;
	}

	if (typeof obj.rationale !== "string") {
		return false;
	}

	if (typeof obj.suggestedPriority !== "number" || obj.suggestedPriority < 1 || obj.suggestedPriority > 1000) {
		return false;
	}

	const validSources = ["research", "pattern_analysis", "codebase_gap", "user_request"];
	if (typeof obj.source !== "string" || !validSources.includes(obj.source)) {
		return false;
	}

	// Optional fields
	if (obj.researchFindings !== undefined) {
		if (!Array.isArray(obj.researchFindings)) {
			return false;
		}
		if (!obj.researchFindings.every((f) => typeof f === "string")) {
			return false;
		}
	}

	if (obj.tags !== undefined) {
		if (!Array.isArray(obj.tags)) {
			return false;
		}
		if (!obj.tags.every((t) => typeof t === "string")) {
			return false;
		}
	}

	return true;
}

/**
 * Type guard: Check if value is a valid PMResearchResult
 *
 * @param value - Value to check
 * @returns True if value is a valid PMResearchResult
 */
export function isPMResearchResult(value: unknown): value is PMResearchResult {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (typeof obj.topic !== "string" || obj.topic.trim().length === 0) {
		return false;
	}

	if (!Array.isArray(obj.findings)) {
		return false;
	}

	if (!obj.findings.every((f) => typeof f === "string")) {
		return false;
	}

	if (!Array.isArray(obj.recommendations)) {
		return false;
	}

	if (!obj.recommendations.every((r) => typeof r === "string")) {
		return false;
	}

	if (!Array.isArray(obj.sources)) {
		return false;
	}

	if (!obj.sources.every((s) => typeof s === "string")) {
		return false;
	}

	if (!Array.isArray(obj.taskProposals)) {
		return false;
	}

	if (!obj.taskProposals.every((p) => isTaskProposal(p))) {
		return false;
	}

	return true;
}

/**
 * Type guard: Check if value is a valid IdeationResult
 *
 * @param value - Value to check
 * @returns True if value is a valid IdeationResult
 */
export function isIdeationResult(value: unknown): value is IdeationResult {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (!isPMResearchResult(obj.research)) {
		return false;
	}

	if (!Array.isArray(obj.proposals)) {
		return false;
	}

	if (!obj.proposals.every((p) => isTaskProposal(p))) {
		return false;
	}

	// Optional field: researchConclusion
	if (obj.researchConclusion !== undefined) {
		if (typeof obj.researchConclusion !== "object" || obj.researchConclusion === null) {
			return false;
		}

		const rc = obj.researchConclusion as Record<string, unknown>;
		const validOutcomes = ["implement", "no_go", "insufficient", "absorbed"];
		if (typeof rc.outcome !== "string" || !validOutcomes.includes(rc.outcome)) {
			return false;
		}

		if (typeof rc.rationale !== "string") {
			return false;
		}

		if (typeof rc.noveltyScore !== "number" || rc.noveltyScore < 0 || rc.noveltyScore > 1) {
			return false;
		}

		if (typeof rc.proposalsGenerated !== "number" || rc.proposalsGenerated < 0) {
			return false;
		}

		if (typeof rc.concludedAt !== "string") {
			return false;
		}

		// Optional nested fields
		if (rc.linkedDecisionId !== undefined && typeof rc.linkedDecisionId !== "string") {
			return false;
		}

		if (rc.linkedTaskIds !== undefined) {
			if (!Array.isArray(rc.linkedTaskIds)) {
				return false;
			}
			if (!rc.linkedTaskIds.every((id) => typeof id === "string")) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Type guard: Check if value is a valid RefineTaskResult
 *
 * @param value - Value to check
 * @returns True if value is a valid RefineTaskResult
 */
export function isRefineTaskResult(value: unknown): value is RefineTaskResult {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Required fields
	if (typeof obj.ticket !== "object" || obj.ticket === null) {
		return false;
	}

	if (typeof obj.success !== "boolean") {
		return false;
	}

	if (typeof obj.tokensUsed !== "number" || obj.tokensUsed < 0) {
		return false;
	}

	return true;
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
		ragResults: [],
	};

	// Validate decision point with type guard
	if (!isDecisionPoint(decision)) {
		return context;
	}

	// Find similar past decisions
	try {
		const similar = findSimilarDecisions(decision.keywords, 5, stateDir);
		// Defensive: filter for valid similar decisions with outcomes
		if (Array.isArray(similar)) {
			context.similarDecisions = similar
				.filter((d) => d?.resolution?.outcome && typeof d.question === "string")
				.map((d) => ({
					question: d.question,
					decision: d.resolution.decision || "unknown",
					outcome: d.resolution.outcome || "unknown",
				}));
		}
	} catch {
		// Continue without similar decisions
	}

	// Search knowledge base
	try {
		const knowledge = findRelevantLearnings(decision.question, 5, stateDir);
		// Defensive: filter for valid learning objects
		if (Array.isArray(knowledge)) {
			context.relevantKnowledge = knowledge
				.filter((learning) => learning && typeof learning.content === "string")
				.map((learning) => learning.content);
		}
	} catch {
		// Continue without knowledge
	}

	// Find relevant files
	try {
		const files = findRelevantFiles(decision.question, 3, stateDir);
		// Defensive: filter for valid file objects
		if (Array.isArray(files)) {
			context.relevantFiles = files.filter((f) => f && typeof f.file === "string").map((f) => f.file);
		}
	} catch {
		// Continue without files
	}

	// Get project patterns (from task-file stats)
	try {
		const stats = getTaskFileStats(stateDir);
		// Defensive: validate stats object and riskyKeywords array
		if (stats && Array.isArray(stats.riskyKeywords) && stats.riskyKeywords.length > 0) {
			const riskyKeywordStrs = stats.riskyKeywords
				.filter((k) => k && typeof k.keyword === "string")
				.map((k) => k.keyword);
			if (riskyKeywordStrs.length > 0) {
				context.projectPatterns.push(`Risky keywords to watch: ${riskyKeywordStrs.join(", ")}`);
			}
		}
	} catch {
		// Continue without patterns
	}

	// Search RAG index for semantically similar content
	try {
		const ragEngine = getRAGEngine(stateDir);
		const searchResults = await ragEngine.search(decision.question, {
			limit: 5,
			sources: ["learnings", "decisions"], // Focus on learnings and decisions
		});
		if (Array.isArray(searchResults)) {
			context.ragResults = searchResults
				.filter((r) => r?.chunk && typeof r.chunk.content === "string" && r.score > 0.3)
				.map((r) => ({
					content: r.chunk.content,
					source: r.document?.source || "unknown",
					score: r.score,
				}));
		}
		if (context.ragResults.length > 0) {
			sessionLogger.debug(
				{ decisionId: decision.id, ragResultCount: context.ragResults.length },
				"RAG search found relevant context",
			);
		}
	} catch {
		// Continue without RAG results - it's optional
	}

	return context;
}

/**
 * Have the automated PM make a decision
 *
 * @param decision - The decision point to evaluate
 * @param stateDir - State directory (default: ".undercity")
 * @returns Promise resolving to PM decision result
 * @throws {TypeError} If decision is not a valid DecisionPoint
 */
export async function pmDecide(decision: DecisionPoint, stateDir: string = ".undercity"): Promise<PMDecisionResult> {
	// Validate input parameters
	if (!isDecisionPoint(decision)) {
		throw new TypeError("pmDecide: decision parameter must be a valid DecisionPoint object");
	}

	if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
		throw new TypeError("pmDecide: stateDir parameter must be a non-empty string");
	}

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

		// Combine knowledge base and RAG results for enhanced context
		const knowledgeParts = [...context.relevantKnowledge];
		if (context.ragResults.length > 0) {
			const ragContextStr = context.ragResults.map((r) => `[${r.source}] ${r.content}`).join("\n");
			knowledgeParts.push(`\n--- Semantically Related ---\n${ragContextStr}`);
		}
		const relevantKnowledgeStr = knowledgeParts.join("\n");

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
			await resolveDecision(
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
 *
 * @param question - The decision question
 * @param context - Context for the decision
 * @param taskId - Task ID this decision belongs to
 * @param stateDir - State directory (default: ".undercity")
 * @returns Promise resolving to decision string or null if escalation needed
 * @throws {TypeError} If parameters are invalid
 */
export async function quickDecision(
	question: string,
	context: string,
	taskId: string,
	stateDir: string = ".undercity",
): Promise<string | null> {
	// Validate input parameters
	if (typeof question !== "string" || question.trim().length === 0) {
		throw new TypeError("quickDecision: question parameter must be a non-empty string");
	}

	if (typeof context !== "string") {
		throw new TypeError("quickDecision: context parameter must be a string");
	}

	if (typeof taskId !== "string" || taskId.trim().length === 0) {
		throw new TypeError("quickDecision: taskId parameter must be a non-empty string");
	}

	if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
		throw new TypeError("quickDecision: stateDir parameter must be a non-empty string");
	}

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

// =============================================================================
// Proactive PM: Task Generation and Research
// =============================================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import { toJSONSchema, z } from "zod";
import {
	extractStructuredOutput,
	PMRefineOutputJSONSchema,
	PMRefineOutputSchema,
} from "./structured-output-schemas.js";
import { getAllTasks } from "./task.js";
import { MODEL_NAMES } from "./types.js";

// JSON Schema conversions for existing pm-schemas Zod schemas (used as outputFormat)
const PMResearchResultJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(PMResearchResultSchema) as Record<string, unknown>,
};
const TaskProposalsJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(z.array(TaskProposalSchema)) as Record<string, unknown>,
};

/**
 * Ambition level for task proposals.
 * Determines how strictly file/function specificity is enforced.
 */
export type AmbitionLevel = "incremental" | "moderate" | "ambitious";

/**
 * A task proposal generated by the PM
 */
export interface TaskProposal {
	/** Proposed task objective */
	objective: string;
	/** Rationale for why this task matters */
	rationale: string;
	/** Priority suggestion (1-1000) */
	suggestedPriority: number;
	/** Source of the idea (research, pattern analysis, etc.) */
	source: "research" | "pattern_analysis" | "codebase_gap" | "user_request";
	/** Related research findings if any */
	researchFindings?: string[];
	/** Tags for categorization */
	tags?: string[];
	/** Ambition level - affects how strictly specificity is enforced */
	ambitionLevel?: AmbitionLevel;
}

/**
 * Convert a TaskProposal to AddTaskOptions, preserving rich context as ticket content.
 * This prevents context loss when proposals are added to the task board.
 */
export function proposalToTaskOptions(proposal: TaskProposal): import("./task.js").AddTaskOptions {
	// Map proposal source to ticket source type
	const sourceMap: Record<TaskProposal["source"], import("./types.js").TicketContent["source"]> = {
		research: "research",
		pattern_analysis: "pattern_analysis",
		codebase_gap: "codebase_gap",
		user_request: "user",
	};

	return {
		priority: proposal.suggestedPriority,
		tags: proposal.tags,
		ticket: {
			source: sourceMap[proposal.source],
			rationale: proposal.rationale,
			researchFindings: proposal.researchFindings,
		},
	};
}

/**
 * Result of PM research session
 */
export interface PMResearchResult {
	/** Topic researched */
	topic: string;
	/** Key findings */
	findings: string[];
	/** Recommended actions */
	recommendations: string[];
	/** Sources consulted */
	sources: string[];
	/** Task proposals derived from research */
	taskProposals: TaskProposal[];
}

/**
 * Research a topic via web search and return structured findings
 *
 * Uses the Agent SDK with web tools to gather external information
 * about best practices, trends, or solutions for a given topic.
 *
 * @param topic - Topic to research
 * @param cwd - Current working directory
 * @param _stateDir - State directory (unused, for consistency)
 * @returns Promise resolving to research result
 * @throws {TypeError} If parameters are invalid
 */
export async function pmResearch(
	topic: string,
	cwd: string,
	_stateDir: string = ".undercity",
): Promise<PMResearchResult> {
	// Validate input parameters
	if (typeof topic !== "string" || topic.trim().length === 0) {
		throw new TypeError("pmResearch: topic parameter must be a non-empty string");
	}

	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		throw new TypeError("pmResearch: cwd parameter must be a non-empty string");
	}

	sessionLogger.info({ topic }, "PM starting research session");

	// Get project context for relevance filtering
	const projectContext = detectProjectContext(cwd);
	const contextSection = projectContext
		? `\n${projectContext}\n\nONLY propose changes relevant to this project's actual tech stack.\n`
		: "";

	const prompt = `You are a product manager researching a technical topic.

TOPIC: ${topic}
${contextSection}
YOUR TASK:
1. Search the web for current best practices, recent developments, and expert opinions
2. Find 2-3 authoritative sources
3. Summarize key findings relevant to THIS project (see tech stack above)
4. Recommend specific actions or improvements

=== ANTI-PATTERNS (will be filtered out) ===

WRONG (too vague):
- "Improve error handling across the codebase"
- "Refactor for better DRY"

WRONG (overly broad):
- "Audit all TypeScript files"
- "Comprehensive security review"

GOOD (specific, actionable):
- "Add retry logic to src/api/client.ts fetchData() function"
- "Fix TypeScript error TS2345 in src/worker.ts line 234"

Output your research in this exact JSON format:

\`\`\`json
{
  "topic": "${topic}",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["specific action 1", "specific action 2", ...],
  "sources": ["source URL or description 1", ...],
  "taskProposals": [
    {
      "objective": "Verb + specific file + specific change",
      "rationale": "why this matters",
      "suggestedPriority": 800,
      "source": "research",
      "tags": ["relevant", "tags"]
    }
  ]
}
\`\`\`

Be specific and actionable. Focus on practical improvements, not theoretical ideals.`;

	try {
		let resultJson = "";
		let structuredOutput: unknown = null;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: MAX_TURNS_PLANNING,
				cwd,
				outputFormat: PMResearchResultJSONSchema,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultJson = message.result;
				structuredOutput = (message as Record<string, unknown>).structured_output;
			}
		}

		// Try structured output first, then fall back to regex
		let rawResult: Partial<PMResearchResult>;
		const validated = extractStructuredOutput(structuredOutput, PMResearchResultSchema);
		if (validated) {
			rawResult = validated;
		} else {
			const jsonMatch = resultJson.match(/```json\s*([\s\S]*?)\s*```/);
			if (jsonMatch) {
				rawResult = JSON.parse(jsonMatch[1]) as Partial<PMResearchResult>;
			} else {
				rawResult = JSON.parse(resultJson) as Partial<PMResearchResult>;
			}
		}

		// Security Layer 1: Constrain and validate the raw result
		const constrainedResult = constrainResearchResult(rawResult);

		// Security Layer 2: Sanitize all text content for injection patterns
		const sanitizedFindings = constrainedResult.findings
			.map((f) => sanitizeContent(f, "pm-research"))
			.filter((r) => !r.blocked)
			.map((r) => r.content);

		const sanitizedRecommendations = constrainedResult.recommendations
			.map((r) => sanitizeContent(r, "pm-research"))
			.filter((r) => !r.blocked)
			.map((r) => r.content);

		// Security Layer 3: Validate and log URLs for audit trail
		const urlValidations = extractAndValidateURLs(constrainedResult.sources.join(" "), "documentation");
		logURLsForAudit(
			urlValidations.map((v) => v.url),
			"pm-research",
			"processing",
		);
		const safeUrls = urlValidations.filter((v) => v.result.isSafe).map((v) => v.url);

		// Security Layer 4: Filter task proposals for security
		const safeProposals = filterSafeProposals(constrainedResult.taskProposals);

		const result: PMResearchResult = {
			topic: constrainedResult.topic,
			findings: sanitizedFindings,
			recommendations: sanitizedRecommendations,
			sources: safeUrls,
			taskProposals: safeProposals,
		};

		sessionLogger.info(
			{
				topic,
				findingsCount: result.findings.length,
				proposalsCount: result.taskProposals.length,
				urlsFiltered: urlValidations.length - safeUrls.length,
				proposalsFiltered: constrainedResult.taskProposals.length - safeProposals.length,
			},
			"PM research complete (sanitized)",
		);

		return result;
	} catch (error) {
		sessionLogger.error({ error: String(error), topic }, "PM research failed");
		return {
			topic,
			findings: [],
			recommendations: [],
			sources: [],
			taskProposals: [],
		};
	}
}

/**
 * Patterns that indicate overly broad scope.
 * Tasks matching these patterns lack specific targets and will fail.
 */
const OVERLY_BROAD_PATTERNS: RegExp[] = [
	/\b(?:entire|whole|all|every)\s+(?:codebase|project|repo(?:sitory)?)\b/i,
	/\bcomprehensive(?:ly)?\b/i,
	/\bsystematic(?:ally)?\b/i,
	/\bholistic(?:ally)?\b/i,
	/\brefactor\s+(?:for\s+)?(?:DRY|consistency|readability|maintainability)\b/i,
	/\bmigrate\s+(?:the\s+)?(?:codebase|project)\s+(?:to|from)\b/i,
	/\baudit\s+(?:all|the|every)\b/i,
	/\bstandardize\s+(?:all|every|the)\b/i,
	/\breview\s+(?:all|every|the\s+entire)\b/i,
	/\bcodebase[\s-]?wide\b/i,
];

/**
 * Check if a task description is actionable (not vague)
 *
 * Vague tasks waste tokens and have low success rates.
 * Actionable tasks should have:
 * - Specific file paths or clear targets (for incremental/moderate tasks)
 * - Concrete actions (not just "explore", "research", "improve")
 * - Measurable deliverables
 *
 * AMBITION LEVELS:
 * - "incremental": Requires specific file paths and function names
 * - "moderate": Requires module/directory targets (less specific)
 * - "ambitious": Requires clear direction but allows cross-cutting scope
 *
 * @param objective - Task objective string
 * @param ambitionLevel - How strictly to enforce specificity (default: "incremental")
 */
function isTaskActionable(objective: string, ambitionLevel: AmbitionLevel = "incremental"): boolean {
	const _lower = objective.toLowerCase();

	// Reject purely research/exploration tasks with no code output
	// (applies to all ambition levels)
	const vaguePatterns = [
		/^explore\s/i,
		/^research\s/i,
		/^investigate\s/i,
		/^analyze\s(?!and\s+(fix|update|add|create|implement))/i, // "analyze and fix" is OK
		/^understand\s/i,
		/^study\s/i,
		/^review\s(?!and\s+(fix|update|add|create|implement))/i, // "review and fix" is OK
		/^look\s+into/i,
		/^evaluate\s/i,
		/^assess\s/i,
	];

	for (const pattern of vaguePatterns) {
		if (pattern.test(objective)) {
			sessionLogger.debug({ objective, pattern: pattern.toString(), ambitionLevel }, "Rejected vague task");
			return false;
		}
	}

	// For ambitious tasks, we skip the overly broad and concrete target checks
	// but still require some direction indicators
	if (ambitionLevel === "ambitious") {
		// Ambitious tasks should have clear architectural direction
		const hasDirectionIndicator =
			// Action verbs that indicate clear intent
			/^(refactor|implement|create|add|build|design|restructure|optimize|migrate|integrate|enable|introduce)\s/i.test(
				objective,
			) ||
			// Architectural concepts
			/(architecture|system|module|component|layer|service|pattern|framework|pipeline|workflow)/i.test(objective) ||
			// Clear outcome description
			/(to enable|to support|to improve|to reduce|to increase|for better|for faster)/i.test(objective);

		if (!hasDirectionIndicator) {
			sessionLogger.debug({ objective, ambitionLevel }, "Rejected ambitious task without clear direction");
			return false;
		}

		// Ambitious tasks pass if they have direction (will be decomposed before execution)
		sessionLogger.debug({ objective, ambitionLevel }, "Accepted ambitious task with clear direction");
		return true;
	}

	// For incremental/moderate tasks, reject overly broad scope
	for (const pattern of OVERLY_BROAD_PATTERNS) {
		if (pattern.test(objective)) {
			sessionLogger.debug(
				{ objective, pattern: pattern.toString(), ambitionLevel },
				"Rejected task with overly broad scope",
			);
			return false;
		}
	}

	// For moderate tasks, allow module-level targets
	if (ambitionLevel === "moderate") {
		const hasModuleTarget =
			// Directory/module references
			/\b(src|lib|utils|services|api|components|commands|worker|orchestrator)\b/i.test(objective) ||
			// File type patterns
			/\.(ts|js|tsx|jsx|json|md)(\s|$|,)/i.test(objective) ||
			// Module names
			/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/.test(objective) ||
			// Feature areas
			/(verification|knowledge|learning|planning|review|merge|task|pm|grind)/i.test(objective);

		if (!hasModuleTarget) {
			sessionLogger.debug({ objective, ambitionLevel }, "Rejected moderate task without module target");
			return false;
		}

		// Cross-check with execution-time classification
		const taskType = getTaskType(objective);
		if (taskType === "research") {
			sessionLogger.debug({ objective, ambitionLevel }, "Rejected task that would execute as research");
			return false;
		}

		return true;
	}

	// For incremental tasks (default), require specific file/function targets
	const hasConcreteTarget =
		// File paths
		/\.(ts|js|tsx|jsx|json|md|yaml|yml|toml|css|html)(\s|$|,)/i.test(objective) ||
		// src/ paths
		/src\//i.test(objective) ||
		// Function/method names (camelCase or snake_case followed by parens or as target)
		/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\s*\(/i.test(objective) || // camelCase function
		/[a-z]+_[a-z]+/i.test(objective) || // snake_case
		// Class/component names (PascalCase)
		/\b[A-Z][a-z]+[A-Z][a-z]+\b/.test(objective) ||
		// Specific module/directory names
		/__tests__|__mocks__|components|utils|hooks|services|api|lib/i.test(objective);

	if (!hasConcreteTarget) {
		sessionLogger.debug({ objective, ambitionLevel }, "Rejected task without concrete target");
		return false;
	}

	// Cross-check with execution-time classification.
	const taskType = getTaskType(objective);
	if (taskType === "research") {
		sessionLogger.debug({ objective, ambitionLevel }, "Rejected task that would execute as research");
		return false;
	}

	return true;
}

/**
 * Build system health context for PM self-awareness
 * Allows PM to propose tasks that fix systemic issues
 */
function buildSystemHealthContext(
	grindSummary: ReturnType<typeof getLastGrindSummary>,
	effectivenessReport: EffectivenessReport,
): string {
	const parts: string[] = [];

	// Last grind session stats
	if (grindSummary) {
		const total = grindSummary.ok + grindSummary.fail;
		const successRate = total > 0 ? Math.round((grindSummary.ok / total) * 100) : 0;

		parts.push(`LAST GRIND SESSION:`);
		parts.push(`  Success rate: ${successRate}% (${grindSummary.ok}/${total})`);

		// Failure breakdown - only show categories with failures
		const failureCategories = Object.entries(grindSummary.failureBreakdown)
			.filter(([, count]) => count > 0)
			.sort(([, a], [, b]) => b - a);

		if (failureCategories.length > 0) {
			parts.push(`  Top failure reasons:`);
			for (const [reason, count] of failureCategories.slice(0, 3)) {
				parts.push(`    - ${reason}: ${count}`);
			}
		}

		if (grindSummary.escalations.total > 0) {
			parts.push(
				`  Escalations: ${grindSummary.escalations.total} (${grindSummary.escalations.tasksWithEscalation} tasks)`,
			);
		}
	}

	// Learning system effectiveness
	if (effectivenessReport.totalTasksAnalyzed > 0) {
		const ki = effectivenessReport.knowledgeInjection;

		parts.push(`\nLEARNING SYSTEM HEALTH:`);

		if (ki.tasksWithKnowledge === 0 && ki.tasksWithoutKnowledge > 0) {
			parts.push(`  WARNING: Knowledge injection not working (0/${ki.tasksWithoutKnowledge} tasks used knowledge)`);
		} else if (ki.tasksWithKnowledge > 0) {
			parts.push(`  Knowledge injection: ${ki.tasksWithKnowledge} tasks`);
			parts.push(`  Success rate delta: ${ki.successRateDelta > 0 ? "+" : ""}${Math.round(ki.successRateDelta)}%`);
		}

		const fp = effectivenessReport.filePrediction;
		if (fp.tasksWithPredictions > 0) {
			parts.push(`  File prediction accuracy: ${Math.round(fp.avgPrecision * 100)}% precision`);
		}
	}

	// Include recommendations from effectiveness analysis
	if (effectivenessReport.recommendations.length > 0) {
		const nonGenericRecs = effectivenessReport.recommendations.filter((r) => !r.includes("look healthy"));
		if (nonGenericRecs.length > 0) {
			parts.push(`\nSYSTEM RECOMMENDATIONS:`);
			for (const rec of nonGenericRecs.slice(0, 3)) {
				parts.push(`  - ${rec}`);
			}
		}
	}

	return parts.length > 0 ? parts.join("\n") : "";
}

/**
 * Load the product vision document if available.
 * The vision guides PM task generation toward strategic priorities.
 */
function loadProductVision(stateDir: string): string {
	const visionPath = join(stateDir, "vision.md");
	try {
		if (existsSync(visionPath)) {
			const content = readFileSync(visionPath, "utf-8");
			// Extract key sections for prompt (truncate if too long)
			const maxLength = 2000;
			if (content.length > maxLength) {
				return `${content.substring(0, maxLength)}\n\n[Vision truncated for brevity]`;
			}
			return content;
		}
	} catch {
		// Vision file not available
	}
	return "";
}

/**
 * Analyze codebase and generate task proposals for improvements
 *
 * Uses knowledge base, patterns, and codebase analysis to identify
 * gaps, improvements, or new features that should be considered.
 *
 * AMBITION TIERS: Proposals are now required to span different ambition levels:
 * - 1-2 incremental (single file, focused fix)
 * - 1-2 moderate (2-5 files, feature enhancement)
 * - 1 ambitious (architectural, cross-cutting, or novel capability)
 *
 * @param focus - Optional focus area for proposals
 * @param cwd - Current working directory (default: process.cwd())
 * @param stateDir - State directory (default: ".undercity")
 * @returns Promise resolving to array of task proposals
 * @throws {TypeError} If parameters are invalid
 */
export async function pmPropose(
	focus?: string,
	cwd: string = process.cwd(),
	stateDir: string = ".undercity",
): Promise<TaskProposal[]> {
	// Validate input parameters
	if (focus !== undefined && typeof focus !== "string") {
		throw new TypeError("pmPropose: focus parameter must be a string if provided");
	}

	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		throw new TypeError("pmPropose: cwd parameter must be a non-empty string");
	}

	if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
		throw new TypeError("pmPropose: stateDir parameter must be a non-empty string");
	}

	sessionLogger.info({ focus }, "PM generating task proposals");

	// Load product vision for strategic guidance
	const productVision = loadProductVision(stateDir);
	const visionSection = productVision
		? `\n=== PRODUCT VISION ===\n${productVision}\n\nProposals should align with this vision.\n`
		: "";

	// Gather context
	const knowledge = findRelevantLearnings(focus || "improvement optimization", 10, stateDir);
	const knowledgeContext = knowledge.map((k) => k.content).join("\n");

	const stats = getTaskFileStats(stateDir);
	const riskyAreas = stats.riskyKeywords
		.slice(0, 5)
		.map((k) => k.keyword)
		.join(", ");

	// Get recent completed tasks to understand what's been done
	const allTasks = getAllTasks();
	// Defensive: validate tasks array and filter for valid task objects
	const validTasks = Array.isArray(allTasks)
		? allTasks.filter((t) => t && typeof t.status === "string" && typeof t.objective === "string")
		: [];

	const completedRecently = validTasks
		.filter((t) => t.status === "complete")
		.slice(-20)
		.map((t) => t.objective)
		.join("\n");

	const pendingTasks = validTasks
		.filter((t) => t.status === "pending")
		.map((t) => t.objective)
		.join("\n");

	// Gather system health context for self-aware task generation
	const grindSummary = getLastGrindSummary();
	const effectivenessReport = analyzeEffectiveness(stateDir);
	const systemHealthContext = buildSystemHealthContext(grindSummary, effectivenessReport);

	const focusPrompt = focus ? `\nFOCUS AREA: ${focus}` : "";

	// Get project context for relevance filtering
	const projectContext = detectProjectContext(cwd);
	const projectContextSection = projectContext
		? `\n${projectContext}\n\nONLY propose changes relevant to this project's actual tech stack.\n`
		: "";

	const prompt = `You are a product manager analyzing a codebase for improvement opportunities.${focusPrompt}
${projectContextSection}${visionSection}
CONTEXT FROM KNOWLEDGE BASE:
${knowledgeContext || "No prior learnings available"}

RECENTLY COMPLETED TASKS:
${completedRecently || "No recent completions"}

PENDING TASKS (don't duplicate these):
${pendingTasks || "No pending tasks"}

RISKY AREAS (from patterns):
${riskyAreas || "No risky areas identified"}

${systemHealthContext ? `SYSTEM HEALTH (self-analysis):\n${systemHealthContext}\n` : ""}
YOUR TASK:
1. Identify gaps, technical debt, or missing features
2. Consider what would make this codebase better
3. Propose tasks across DIFFERENT AMBITION LEVELS (see below)
4. Avoid duplicating pending or recently completed tasks
5. If system health shows issues (low success rate, broken learning systems), prioritize fixing those

=== REQUIRED AMBITION DISTRIBUTION ===

You MUST generate proposals across these ambition levels:

**INCREMENTAL (1-2 proposals)**: Single file, focused changes
- Example: "Add try-catch wrapper to fetchUser() in src/api/users.ts"
- Requires: Specific file path + specific function/change

**MODERATE (1-2 proposals)**: Multi-file, feature enhancements
- Example: "Add structured logging to all worker/* modules with task context"
- Requires: Clear module/directory scope + specific improvement

**AMBITIOUS (1 proposal)**: Architectural, cross-cutting improvements
- Example: "Refactor verification to run typecheck, lint, and tests in parallel"
- Requires: Clear direction and expected outcome (will be decomposed before execution)
- May span multiple modules or introduce new architectural patterns

=== ANTI-PATTERNS (will be filtered out) ===

WRONG (research verbs - will execute as research, not code):
- "Read src/foo.ts to understand..." (reading is not a deliverable)
- "Search for patterns in..." (searching is not a deliverable)
- "Document error handling patterns..." (documenting without code changes)

WRONG (too vague - will fail):
- "Explore the test configuration" (no deliverable)
- "Improve error handling" (which errors? which files?)

WRONG (unbounded scope):
- "Audit all TypeScript files for type safety" (never ends)
- "Comprehensive security review" (too broad)

Every task MUST produce a code change (add/modify/delete code or config files).

Output task proposals in this exact JSON format:

\`\`\`json
[
  {
    "objective": "Clear action verb + target + change",
    "rationale": "why this improves the codebase",
    "suggestedPriority": 700,
    "source": "codebase_gap",
    "tags": ["relevant", "tags"],
    "ambitionLevel": "incremental" | "moderate" | "ambitious"
  }
]
\`\`\`

Generate 4-5 proposals with the required ambition distribution.`;

	try {
		let resultJson = "";
		let structuredOutput: unknown = null;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: MAX_TURNS_EXTENDED_PLANNING,
				cwd,
				outputFormat: TaskProposalsJSONSchema,
			},
		})) {
			if (message.type === "result") {
				if (message.subtype === "success") {
					resultJson = message.result;
					structuredOutput = (message as Record<string, unknown>).structured_output;
				} else {
					sessionLogger.error({ subtype: message.subtype }, "PM query returned non-success result");
				}
			}
		}

		// Try structured output first
		const validatedProposals = extractStructuredOutput(structuredOutput, z.array(TaskProposalSchema));

		let proposals: TaskProposal[];
		if (validatedProposals) {
			proposals = validatedProposals;
		} else {
			// Fallback: parse from text
			if (!resultJson || resultJson.trim() === "") {
				sessionLogger.warn("PM proposal returned empty response");
				return [];
			}

			const jsonMatch = resultJson.match(/```json\s*([\s\S]*?)\s*```/);
			try {
				if (jsonMatch) {
					proposals = JSON.parse(jsonMatch[1]) as TaskProposal[];
				} else {
					proposals = JSON.parse(resultJson) as TaskProposal[];
				}
			} catch (parseError) {
				sessionLogger.error(
					{ parseError: String(parseError), responsePreview: resultJson.slice(0, 500) },
					"Failed to parse PM proposal JSON",
				);
				return [];
			}
		}

		// Filter out vague tasks that are likely to fail
		// Use the ambition level from each proposal for appropriate filtering
		const actionableProposals = proposals.filter((p) =>
			isTaskActionable(p.objective, p.ambitionLevel || "incremental"),
		);
		const vagueFilteredCount = proposals.length - actionableProposals.length;

		// Security: Filter out proposals with dangerous objectives
		const safeProposals = filterSafeProposals(actionableProposals);
		const securityFilteredCount = actionableProposals.length - safeProposals.length;

		if (vagueFilteredCount > 0 || securityFilteredCount > 0) {
			sessionLogger.warn(
				{
					total: proposals.length,
					vagueFiltered: vagueFilteredCount,
					securityFiltered: securityFilteredCount,
				},
				`Filtered ${vagueFilteredCount} vague and ${securityFilteredCount} unsafe task(s) from PM proposals`,
			);
		}

		// Log ambition level distribution for analysis
		const ambitionCounts = {
			incremental: safeProposals.filter((p) => p.ambitionLevel === "incremental").length,
			moderate: safeProposals.filter((p) => p.ambitionLevel === "moderate").length,
			ambitious: safeProposals.filter((p) => p.ambitionLevel === "ambitious").length,
			unspecified: safeProposals.filter((p) => !p.ambitionLevel).length,
		};
		sessionLogger.info({ ambitionCounts }, "PM proposal ambition distribution");

		sessionLogger.info({ proposalCount: safeProposals.length }, "PM generated proposals (validated)");
		return safeProposals;
	} catch (error) {
		sessionLogger.error({ error: String(error) }, "PM proposal generation failed");
		return [];
	}
}

/**
 * Result of PM ideation including research conclusion
 */
export interface IdeationResult {
	research: PMResearchResult;
	proposals: TaskProposal[];
	researchConclusion?: ResearchConclusion;
}

/**
 * Run a full PM ideation session: research + propose
 *
 * Combines external research with codebase analysis to generate
 * well-informed task proposals for product improvement.
 *
 * NEW: Checks research ROI before proceeding to prevent infinite research loops.
 * If research is saturated or repetitive, may skip directly to implementation
 * or conclude with a no-go decision.
 *
 * @param topic - Topic to ideate on
 * @param cwd - Current working directory (default: process.cwd())
 * @param stateDir - State directory (default: ".undercity")
 * @param taskId - Optional task ID for tracking
 * @returns Promise resolving to ideation result
 * @throws {TypeError} If parameters are invalid
 */
export async function pmIdeate(
	topic: string,
	cwd: string = process.cwd(),
	stateDir: string = ".undercity",
	taskId?: string,
): Promise<IdeationResult> {
	// Validate input parameters
	if (typeof topic !== "string" || topic.trim().length === 0) {
		throw new TypeError("pmIdeate: topic parameter must be a non-empty string");
	}

	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		throw new TypeError("pmIdeate: cwd parameter must be a non-empty string");
	}

	if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
		throw new TypeError("pmIdeate: stateDir parameter must be a non-empty string");
	}

	if (taskId !== undefined && typeof taskId !== "string") {
		throw new TypeError("pmIdeate: taskId parameter must be a string if provided");
	}

	sessionLogger.info({ topic }, "PM starting ideation session");

	// NEW: Check if we should even do more research
	const roiContext = await gatherResearchROIContext(taskId || `ideate-${Date.now()}`, topic, stateDir);
	const assessment = await assessResearchROI(roiContext, stateDir, cwd);

	// Handle different ROI recommendations
	if (assessment.recommendation === "conclude_no_go") {
		sessionLogger.info({ topic, rationale: assessment.rationale }, "PM concluding no-go based on ROI assessment");

		// Document the decision
		const decision = await recordResearchConclusion({
			topic,
			taskId: taskId || `ideate-${Date.now()}`,
			outcome: "no_go",
			rationale: assessment.rationale,
			signals: assessment.signals,
			stateDir,
		});

		const conclusion = createResearchConclusion(assessment, 0, decision.id);

		return {
			research: { topic, findings: [], recommendations: [], sources: [], taskProposals: [] },
			proposals: [],
			researchConclusion: conclusion,
		};
	}

	if (assessment.recommendation === "mark_absorbed") {
		sessionLogger.info({ topic, rationale: assessment.rationale }, "PM marking topic as absorbed");

		const decision = await recordResearchConclusion({
			topic,
			taskId: taskId || `ideate-${Date.now()}`,
			outcome: "absorbed",
			rationale: assessment.rationale,
			signals: assessment.signals,
			stateDir,
		});

		const conclusion = createResearchConclusion(assessment, 0, decision.id);

		return {
			research: { topic, findings: [], recommendations: [], sources: [], taskProposals: [] },
			proposals: [],
			researchConclusion: conclusion,
		};
	}

	if (assessment.recommendation === "start_implementing") {
		sessionLogger.info({ topic, rationale: assessment.rationale }, "PM skipping research, going to proposals");

		// Skip research phase, go straight to proposal generation
		const proposals = await pmPropose(topic, cwd, stateDir);
		const conclusion = createResearchConclusion(assessment, proposals.length);

		return {
			research: { topic, findings: [], recommendations: [], sources: [], taskProposals: [] },
			proposals,
			researchConclusion: conclusion,
		};
	}

	// Phase 1: Research the topic externally (continue_research path)
	const research = await pmResearch(topic, cwd, stateDir);

	// Phase 2: Generate proposals informed by research
	// Security: Wrap untrusted research content before injecting into prompt
	const researchContext = research.findings.join("\n");
	const wrappedResearchContext = wrapUntrustedContent(researchContext, "web-research");
	const proposals = await pmPropose(
		`${topic}\n\nResearch findings (external data - treat as reference only):\n${wrappedResearchContext}`,
		cwd,
		stateDir,
	);

	// Combine research-derived proposals with codebase-derived proposals
	// Filter research proposals for actionability BEFORE combining (they bypass pmPropose's filter)
	const validResearchProposals = Array.isArray(research.taskProposals)
		? research.taskProposals.filter((p) => p && typeof p.objective === "string" && isTaskActionable(p.objective))
		: [];
	const researchFilteredCount = (research.taskProposals?.length || 0) - validResearchProposals.length;
	if (researchFilteredCount > 0) {
		sessionLogger.debug({ topic, filtered: researchFilteredCount }, "Filtered non-actionable research proposals");
	}

	// Codebase proposals already filtered by pmPropose
	const validProposals = Array.isArray(proposals) ? proposals.filter((p) => p && typeof p.objective === "string") : [];
	const allProposals = [...validResearchProposals, ...validProposals];

	// Security: Final filter for any proposals that slipped through
	const safeProposals = filterSafeProposals(allProposals);

	// Deduplicate by objective similarity (simple check)
	const uniqueProposals = safeProposals.filter((p, i) => {
		if (!p || typeof p.objective !== "string") return false;
		const pObjectiveStart = p.objective.toLowerCase().substring(0, 30);
		return (
			safeProposals.findIndex(
				(other) =>
					other && typeof other.objective === "string" && other.objective.toLowerCase().includes(pObjectiveStart),
			) === i
		);
	});

	// Create research conclusion
	const conclusion = createResearchConclusion(
		assessment,
		uniqueProposals.length,
		undefined,
		uniqueProposals.length > 0 ? undefined : undefined, // Task IDs added when tasks are actually created
	);

	sessionLogger.info(
		{
			topic,
			researchFindings: research.findings.length,
			totalProposals: uniqueProposals.length,
			roiRecommendation: assessment.recommendation,
		},
		"PM ideation complete",
	);

	return { research, proposals: uniqueProposals, researchConclusion: conclusion };
}

/**
 * Result of refining a task with rich ticket content
 */
export interface RefineTaskResult {
	/** Generated ticket content */
	ticket: import("./types.js").TicketContent;
	/** Whether refinement was successful */
	success: boolean;
	/** Tokens used */
	tokensUsed: number;
}

/**
 * Refine a task objective into rich ticket content
 *
 * Takes an existing task objective and generates structured, detailed ticket content
 * to guide autonomous coding agents. This PM capability transforms single-line task
 * descriptions into comprehensive specifications with context-aware guidance.
 *
 * The function gathers context from multiple learning systems:
 * - Knowledge base: Relevant learnings from past tasks
 * - Task-file patterns: Files historically modified for similar tasks
 * - RAG search: Semantically similar past work and decisions
 * - Project statistics: Overall codebase activity metrics
 *
 * Generated ticket content includes:
 * - Expanded description (2-4 sentences of actionable detail)
 * - Acceptance criteria (2-5 specific, testable conditions)
 * - Test plan (concrete verification steps)
 * - Implementation notes (approach hints, patterns, gotchas)
 * - Rationale (business value or technical necessity)
 *
 * @param objective - Task objective to refine (non-empty string). Example: "Add error handling to user service"
 * @param _cwd - Current working directory (unused, included for API consistency with other PM functions)
 * @param stateDir - State directory containing knowledge base and patterns (default: ".undercity")
 * @returns Promise resolving to RefineTaskResult with:
 *   - ticket: TicketContent object containing description, acceptanceCriteria, testPlan, implementationNotes, rationale
 *   - success: boolean indicating whether refinement succeeded
 *   - tokensUsed: number of tokens consumed (currently 0 as not exposed by SDK)
 * @throws {TypeError} If objective or stateDir are not non-empty strings
 *
 * @example
 * ```typescript
 * // Refine a simple task objective into a rich ticket
 * const result = await pmRefineTask(
 *   "Add validation to user registration endpoint",
 *   process.cwd(),
 *   ".undercity"
 * );
 *
 * if (result.success) {
 *   console.log(result.ticket.description);
 *   // "Add comprehensive input validation to the user registration endpoint..."
 *
 *   console.log(result.ticket.acceptanceCriteria);
 *   // ["Email format validation prevents invalid addresses",
 *   //  "Password strength requirements enforced (8+ chars, mixed case)",
 *   //  "Duplicate email detection returns clear error message"]
 * }
 * ```
 */
export async function pmRefineTask(
	objective: string,
	_cwd: string = process.cwd(),
	stateDir: string = ".undercity",
): Promise<RefineTaskResult> {
	// Validate input parameters
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new TypeError("pmRefineTask: objective parameter must be a non-empty string");
	}

	if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
		throw new TypeError("pmRefineTask: stateDir parameter must be a non-empty string");
	}

	const { query } = await import("@anthropic-ai/claude-agent-sdk");

	sessionLogger.info({ objective: objective.substring(0, 50) }, "PM refining task");

	// Gather context for better refinement
	const relevantKnowledge = findRelevantLearnings(objective, 5, stateDir);
	const relevantFiles = findRelevantFiles(objective, 5, stateDir);
	const fileStats = getTaskFileStats(stateDir);

	// Search RAG for semantically similar content
	let ragContext = "";
	try {
		const ragEngine = await getRAGEngine(stateDir);
		const ragResults = await ragEngine.search(objective, { limit: 3 });
		if (ragResults.length > 0) {
			ragContext = ragResults.map((r) => `- ${r.chunk.content.substring(0, 200)}...`).join("\n");
		}
	} catch {
		// RAG not available
	}

	const contextParts: string[] = [];

	if (relevantKnowledge.length > 0) {
		contextParts.push(`## Relevant Learnings\n${relevantKnowledge.map((k) => `- ${k.content}`).join("\n")}`);
	}

	if (relevantFiles.length > 0) {
		contextParts.push(`## Likely Files\n${relevantFiles.slice(0, 5).join("\n")}`);
	}

	if (ragContext) {
		contextParts.push(`## Similar Past Work\n${ragContext}`);
	}

	if (fileStats.totalTasks > 10) {
		contextParts.push(
			`## Project Stats\n${fileStats.totalTasks} tasks completed, ${fileStats.uniqueFiles} unique files modified`,
		);
	}

	const contextSection = contextParts.length > 0 ? `\n\n${contextParts.join("\n\n")}` : "";

	const prompt = `You are a Product Manager refining a task for an autonomous coding agent.

TASK OBJECTIVE:
${objective}
${contextSection}

Generate rich ticket content to help the agent execute this task effectively.

RESPOND WITH VALID JSON ONLY (no markdown, no explanation):
{
  "description": "Expanded explanation of what needs to be done (2-4 sentences)",
  "acceptanceCriteria": ["Specific, testable criterion 1", "Criterion 2", "..."],
  "testPlan": "How to verify the task was completed correctly",
  "implementationNotes": "Hints about approach, patterns to follow, gotchas to avoid",
  "rationale": "Why this task matters and what value it provides"
}

GUIDELINES:
- description: Expand the objective into clear, actionable detail
- acceptanceCriteria: 2-5 specific, measurable conditions for "done"
- testPlan: Concrete verification steps (what to run, what to check)
- implementationNotes: Helpful hints based on codebase patterns
- rationale: The "why" - business value or technical necessity

Be specific to THIS codebase. Avoid generic advice.`;

	const tokensUsed = 0;
	let resultText = "";

	try {
		let structuredOutput: unknown = null;
		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: MAX_TURNS_SINGLE,
				systemPrompt: "You are a precise JSON generator. Output ONLY valid JSON, no markdown formatting.",
				outputFormat: PMRefineOutputJSONSchema,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultText = message.result;
				structuredOutput = (message as Record<string, unknown>).structured_output;
			}
		}

		// Try structured output first
		const validated = extractStructuredOutput(structuredOutput, PMRefineOutputSchema);
		let parsed: {
			description?: string;
			acceptanceCriteria?: string[];
			testPlan?: string;
			implementationNotes?: string;
			rationale?: string;
		};

		if (validated) {
			parsed = validated;
		} else {
			// Fallback: regex extraction from text
			const jsonMatch = resultText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				sessionLogger.warn({ objective }, "PM refine failed to produce valid JSON");
				return { ticket: {}, success: false, tokensUsed };
			}
			parsed = JSON.parse(jsonMatch[0]);
		}

		const ticket: import("./types.js").TicketContent = {
			description: sanitizeContent(parsed.description || "").content,
			acceptanceCriteria: parsed.acceptanceCriteria?.map((c) => sanitizeContent(c).content) || [],
			testPlan: sanitizeContent(parsed.testPlan || "").content,
			implementationNotes: sanitizeContent(parsed.implementationNotes || "").content,
			rationale: sanitizeContent(parsed.rationale || "").content,
			source: "pm",
		};

		sessionLogger.info(
			{
				objective: objective.substring(0, 50),
				hasDescription: !!ticket.description,
				criteriaCount: ticket.acceptanceCriteria?.length || 0,
			},
			"PM task refinement complete",
		);

		return { ticket, success: true, tokensUsed };
	} catch (error) {
		sessionLogger.error({ error: String(error), objective }, "PM refine failed");
		return { ticket: {}, success: false, tokensUsed };
	}
}
