/**
 * Structured Output Schemas
 *
 * Zod schemas and JSON Schema conversions for SDK structured output.
 * Used with the `outputFormat` option to get validated JSON responses
 * instead of parsing free-text with regex.
 *
 * Pattern: Define Zod schema -> convert to JSON Schema -> pass to SDK.
 * SDK returns structured_output which is validated against the Zod schema.
 * Fallback to existing text parsing if structured output is null.
 */

import { toJSONSchema, z } from "zod";

// =============================================================================
// Helper
// =============================================================================

/**
 * Validate structured output from SDK against a Zod schema.
 * Returns validated data or null (triggers fallback to text parsing).
 */
export function extractStructuredOutput<T>(raw: unknown, schema: z.ZodType<T>): T | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	const result = schema.safeParse(raw);
	if (result.success) {
		return result.data;
	}
	return null;
}

// =============================================================================
// Knowledge Extraction
// =============================================================================

/**
 * Schema for model-extracted learnings from task conversations.
 * Used in knowledge-extractor.ts extractLearningsWithModel().
 */
export const ExtractedLearningsSchema = z.array(
	z.object({
		category: z.enum(["pattern", "gotcha", "fact", "preference"]),
		content: z.string(),
		file: z.string().optional(),
	}),
);

export type ExtractedLearningsOutput = z.infer<typeof ExtractedLearningsSchema>;

export const ExtractedLearningsJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(ExtractedLearningsSchema) as Record<string, unknown>,
};

// =============================================================================
// Task Decomposition
// =============================================================================

/**
 * Schema for decomposition subtask list.
 * Used in task-planner.ts requestDecompositionSubtasks().
 */
export const DecompositionSubtasksSchema = z.array(z.string());

export type DecompositionSubtasksOutput = z.infer<typeof DecompositionSubtasksSchema>;

export const DecompositionSubtasksJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(DecompositionSubtasksSchema) as Record<string, unknown>,
};

// =============================================================================
// Execution Plan
// =============================================================================

/**
 * Schema for execution plans created/revised by the planner.
 * Used in task-planner.ts createExecutionPlan() and revisePlan().
 */
export const ExecutionPlanSchema = z.object({
	objective: z.string(),
	filesToRead: z.array(z.string()),
	filesToModify: z.array(z.string()),
	filesToCreate: z.array(z.string()),
	steps: z.array(z.string()),
	risks: z.array(z.string()),
	expectedOutcome: z.string(),
	alreadyComplete: z
		.object({
			likely: z.boolean(),
			reason: z.string().optional(),
		})
		.optional(),
	needsDecomposition: z
		.object({
			needed: z.boolean(),
			suggestedSubtasks: z.array(z.string()).optional(),
		})
		.optional(),
	openQuestions: z
		.array(
			z.object({
				question: z.string(),
				options: z.array(z.string()).optional(),
				context: z.string().optional(),
			}),
		)
		.optional(),
	resolvedDecisions: z
		.array(
			z.object({
				question: z.string(),
				decision: z.string(),
			}),
		)
		.optional(),
});

export type ExecutionPlanOutput = z.infer<typeof ExecutionPlanSchema>;

export const ExecutionPlanJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(ExecutionPlanSchema) as Record<string, unknown>,
};

// =============================================================================
// Plan Review
// =============================================================================

/**
 * Schema for plan review results from the reviewer model.
 * Used in task-planner.ts reviewExecutionPlan().
 */
export const PlanReviewSchema = z.object({
	approved: z.boolean(),
	issues: z.array(z.string()),
	suggestions: z.array(z.string()),
	revisedPlan: ExecutionPlanSchema.partial().optional(),
	skipExecution: z
		.object({
			skip: z.boolean(),
			reason: z.string().optional(),
		})
		.optional(),
});

export type PlanReviewOutput = z.infer<typeof PlanReviewSchema>;

export const PlanReviewJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(PlanReviewSchema) as Record<string, unknown>,
};

// =============================================================================
// PM Refine Output
// =============================================================================

/**
 * Schema for PM task refinement output.
 * Used in automated-pm.ts pmRefineTask().
 */
export const PMRefineOutputSchema = z.object({
	description: z.string().optional(),
	acceptanceCriteria: z.array(z.string()).optional(),
	testPlan: z.string().optional(),
	implementationNotes: z.string().optional(),
	rationale: z.string().optional(),
});

export type PMRefineOutput = z.infer<typeof PMRefineOutputSchema>;

export const PMRefineOutputJSONSchema = {
	type: "json_schema" as const,
	schema: toJSONSchema(PMRefineOutputSchema) as Record<string, unknown>,
};
