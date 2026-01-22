/**
 * PM Schemas
 *
 * Zod schemas for validating PM research results and task proposals.
 * Provides structural validation with max lengths and counts to prevent
 * resource exhaustion attacks and ensure data quality.
 */

import { z } from "zod";

// ============================================================================
// Constants for limits
// ============================================================================

/** Maximum length for task objectives */
const MAX_OBJECTIVE_LENGTH = 500;

/** Maximum length for rationale text */
const MAX_RATIONALE_LENGTH = 1000;

/** Maximum length for individual findings/recommendations */
const MAX_FINDING_LENGTH = 2000;

/** Maximum length for source URLs/descriptions */
const MAX_SOURCE_LENGTH = 500;

/** Maximum number of findings per research result */
const MAX_FINDINGS_COUNT = 20;

/** Maximum number of recommendations per research result */
const MAX_RECOMMENDATIONS_COUNT = 10;

/** Maximum number of sources per research result */
const MAX_SOURCES_COUNT = 10;

/** Maximum number of task proposals per result */
const MAX_PROPOSALS_COUNT = 10;

/** Maximum number of tags per proposal */
const MAX_TAGS_COUNT = 10;

/** Maximum length for individual tags */
const MAX_TAG_LENGTH = 50;

/** Maximum number of research findings in a proposal */
const MAX_RESEARCH_FINDINGS_PER_PROPOSAL = 5;

// ============================================================================
// Task Proposal Schema
// ============================================================================

/**
 * Schema for validating task proposal source types
 */
export const TaskProposalSourceSchema = z.enum(["research", "pattern_analysis", "codebase_gap", "user_request"]);

/**
 * Schema for validating a single task proposal
 */
export const TaskProposalSchema = z.object({
	/** Task objective - what needs to be done */
	objective: z
		.string()
		.min(10, "Objective must be at least 10 characters")
		.max(MAX_OBJECTIVE_LENGTH, `Objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`),

	/** Rationale explaining why this task matters */
	rationale: z.string().max(MAX_RATIONALE_LENGTH, `Rationale exceeds ${MAX_RATIONALE_LENGTH} characters`),

	/** Suggested priority (1-1000, higher = more important) */
	suggestedPriority: z.number().int().min(1).max(1000).default(500),

	/** Source of the proposal */
	source: TaskProposalSourceSchema.default("research"),

	/** Research findings that informed this proposal */
	researchFindings: z.array(z.string().max(MAX_FINDING_LENGTH)).max(MAX_RESEARCH_FINDINGS_PER_PROPOSAL).optional(),

	/** Tags for categorization */
	tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).optional(),
});

export type TaskProposal = z.infer<typeof TaskProposalSchema>;

// ============================================================================
// Research Result Schema
// ============================================================================

/**
 * Schema for validating PM research results
 */
export const PMResearchResultSchema = z.object({
	/** Topic that was researched */
	topic: z.string().max(500),

	/** Key findings from research */
	findings: z.array(z.string().max(MAX_FINDING_LENGTH)).max(MAX_FINDINGS_COUNT).default([]),

	/** Recommended actions based on findings */
	recommendations: z.array(z.string().max(MAX_FINDING_LENGTH)).max(MAX_RECOMMENDATIONS_COUNT).default([]),

	/** Sources consulted during research */
	sources: z.array(z.string().max(MAX_SOURCE_LENGTH)).max(MAX_SOURCES_COUNT).default([]),

	/** Task proposals derived from research */
	taskProposals: z.array(TaskProposalSchema).max(MAX_PROPOSALS_COUNT).default([]),
});

export type PMResearchResult = z.infer<typeof PMResearchResultSchema>;

// ============================================================================
// Ideation Result Schema
// ============================================================================

/**
 * Schema for PM ideation results (research + proposals)
 */
export const PMIdeationResultSchema = z.object({
	/** Research component */
	research: PMResearchResultSchema,

	/** Combined proposals from research and codebase analysis */
	proposals: z
		.array(TaskProposalSchema)
		.max(MAX_PROPOSALS_COUNT * 2)
		.default([]),
});

export type PMIdeationResult = z.infer<typeof PMIdeationResultSchema>;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate and parse a task proposal object
 *
 * @param data - Unknown data to validate
 * @returns Parsed TaskProposal or throws ZodError
 */
export function parseTaskProposal(data: unknown): TaskProposal {
	return TaskProposalSchema.parse(data);
}

/**
 * Safely parse a task proposal (returns result object)
 *
 * @param data - Unknown data to validate
 * @returns SafeParseResult with success status and data/error
 */
export function safeParseTaskProposal(data: unknown) {
	return TaskProposalSchema.safeParse(data);
}

/**
 * Validate and parse PM research results
 *
 * @param data - Unknown data to validate
 * @returns Parsed PMResearchResult or throws ZodError
 */
export function parsePMResearchResult(data: unknown): PMResearchResult {
	return PMResearchResultSchema.parse(data);
}

/**
 * Safely parse PM research results (returns result object)
 *
 * @param data - Unknown data to validate
 * @returns SafeParseResult with success status and data/error
 */
export function safeParsePMResearchResult(data: unknown) {
	return PMResearchResultSchema.safeParse(data);
}

/**
 * Validate and parse an array of task proposals
 *
 * @param data - Unknown array data to validate
 * @returns Parsed TaskProposal array or throws ZodError
 */
export function parseTaskProposals(data: unknown): TaskProposal[] {
	return z.array(TaskProposalSchema).max(MAX_PROPOSALS_COUNT).parse(data);
}

/**
 * Safely parse task proposals array
 *
 * @param data - Unknown array data to validate
 * @returns SafeParseResult with success status and data/error
 */
export function safeParseTaskProposals(data: unknown) {
	return z.array(TaskProposalSchema).max(MAX_PROPOSALS_COUNT).safeParse(data);
}

/**
 * Validate and constrain a raw research result from LLM output
 * More lenient - coerces and truncates rather than rejecting
 *
 * @param rawResult - Raw result from LLM (may have invalid fields)
 * @returns Validated and constrained result
 */
export function constrainResearchResult(rawResult: Partial<PMResearchResult>): PMResearchResult {
	return {
		topic: typeof rawResult.topic === "string" ? rawResult.topic.substring(0, 500) : "unknown",

		findings: Array.isArray(rawResult.findings)
			? rawResult.findings
					.filter((f): f is string => typeof f === "string")
					.slice(0, MAX_FINDINGS_COUNT)
					.map((f) => f.substring(0, MAX_FINDING_LENGTH))
			: [],

		recommendations: Array.isArray(rawResult.recommendations)
			? rawResult.recommendations
					.filter((r): r is string => typeof r === "string")
					.slice(0, MAX_RECOMMENDATIONS_COUNT)
					.map((r) => r.substring(0, MAX_FINDING_LENGTH))
			: [],

		sources: Array.isArray(rawResult.sources)
			? rawResult.sources
					.filter((s): s is string => typeof s === "string")
					.slice(0, MAX_SOURCES_COUNT)
					.map((s) => s.substring(0, MAX_SOURCE_LENGTH))
			: [],

		taskProposals: Array.isArray(rawResult.taskProposals)
			? rawResult.taskProposals
					.filter(
						(p) =>
							typeof p === "object" &&
							p !== null &&
							"objective" in p &&
							typeof (p as { objective?: unknown }).objective === "string",
					)
					.slice(0, MAX_PROPOSALS_COUNT)
					.map((p) => constrainTaskProposal(p as unknown as Partial<TaskProposal>))
			: [],
	};
}

/**
 * Validate and constrain a raw task proposal from LLM output
 *
 * @param rawProposal - Raw proposal from LLM
 * @returns Validated and constrained proposal
 */
export function constrainTaskProposal(rawProposal: Partial<TaskProposal>): TaskProposal {
	return {
		objective:
			typeof rawProposal.objective === "string"
				? rawProposal.objective.substring(0, MAX_OBJECTIVE_LENGTH)
				: "Invalid objective",

		rationale:
			typeof rawProposal.rationale === "string" ? rawProposal.rationale.substring(0, MAX_RATIONALE_LENGTH) : "",

		suggestedPriority:
			typeof rawProposal.suggestedPriority === "number" &&
			rawProposal.suggestedPriority >= 1 &&
			rawProposal.suggestedPriority <= 1000
				? Math.floor(rawProposal.suggestedPriority)
				: 500,

		source: TaskProposalSourceSchema.safeParse(rawProposal.source).success
			? (rawProposal.source as TaskProposal["source"])
			: "research",

		researchFindings: Array.isArray(rawProposal.researchFindings)
			? rawProposal.researchFindings
					.filter((f): f is string => typeof f === "string")
					.slice(0, MAX_RESEARCH_FINDINGS_PER_PROPOSAL)
					.map((f) => f.substring(0, MAX_FINDING_LENGTH))
			: undefined,

		tags: Array.isArray(rawProposal.tags)
			? rawProposal.tags
					.filter((t): t is string => typeof t === "string")
					.slice(0, MAX_TAGS_COUNT)
					.map((t) => t.substring(0, MAX_TAG_LENGTH))
			: undefined,
	};
}

// ============================================================================
// Schema Limits Export (for documentation/testing)
// ============================================================================

/**
 * Export limits for documentation and testing
 */
export const PM_SCHEMA_LIMITS = {
	MAX_OBJECTIVE_LENGTH,
	MAX_RATIONALE_LENGTH,
	MAX_FINDING_LENGTH,
	MAX_SOURCE_LENGTH,
	MAX_FINDINGS_COUNT,
	MAX_RECOMMENDATIONS_COUNT,
	MAX_SOURCES_COUNT,
	MAX_PROPOSALS_COUNT,
	MAX_TAGS_COUNT,
	MAX_TAG_LENGTH,
	MAX_RESEARCH_FINDINGS_PER_PROPOSAL,
} as const;
