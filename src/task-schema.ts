/**
 * Task Schema
 *
 * Type-safe task validation and routing with prefix conventions.
 *
 * | Prefix Format   | Task Type       | Example                    |
 * |-----------------|-----------------|----------------------------|
 * | [meta:*]        | Board operation | [meta:triage], [meta:plan] |
 * | [plan]          | Planning task   | [plan] Add auth system     |
 * | [category]      | Implementation  | [refactor], [test], [docs] |
 */

// =============================================================================
// Task Type Definitions
// =============================================================================

/**
 * Meta-task types - tasks that operate on the task board itself
 */
export type MetaTaskType = "triage" | "prune" | "plan" | "prioritize" | "generate";
const META_TASK_TYPES: MetaTaskType[] = ["triage", "prune", "plan", "prioritize", "generate"];

/**
 * Research task keywords - tasks that gather information without code changes
 */
const RESEARCH_KEYWORDS = [
	"research",
	"investigate",
	"analyze",
	"find out",
	"learn about",
	"explore",
	"understand",
	"document",
	"summarize",
	"compare",
	"evaluate",
	"review",
	"study",
	"web search",
	"search for",
];

/**
 * Category prefixes: informal tags in brackets at objective start
 */
export type TaskCategory =
	// Meta-tasks (operate on task board)
	| "meta:triage"
	| "meta:prune"
	| "meta:plan"
	| "meta:prioritize"
	| "meta:generate"
	// Planning
	| "plan"
	// Research (no code changes)
	| "research"
	// Feature categories
	| "feedback"
	| "context"
	| "metrics"
	| "grind"
	| "integration"
	| "cli"
	| "docs"
	| "refactor"
	| "test"
	| "stabilization"
	| "priming"
	| "skill"
	| "witness"
	| "recovery"
	| "onboard"
	| "portable"
	| "agent-opt"
	| "optimization"
	| "periodic"
	| "verify"
	| "phase3";

const TASK_CATEGORIES: TaskCategory[] = [
	"meta:triage",
	"meta:prune",
	"meta:plan",
	"meta:prioritize",
	"meta:generate",
	"plan",
	"research",
	"feedback",
	"context",
	"metrics",
	"grind",
	"integration",
	"cli",
	"docs",
	"refactor",
	"test",
	"stabilization",
	"priming",
	"skill",
	"witness",
	"recovery",
	"onboard",
	"portable",
	"agent-opt",
	"optimization",
	"periodic",
	"verify",
	"phase3",
];

/**
 * Task type classification:
 * - Meta: operate on task board (triage, prune, plan, etc.)
 * - Research: gather information, no code changes required
 * - Implementation: make code changes
 */
export type TaskType = "meta" | "research" | "implementation";

// =============================================================================
// Task Parsing
// =============================================================================

/**
 * Extract category prefix from objective
 * Returns null if no recognized prefix found
 */
export function extractTaskCategory(objective: string): TaskCategory | null {
	const match = objective.match(/^\[([^\]]+)\]/);
	if (!match) return null;

	const prefix = match[1].toLowerCase();
	return TASK_CATEGORIES.includes(prefix as TaskCategory) ? (prefix as TaskCategory) : null;
}

/**
 * Determine task type from objective
 */
export function getTaskType(objective: string): TaskType {
	const lower = objective.toLowerCase();

	// Meta-tasks (including [plan] which is a meta-task that generates implementation tasks)
	if (lower.startsWith("[meta:") || lower.startsWith("[plan]")) {
		return "meta";
	}

	// Explicit research prefix
	if (lower.startsWith("[research]")) {
		return "research";
	}

	// Keyword-based research detection
	for (const keyword of RESEARCH_KEYWORDS) {
		if (lower.includes(keyword)) {
			// Make sure it's not asking to implement something with these words
			// e.g., "implement research feature" is implementation, not research
			const implementWords = ["implement", "add", "create", "build", "fix", "update", "modify", "refactor"];
			const hasImplementWord = implementWords.some((w) => lower.includes(w));
			if (!hasImplementWord) {
				return "research";
			}
		}
	}

	// Everything else is implementation
	return "implementation";
}

/**
 * Check if objective is a research task
 */
export function isResearchTask(objective: string): boolean {
	return getTaskType(objective) === "research";
}

/**
 * Check if objective is a meta-task
 */
export function isMetaTask(objective: string): boolean {
	return getTaskType(objective) === "meta";
}

/**
 * Extract meta-task type from objective
 * Handles both [meta:type] and [plan] formats
 */
export function extractMetaTaskType(objective: string): MetaTaskType | null {
	const lower = objective.toLowerCase();

	// Handle [plan] as equivalent to [meta:plan]
	if (lower.startsWith("[plan]")) {
		return "plan";
	}

	// Handle [meta:type] format
	const match = objective.match(/^\[meta:(\w+)\]/i);
	if (!match) return null;

	const metaType = match[1].toLowerCase();
	return META_TASK_TYPES.includes(metaType as MetaTaskType) ? (metaType as MetaTaskType) : null;
}

/**
 * Check if objective is a plan task (either [plan] or [meta:plan])
 */
export function isPlanTask(objective: string): boolean {
	const metaType = extractMetaTaskType(objective);
	return metaType === "plan";
}

// =============================================================================
// Task Status Schema
// =============================================================================

export type TaskStatus =
	| "pending"
	| "in_progress"
	| "complete"
	| "failed"
	| "blocked"
	| "duplicate"
	| "canceled"
	| "obsolete";

// =============================================================================
// Full Task Schema
// =============================================================================

export interface TaskSchemaType {
	id: string;
	objective: string;
	status: TaskStatus;
	priority?: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	sessionId?: string;
	error?: string;

	// Resolution fields
	resolution?: string;
	duplicateOfCommit?: string;

	// Matchmaking fields
	packageHints?: string[];
	dependsOn?: string[];
	conflicts?: string[];
	estimatedFiles?: string[];
	tags?: string[];

	// Computed fields
	computedPackages?: string[];
	riskScore?: number;

	// Decomposition fields
	parentId?: string;
	subtaskIds?: string[];
	isDecomposed?: boolean;
}

export interface TaskBoardSchemaType {
	tasks: TaskSchemaType[];
	lastUpdated: Date;
}

// =============================================================================
// Meta-task Result Schema
// =============================================================================

export type MetaTaskAction =
	| "remove"
	| "complete"
	| "fix_status"
	| "merge"
	| "add"
	| "update"
	| "prioritize"
	| "decompose"
	| "block"
	| "unblock";

const META_TASK_ACTIONS: MetaTaskAction[] = [
	"remove",
	"complete",
	"fix_status",
	"merge",
	"add",
	"update",
	"prioritize",
	"decompose",
	"block",
	"unblock",
];

export interface MetaTaskRecommendation {
	action: MetaTaskAction;
	taskId?: string;
	relatedTaskIds?: string[];
	reason: string;
	confidence: number;
	newTask?: {
		objective: string;
		priority?: number;
		tags?: string[];
		dependsOn?: string[];
	};
	updates?: {
		objective?: string;
		priority?: number;
		tags?: string[];
		status?: string;
	};
}

export interface MetaTaskResultSchemaType {
	metaTaskType: MetaTaskType;
	recommendations: MetaTaskRecommendation[];
	summary: string;
	metrics?: {
		healthScore?: number;
		issuesFound?: number;
		tasksAnalyzed?: number;
	};
}

/**
 * Parse and validate meta-task result from agent output
 */
export function parseMetaTaskResult(output: string, metaType: MetaTaskType): MetaTaskResultSchemaType | null {
	try {
		// Look for JSON block in output
		const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
		const jsonStr = jsonMatch ? jsonMatch[1] : output;

		const parsed = JSON.parse(jsonStr);

		// Basic validation
		if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
			return null;
		}

		// Validate recommendations
		for (const rec of parsed.recommendations) {
			if (!rec.action || !META_TASK_ACTIONS.includes(rec.action)) {
				console.error("Invalid meta-task action:", rec.action);
				return null;
			}
			if (typeof rec.reason !== "string") {
				console.error("Missing reason in recommendation");
				return null;
			}
			if (typeof rec.confidence !== "number" || rec.confidence < 0 || rec.confidence > 1) {
				console.error("Invalid confidence:", rec.confidence);
				return null;
			}
		}

		return {
			metaTaskType: metaType,
			recommendations: parsed.recommendations,
			summary: parsed.summary || "No summary provided",
			metrics: parsed.metrics,
		};
	} catch {
		return null;
	}
}

// =============================================================================
// Research Task Result Schema
// =============================================================================

export interface ResearchFinding {
	/** Key insight or fact discovered */
	finding: string;
	/** Source of this information (URL, file, documentation) */
	source?: string;
	/** Confidence in this finding (0-1) */
	confidence: number;
	/** Category: fact, recommendation, warning, etc. */
	category: "fact" | "recommendation" | "warning" | "comparison" | "example";
}

export interface ResearchResultSchemaType {
	/** Brief summary of findings */
	summary: string;
	/** Detailed findings */
	findings: ResearchFinding[];
	/** Suggested next steps or follow-up tasks */
	nextSteps?: string[];
	/** Sources consulted */
	sources?: string[];
	/** Any limitations or caveats */
	caveats?: string[];
}

/**
 * Parse and validate research result from agent output
 */
export function parseResearchResult(output: string): ResearchResultSchemaType | null {
	try {
		// Look for JSON block in output
		const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[1]);
			if (parsed.summary && Array.isArray(parsed.findings)) {
				return {
					summary: parsed.summary,
					findings: parsed.findings,
					nextSteps: parsed.nextSteps,
					sources: parsed.sources,
					caveats: parsed.caveats,
				};
			}
		}

		// If no structured output, create a simple result from the text
		// Research tasks can succeed with just prose output
		if (output.trim().length > 100) {
			return {
				summary: output.slice(0, 500),
				findings: [
					{
						finding: "Research completed - see full output for details",
						confidence: 0.8,
						category: "fact",
					},
				],
			};
		}

		return null;
	} catch {
		// Even if JSON parsing fails, accept prose output
		if (output.trim().length > 100) {
			return {
				summary: output.slice(0, 500),
				findings: [
					{
						finding: "Research completed - see full output for details",
						confidence: 0.7,
						category: "fact",
					},
				],
			};
		}
		return null;
	}
}
