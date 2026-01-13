/**
 * DSPy-Inspired Prompt Variants
 *
 * Implements prompt optimization techniques from DSPy research:
 * 1. Chain-of-Thought (CoT) - Explicit reasoning steps
 * 2. Few-Shot Learning - Successful execution examples
 * 3. Signature-based - Clear input/output contracts
 *
 * Each variant can be tested via the experiment framework to
 * measure effectiveness (success rate, tokens, duration).
 */

import type { ExperimentVariant } from "./types.js";

/**
 * Prompt variant identifier
 */
export type PromptVariantId = "baseline" | "chain-of-thought" | "few-shot" | "signature-based";

/**
 * Prompt variant configuration
 */
export interface PromptVariant {
	/** Unique identifier */
	id: PromptVariantId;
	/** Human-readable name */
	name: string;
	/** Description of the technique */
	description: string;
	/** The prompt modifier to apply */
	promptModifier: string;
	/** DSPy technique category */
	technique: "baseline" | "cot" | "few-shot" | "signature";
}

/**
 * Builder prompt variants using DSPy techniques
 *
 * These modify the base builder prompt to test different approaches.
 */
export const BUILDER_PROMPT_VARIANTS: Record<PromptVariantId, PromptVariant> = {
	/**
	 * Baseline - Standard builder prompt without modifications
	 * Control group for A/B testing
	 */
	baseline: {
		id: "baseline",
		name: "Baseline (Control)",
		description: "Standard builder prompt without DSPy modifications",
		technique: "baseline",
		promptModifier: "",
	},

	/**
	 * Chain-of-Thought variant
	 *
	 * DSPy insight: Explicit reasoning steps improve task decomposition
	 * and reduce errors by forcing the model to think through the problem.
	 */
	"chain-of-thought": {
		id: "chain-of-thought",
		name: "Chain-of-Thought",
		description: "Adds explicit reasoning steps before action",
		technique: "cot",
		promptModifier: `
REASONING PROTOCOL (complete before ANY action):
1. ANALYZE: What specific change does this task require?
2. LOCATE: Which files need modification? List them.
3. PATTERN: What existing patterns in the codebase should I follow?
4. EDGE CASES: What could go wrong? List 2-3 potential issues.
5. PLAN: Write a 3-step plan for the implementation.

Only after completing this analysis, proceed with implementation.
If any step reveals the task is unclear, report it instead of guessing.`,
	},

	/**
	 * Few-Shot Learning variant
	 *
	 * DSPy insight: Providing successful examples helps the model
	 * understand the expected format and quality of output.
	 */
	"few-shot": {
		id: "few-shot",
		name: "Few-Shot Examples",
		description: "Includes successful execution examples",
		technique: "few-shot",
		promptModifier: `
SUCCESSFUL EXECUTION EXAMPLES:

Example 1: Adding a new function
Task: "Add a helper function to format dates"
Steps taken:
- Located src/utils.ts (existing utilities)
- Added formatDate function following existing naming patterns
- Added JSDoc with parameter descriptions
- Ran typecheck to verify no errors
Result: TASK_COMPLETE - Added formatDate to src/utils.ts

Example 2: Fixing a type error
Task: "Fix type error in config loader"
Steps taken:
- Ran typecheck to identify exact error location
- Read the file to understand the context
- Added missing type annotation matching existing patterns
- Verified fix with typecheck
Result: TASK_COMPLETE - Fixed type in src/config.ts:45

Example 3: Updating an existing function
Task: "Add logging to the task processor"
Steps taken:
- Located task processor in src/processor.ts
- Identified existing logging patterns (found Pino logger)
- Added structured log calls at key points
- Preserved existing behavior, only added logs
Result: TASK_COMPLETE - Added 3 log statements to processor

Follow these patterns: identify location, match existing style, verify changes.`,
	},

	/**
	 * Signature-based variant
	 *
	 * DSPy insight: Clear input/output contracts reduce ambiguity
	 * and help the model understand exactly what's expected.
	 */
	"signature-based": {
		id: "signature-based",
		name: "Signature-Based",
		description: "Explicit input/output contract specification",
		technique: "signature",
		promptModifier: `
TASK SIGNATURE CONTRACT:

INPUT:
- task_description: string  // The specific change to implement
- codebase_context: string  // Relevant files and patterns

OUTPUT (exactly one of):
- TASK_COMPLETE: {
    files_modified: string[]  // List of changed files
    changes_summary: string   // Brief description of changes
    verification: "passed"    // Must pass typecheck
  }
- TASK_BLOCKED: {
    reason: string           // Why task cannot proceed
    missing_info: string[]   // What information is needed
  }
- TASK_ALREADY_DONE: {
    evidence: string         // Commit SHA or existing code reference
  }

CONSTRAINTS:
- files_modified must be non-empty for TASK_COMPLETE
- verification must pass before reporting TASK_COMPLETE
- Never output partial completion - binary success/failure only`,
	},
};

/**
 * Get prompt variant by ID
 */
export function getPromptVariant(id: PromptVariantId): PromptVariant {
	return BUILDER_PROMPT_VARIANTS[id];
}

/**
 * Apply a prompt variant modifier to the base prompt
 */
export function applyPromptVariant(basePrompt: string, variantId: PromptVariantId): string {
	const variant = BUILDER_PROMPT_VARIANTS[variantId];
	if (!variant.promptModifier) {
		return basePrompt;
	}
	return `${basePrompt}\n\n${variant.promptModifier}`;
}

/**
 * Create experiment variants from prompt variants
 *
 * Generates ExperimentVariant configs for A/B testing prompt techniques.
 */
export function createPromptExperimentVariants(baseModel: "haiku" | "sonnet" | "opus" = "sonnet"): ExperimentVariant[] {
	return Object.values(BUILDER_PROMPT_VARIANTS).map((variant, index) => ({
		id: `prompt-${variant.id}`,
		name: variant.name,
		model: baseModel,
		promptModifier: variant.promptModifier,
		reviewEnabled: false,
		weight: index === 0 ? 2 : 1, // Baseline gets 2x weight for more control data
	}));
}

/**
 * Atomicity check prompt variants
 *
 * Different prompting strategies for the task decomposer.
 */
export const ATOMICITY_PROMPT_VARIANTS = {
	/**
	 * Baseline atomicity check
	 */
	baseline: `Assess the complexity of this coding task.

Task: {{task}}

Respond with ONLY JSON:
{
  "isAtomic": true/false,
  "confidence": 0.0-1.0,
  "estimatedFiles": number,
  "recommendedModel": "haiku" | "sonnet" | "opus",
  "reasoning": "brief explanation"
}`,

	/**
	 * Chain-of-thought atomicity check
	 * Adds structured reasoning before decision
	 */
	chainOfThought: `Assess the complexity of this coding task by reasoning through each aspect.

Task: {{task}}

REASONING STEPS (complete all):
1. SCOPE: How many files will this touch? (1, 2-3, 4+)
2. DEPENDENCIES: Does this require changes across multiple modules?
3. RISK: What could go wrong? (low/medium/high)
4. CLARITY: Is the objective clear and specific?

Based on your reasoning, respond with ONLY JSON:
{
  "isAtomic": true/false,
  "confidence": 0.0-1.0,
  "estimatedFiles": number,
  "recommendedModel": "haiku" | "sonnet" | "opus",
  "reasoning": "summary of reasoning steps"
}

ATOMIC = single focus area, 1-3 files, clear objective
NOT ATOMIC = many files, multiple objectives, needs decomposition`,

	/**
	 * Few-shot atomicity check
	 * Includes examples to calibrate judgment
	 */
	fewShot: `Assess the complexity of this coding task.

EXAMPLES:
Task: "Fix typo in README"
→ {"isAtomic": true, "confidence": 0.95, "estimatedFiles": 1, "recommendedModel": "haiku", "reasoning": "Single file, trivial change"}

Task: "Add user authentication system"
→ {"isAtomic": false, "confidence": 0.9, "estimatedFiles": 8, "recommendedModel": "opus", "reasoning": "Multiple files, security-critical, architectural"}

Task: "Update error message in validation function"
→ {"isAtomic": true, "confidence": 0.85, "estimatedFiles": 1, "recommendedModel": "sonnet", "reasoning": "Single function, needs context to update correctly"}

Task: "Refactor database layer to use connection pooling"
→ {"isAtomic": false, "confidence": 0.8, "estimatedFiles": 5, "recommendedModel": "opus", "reasoning": "Cross-cutting concern, affects multiple modules"}

YOUR TASK:
Task: {{task}}

Respond with ONLY JSON (same format as examples):`,
};

/**
 * Get atomicity prompt with task substituted
 */
export function getAtomicityPrompt(task: string, variant: keyof typeof ATOMICITY_PROMPT_VARIANTS = "baseline"): string {
	return ATOMICITY_PROMPT_VARIANTS[variant].replace("{{task}}", task);
}

/**
 * Review prompt variants
 *
 * Different strategies for code review prompts.
 */
export const REVIEW_PROMPT_VARIANTS = {
	/**
	 * Baseline review - direct instruction
	 */
	baseline: `Review the code changes for: {{task}}

Current changes:
\`\`\`diff
{{diff}}
\`\`\`

Review for: bugs, edge cases, security issues, incomplete implementation.
If you find issues, FIX THEM directly using the Edit tool.

After reviewing:
- If you fixed issues: ISSUES FIXED: [summary]
- If no issues found: LGTM - Ready to commit`,

	/**
	 * Chain-of-thought review
	 * Structured review process
	 */
	chainOfThought: `Review the code changes systematically.

Task: {{task}}

Changes:
\`\`\`diff
{{diff}}
\`\`\`

REVIEW CHECKLIST (evaluate each):
1. CORRECTNESS: Does the implementation match the task requirements?
2. EDGE CASES: What inputs could cause failures? Are they handled?
3. SECURITY: Any injection, auth bypass, or data exposure risks?
4. COMPLETENESS: Is anything missing from the implementation?
5. PATTERNS: Does it follow existing codebase conventions?

For each issue found, FIX IT directly using the Edit tool.
If unable to fix, report the issue clearly.

Final status:
- ISSUES FIXED: [what was fixed]
- LGTM - Ready to commit (if no issues)`,

	/**
	 * Signature-based review
	 * Clear output contract
	 */
	signatureBased: `Review code changes with structured output.

INPUT:
- task: {{task}}
- diff: {{diff}}

REVIEW FOCUS:
- Bugs and logic errors
- Missing edge case handling
- Security vulnerabilities
- Incomplete implementation

OUTPUT CONTRACT (exactly one):
- ISSUES_FIXED: {fixed: string[], remaining: string[]}
- LGTM: {confidence: "high" | "medium", notes?: string}
- BLOCKED: {reason: string, requires: string}

For issues found, apply fixes using Edit tool before reporting.
Only report LGTM if code is genuinely ready to commit.`,
};

/**
 * Get review prompt with substitutions
 */
export function getReviewPrompt(
	task: string,
	diff: string,
	variant: keyof typeof REVIEW_PROMPT_VARIANTS = "baseline",
): string {
	return REVIEW_PROMPT_VARIANTS[variant].replace("{{task}}", task).replace("{{diff}}", diff);
}
