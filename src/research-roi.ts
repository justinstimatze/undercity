/**
 * Research ROI Assessment
 *
 * Evaluates whether research tasks are providing value or reaching diminishing returns.
 * Uses existing infrastructure (knowledge, decisions, task-file patterns) to compute
 * novelty and saturation signals, then uses sonnet to make contextual judgments.
 *
 * Called before spawning research subtasks to prevent infinite research loops.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MAX_TURNS_SINGLE } from "./constants.js";
import { findSimilarDecisions } from "./decision-tracker.js";
import { type AddLearningResult, findRelevantLearnings, loadKnowledge, NO_QUALITY_THRESHOLDS } from "./knowledge.js";
import { sessionLogger } from "./logger.js";
import { getAllTasks, type Task } from "./task.js";
import {
	MODEL_NAMES,
	type ResearchConclusion,
	type ResearchOutcomeType,
	type ResearchROIAssessment,
	type ResearchROIRecommendation,
	type ResearchROISignals,
} from "./types.js";

const logger = sessionLogger.child({ module: "research-roi" });

/**
 * Context gathered for ROI assessment
 */
export interface ResearchROIContext {
	/** The research task ID */
	taskId: string;
	/** The research topic/objective */
	topic: string;
	/** Existing knowledge entries related to this topic */
	existingKnowledge: number;
	/** Recent decisions on similar topics */
	recentDecisions: number;
	/** Prior research tasks on similar topics */
	priorResearchOnTopic: Task[];
	/** Recent learning addition results (for novelty tracking) */
	recentLearningResults?: AddLearningResult[];
}

/**
 * Soft guardrails for ROI assessment (inform judgment, not hard cutoffs)
 */
const ROI_CONTEXT = {
	/** Below this novelty, mention diminishing returns to the model */
	typicalNoveltyFloor: 0.2,
	/** Below this proposal yield, mention exhausted research */
	typicalProposalYield: 0.5,
	/** After this many research cycles, bias toward implementing */
	maxResearchCyclesSoftCap: 3,
};

/**
 * Calculate novelty trend from recent learning additions
 * Lower values = findings are getting repetitive
 */
function calculateNoveltyTrend(learningResults: AddLearningResult[]): number {
	if (learningResults.length === 0) {
		return 1.0; // No data = assume novel
	}

	// Average novelty score of recent additions
	const avgNovelty = learningResults.reduce((sum, r) => sum + r.noveltyScore, 0) / learningResults.length;

	// Weight more recent additions higher
	const recentWeight = 0.6;
	const recent = learningResults.slice(-3);
	if (recent.length > 0) {
		const recentAvg = recent.reduce((sum, r) => sum + r.noveltyScore, 0) / recent.length;
		return avgNovelty * (1 - recentWeight) + recentAvg * recentWeight;
	}

	return avgNovelty;
}

/**
 * Calculate proposal yield from prior research tasks
 * How many actionable proposals per research cycle?
 */
function calculateProposalYield(priorResearch: Task[], _stateDir: string): number {
	if (priorResearch.length === 0) {
		return 1.0; // No prior research = assume good yield
	}

	// Count tasks spawned from research conclusions
	let totalProposals = 0;
	for (const task of priorResearch) {
		if (task.researchConclusion?.proposalsGenerated) {
			totalProposals += task.researchConclusion.proposalsGenerated;
		}
	}

	// Normalize by research cycles
	const yield_ = totalProposals / priorResearch.length;

	// Clamp to 0-1 range (3+ proposals per cycle = 1.0)
	return Math.min(1.0, yield_ / 3);
}

/**
 * Calculate decision repetition rate
 * Higher values = we keep making the same decisions
 */
function calculateDecisionRepetition(topic: string, stateDir: string): number {
	const keywords = topic
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 3);

	const similarDecisions = findSimilarDecisions(keywords, 10, stateDir);

	if (similarDecisions.length < 2) {
		return 0; // Not enough decisions to detect repetition
	}

	// Check how many decisions have the same outcome
	const outcomeGroups = new Map<string, number>();
	for (const decision of similarDecisions) {
		const outcome = decision.resolution.decision;
		outcomeGroups.set(outcome, (outcomeGroups.get(outcome) || 0) + 1);
	}

	// If one outcome dominates, we're being repetitive
	const maxCount = Math.max(...outcomeGroups.values());
	return maxCount / similarDecisions.length;
}

/**
 * Calculate knowledge saturation for a topic
 * Higher values = topic is well-covered
 */
function calculateKnowledgeSaturation(topic: string, stateDir: string): number {
	const kb = loadKnowledge(stateDir);
	// Use NO_QUALITY_THRESHOLDS to count all relevant learnings for saturation assessment
	const relevantLearnings = findRelevantLearnings(topic, 20, stateDir, NO_QUALITY_THRESHOLDS);

	if (kb.learnings.length === 0) {
		return 0; // Empty knowledge base = not saturated
	}

	// Saturation based on:
	// 1. How many relevant learnings exist
	// 2. Average confidence of those learnings (higher = well-validated)

	const relevanceRatio = Math.min(1.0, relevantLearnings.length / 10);
	const avgConfidence =
		relevantLearnings.length > 0
			? relevantLearnings.reduce((sum, l) => sum + l.confidence, 0) / relevantLearnings.length
			: 0;

	// Combine: high relevance + high confidence = saturated
	return relevanceRatio * 0.6 + avgConfidence * 0.4;
}

/**
 * Find prior research tasks on a similar topic
 */
function findPriorResearchTasks(topic: string, stateDir: string): Task[] {
	const allTasks = getAllTasks(stateDir);
	const keywords = new Set(
		topic
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 3),
	);

	// Find research-prefixed tasks with keyword overlap
	return allTasks.filter((task) => {
		// Check if it's a research task
		const isResearch =
			task.objective.toLowerCase().startsWith("[research]") ||
			task.objective.toLowerCase().includes("research") ||
			task.researchConclusion !== undefined;

		if (!isResearch) return false;

		// Check keyword overlap
		const taskKeywords = new Set(
			task.objective
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3),
		);
		const overlap = [...keywords].filter((k) => taskKeywords.has(k)).length;

		return overlap >= 2; // At least 2 keywords in common
	});
}

/**
 * Gather context for ROI assessment
 */
export async function gatherResearchROIContext(
	taskId: string,
	topic: string,
	stateDir: string = ".undercity",
): Promise<ResearchROIContext> {
	// Use NO_QUALITY_THRESHOLDS to count all relevant learnings for ROI assessment
	const existingKnowledge = findRelevantLearnings(topic, 20, stateDir, NO_QUALITY_THRESHOLDS).length;
	const keywords = topic
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 3);
	const recentDecisions = findSimilarDecisions(keywords, 10, stateDir).length;
	const priorResearchOnTopic = findPriorResearchTasks(topic, stateDir);

	return {
		taskId,
		topic,
		existingKnowledge,
		recentDecisions,
		priorResearchOnTopic,
	};
}

/**
 * Assess research ROI using sonnet for contextual judgment
 *
 * Gathers heuristic signals first, then feeds them to sonnet
 * for nuanced interpretation rather than hard threshold cutoffs.
 */
export async function assessResearchROI(
	ctx: ResearchROIContext,
	stateDir: string = ".undercity",
	cwd: string = process.cwd(),
): Promise<ResearchROIAssessment> {
	logger.info({ topic: ctx.topic, taskId: ctx.taskId }, "Assessing research ROI");

	// 1. Gather heuristic signals
	const signals: ResearchROISignals = {
		noveltyTrend: ctx.recentLearningResults ? calculateNoveltyTrend(ctx.recentLearningResults) : 0.8,
		proposalYield: calculateProposalYield(ctx.priorResearchOnTopic, stateDir),
		decisionRepetition: calculateDecisionRepetition(ctx.topic, stateDir),
		knowledgeSaturation: calculateKnowledgeSaturation(ctx.topic, stateDir),
	};

	// 2. Check for obvious cases (skip LLM call)
	if (signals.knowledgeSaturation > 0.9 && signals.noveltyTrend < 0.1) {
		// Topic is well-covered and findings are all duplicates
		return {
			recommendation: "mark_absorbed",
			confidence: 0.9,
			signals,
			rationale: "Topic is extensively covered in knowledge base with no novel findings.",
		};
	}

	if (ctx.priorResearchOnTopic.length >= ROI_CONTEXT.maxResearchCyclesSoftCap && signals.proposalYield < 0.2) {
		// Multiple research cycles with no actionable output
		return {
			recommendation: "conclude_no_go",
			confidence: 0.85,
			signals,
			rationale: `${ctx.priorResearchOnTopic.length} research cycles with minimal actionable proposals.`,
		};
	}

	// 3. Use sonnet for nuanced judgment
	const prompt = `You are evaluating whether to continue research or move to implementation.

Topic: ${ctx.topic}

Signals (0-1 scale):
- Novelty trend: ${signals.noveltyTrend.toFixed(2)} (0=repeating known facts, 1=all new findings)
- Proposal yield: ${signals.proposalYield.toFixed(2)} (actionable tasks per research cycle)
- Decision repetition: ${signals.decisionRepetition.toFixed(2)} (0=new decisions, 1=same as before)
- Knowledge saturation: ${signals.knowledgeSaturation.toFixed(2)} (0=learning new things, 1=all duplicates)

Context:
- Prior research on this topic: ${ctx.priorResearchOnTopic.length} tasks
- Existing knowledge entries: ${ctx.existingKnowledge}
- Related decisions already made: ${ctx.recentDecisions}

Thresholds for reference (soft guidelines, not hard cutoffs):
- Novelty below ${ROI_CONTEXT.typicalNoveltyFloor} suggests diminishing returns
- Proposal yield below ${ROI_CONTEXT.typicalProposalYield} suggests research exhausted
- More than ${ROI_CONTEXT.maxResearchCyclesSoftCap} research cycles suggests time to implement

Based on these signals, recommend ONE of:
- "continue_research": More research would yield valuable new insights
- "start_implementing": We know enough, time to build
- "conclude_no_go": Research indicates this isn't worth implementing
- "mark_absorbed": Topic is well-covered in existing knowledge

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{"recommendation": "one_of_the_four_options", "confidence": 0.XX, "rationale": "brief explanation"}`;

	try {
		let resultJson = "";

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.sonnet,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns: MAX_TURNS_SINGLE,
				cwd,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				resultJson = message.result;
			}
		}

		// Parse JSON response
		const parsed = JSON.parse(resultJson.trim()) as {
			recommendation: ResearchROIRecommendation;
			confidence: number;
			rationale: string;
		};

		logger.info(
			{
				topic: ctx.topic,
				recommendation: parsed.recommendation,
				confidence: parsed.confidence,
				signals,
			},
			"Research ROI assessment complete",
		);

		return {
			recommendation: parsed.recommendation,
			confidence: parsed.confidence,
			signals,
			rationale: parsed.rationale,
		};
	} catch (error) {
		logger.warn({ error: String(error), topic: ctx.topic }, "ROI assessment LLM call failed, using heuristics");

		// Fallback to heuristic-based decision
		if (signals.noveltyTrend < ROI_CONTEXT.typicalNoveltyFloor) {
			return {
				recommendation: "start_implementing",
				confidence: 0.6,
				signals,
				rationale: "Low novelty trend suggests diminishing research returns.",
			};
		}

		return {
			recommendation: "continue_research",
			confidence: 0.5,
			signals,
			rationale: "Unable to assess via LLM, defaulting to continue research.",
		};
	}
}

/**
 * Create a research conclusion from an ROI assessment
 */
export function createResearchConclusion(
	assessment: ResearchROIAssessment,
	proposalsGenerated: number,
	linkedDecisionId?: string,
	linkedTaskIds?: string[],
): ResearchConclusion {
	const outcomeMap: Record<ResearchROIRecommendation, ResearchOutcomeType> = {
		continue_research: "insufficient",
		start_implementing: "implement",
		conclude_no_go: "no_go",
		mark_absorbed: "absorbed",
	};

	return {
		outcome: outcomeMap[assessment.recommendation],
		rationale: assessment.rationale,
		noveltyScore: assessment.signals.noveltyTrend,
		proposalsGenerated,
		linkedDecisionId,
		linkedTaskIds,
		concludedAt: new Date().toISOString(),
	};
}

/**
 * Check if a task objective indicates a research task
 */
export function isResearchTask(objective: string): boolean {
	const lower = objective.toLowerCase();
	return (
		lower.startsWith("[research]") ||
		lower.includes("research ") ||
		lower.includes("investigate ") ||
		lower.includes("explore ") ||
		lower.includes("analyze ") ||
		lower.includes("study ")
	);
}

/**
 * Get ROI assessment statistics for reporting
 */
export function getResearchROIStats(stateDir: string = ".undercity"): {
	totalResearchTasks: number;
	conclusionsByOutcome: Record<ResearchOutcomeType, number>;
	avgNoveltyScore: number;
	avgProposalsPerResearch: number;
} {
	const allTasks = getAllTasks(stateDir);
	const researchTasks = allTasks.filter((t) => t.researchConclusion !== undefined);

	const conclusionsByOutcome: Record<ResearchOutcomeType, number> = {
		implement: 0,
		no_go: 0,
		insufficient: 0,
		absorbed: 0,
	};

	let totalNovelty = 0;
	let totalProposals = 0;

	for (const task of researchTasks) {
		if (task.researchConclusion) {
			conclusionsByOutcome[task.researchConclusion.outcome]++;
			totalNovelty += task.researchConclusion.noveltyScore;
			totalProposals += task.researchConclusion.proposalsGenerated;
		}
	}

	return {
		totalResearchTasks: researchTasks.length,
		conclusionsByOutcome,
		avgNoveltyScore: researchTasks.length > 0 ? totalNovelty / researchTasks.length : 0,
		avgProposalsPerResearch: researchTasks.length > 0 ? totalProposals / researchTasks.length : 0,
	};
}
