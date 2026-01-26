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
import { constrainResearchResult } from "./pm-schemas.js";
import { getRAGEngine } from "./rag/index.js";
import { assessResearchROI, createResearchConclusion, gatherResearchROIContext } from "./research-roi.js";
import { findRelevantFiles, getTaskFileStats } from "./task-file-patterns.js";
import { filterSafeProposals } from "./task-security.js";
import type { ResearchConclusion } from "./types.js";
import { extractAndValidateURLs, logURLsForAudit } from "./url-validator.js";

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

	// Defensive: validate decision point
	if (!decision || typeof decision !== "object") {
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

// =============================================================================
// Proactive PM: Task Generation and Research
// =============================================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getAllTasks } from "./task.js";
import { MODEL_NAMES } from "./types.js";

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
 */
export async function pmResearch(
	topic: string,
	cwd: string,
	_stateDir: string = ".undercity",
): Promise<PMResearchResult> {
	sessionLogger.info({ topic }, "PM starting research session");

	const prompt = `You are a product manager researching a technical topic.

TOPIC: ${topic}

YOUR TASK:
1. Search the web for current best practices, recent developments, and expert opinions
2. Find 2-3 authoritative sources
3. Summarize key findings relevant to a software project
4. Recommend specific actions or improvements

Output your research in this exact JSON format:

\`\`\`json
{
  "topic": "${topic}",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["specific action 1", "specific action 2", ...],
  "sources": ["source URL or description 1", ...],
  "taskProposals": [
    {
      "objective": "specific task description",
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

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: 10,
				cwd,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultJson = message.result;
			}
		}

		// Parse JSON response
		const jsonMatch = resultJson.match(/```json\s*([\s\S]*?)\s*```/);
		let rawResult: Partial<PMResearchResult>;
		if (jsonMatch) {
			rawResult = JSON.parse(jsonMatch[1]) as Partial<PMResearchResult>;
		} else {
			// Fallback: try parsing whole response
			rawResult = JSON.parse(resultJson) as Partial<PMResearchResult>;
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
 * Check if a task description is actionable (not vague)
 *
 * Vague tasks waste tokens and have low success rates.
 * Actionable tasks should have:
 * - Specific file paths or clear targets
 * - Concrete actions (not just "explore", "research", "improve")
 * - Measurable deliverables
 */
function isTaskActionable(objective: string): boolean {
	const _lower = objective.toLowerCase();

	// Reject purely research/exploration tasks with no code output
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
			sessionLogger.debug({ objective, pattern: pattern.toString() }, "Rejected vague task");
			return false;
		}
	}

	// Reject tasks without any concrete identifiers (files, functions, modules)
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
		sessionLogger.debug({ objective }, "Rejected task without concrete target");
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
 * Analyze codebase and generate task proposals for improvements
 *
 * Uses knowledge base, patterns, and codebase analysis to identify
 * gaps, improvements, or new features that should be considered.
 */
export async function pmPropose(
	focus?: string,
	cwd: string = process.cwd(),
	stateDir: string = ".undercity",
): Promise<TaskProposal[]> {
	sessionLogger.info({ focus }, "PM generating task proposals");

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

	const prompt = `You are a product manager analyzing a codebase for improvement opportunities.${focusPrompt}

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
3. Propose specific, actionable tasks
4. Avoid duplicating pending or recently completed tasks
5. If system health shows issues (low success rate, broken learning systems), prioritize fixing those

CRITICAL REQUIREMENTS FOR TASK DESCRIPTIONS:
Tasks MUST include concrete deliverables. Vague tasks waste tokens and fail.

BAD (too vague - will fail):
- "Explore the test configuration" (no deliverable)
- "Research best practices for X" (no code output)
- "Improve error handling" (which errors? which files?)

GOOD (specific, actionable):
- "Add try-catch wrapper to fetchUser() in src/api/users.ts with specific error types"
- "Create test file src/__tests__/parser.test.ts covering edge cases: empty input, malformed JSON, missing required fields"
- "Refactor src/utils/date.ts: extract formatRelativeDate() into a separate module to reduce bundle size"

Each task MUST specify:
- Target file path(s)
- Specific function/component/module to modify or create
- Concrete change to make (not just "improve" or "explore")

Output task proposals in this exact JSON format:

\`\`\`json
[
  {
    "objective": "Verb + specific file + specific change (e.g., 'Add retry logic to src/api/client.ts fetchWithRetry() function')",
    "rationale": "why this improves the codebase",
    "suggestedPriority": 700,
    "source": "codebase_gap",
    "tags": ["relevant", "tags"]
  }
]
\`\`\`

Generate 3-5 high-value proposals. Each must be executable by an AI agent without further clarification.`;

	try {
		let resultJson = "";

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: 8,
				cwd,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultJson = message.result;
			}
		}

		// Parse JSON response
		const jsonMatch = resultJson.match(/```json\s*([\s\S]*?)\s*```/);
		let proposals: TaskProposal[];
		if (jsonMatch) {
			proposals = JSON.parse(jsonMatch[1]) as TaskProposal[];
		} else {
			proposals = JSON.parse(resultJson) as TaskProposal[];
		}

		// Filter out vague tasks that are likely to fail
		const actionableProposals = proposals.filter((p) => isTaskActionable(p.objective));
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
 */
export async function pmIdeate(
	topic: string,
	cwd: string = process.cwd(),
	stateDir: string = ".undercity",
	taskId?: string,
): Promise<IdeationResult> {
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
	// Defensive: filter for valid proposal objects before combining
	const validResearchProposals = Array.isArray(research.taskProposals)
		? research.taskProposals.filter((p) => p && typeof p.objective === "string")
		: [];
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
 * Takes an existing task objective and generates:
 * - Expanded description
 * - Acceptance criteria
 * - Test plan
 * - Implementation notes
 * - Rationale
 *
 * Uses codebase context and knowledge base for informed refinement.
 */
export async function pmRefineTask(
	objective: string,
	_cwd: string = process.cwd(),
	stateDir: string = ".undercity",
): Promise<RefineTaskResult> {
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
		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: 1,
				systemPrompt: "You are a precise JSON generator. Output ONLY valid JSON, no markdown formatting.",
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultText = message.result;
			}
		}

		// Parse the JSON response
		const jsonMatch = resultText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			sessionLogger.warn({ objective }, "PM refine failed to produce valid JSON");
			return { ticket: {}, success: false, tokensUsed };
		}

		const parsed = JSON.parse(jsonMatch[0]) as {
			description?: string;
			acceptanceCriteria?: string[];
			testPlan?: string;
			implementationNotes?: string;
			rationale?: string;
		};

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
