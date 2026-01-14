/**
 * Ax/DSPy Programs for Undercity
 *
 * Wraps key prompts in Ax signatures for:
 * 1. Type-safe input/output
 * 2. Automatic prompt optimization from examples
 * 3. Self-improvement based on task outcomes
 *
 * Programs:
 * - AtomicityChecker: Is this task atomic? What model should run it?
 * - TaskDecomposer: Break complex task into atomic subtasks
 * - DecisionMaker: Make PM judgment calls
 *
 * Training data comes from task outcomes already tracked in:
 * - .undercity/task-file-patterns.json (success/failure by task)
 * - .undercity/decisions.json (decision outcomes)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxAI, AxGen, AxSignature } from "@ax-llm/ax";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "ax-programs" });

// ============================================================================
// Program Signatures
// ============================================================================

/**
 * Atomicity check signature
 * Input: task description
 * Output: atomicity assessment with model recommendation
 */
export const AtomicitySignature = AxSignature.create(
	`task:string "The coding task to assess" ->
	reasoning:string "Step-by-step analysis of the task",
	isAtomic:boolean "Can this be completed in a single focused session?",
	confidence:number "Confidence in assessment (0-1)",
	estimatedFiles:number "Estimated number of files to modify",
	recommendedModel:string "haiku, sonnet, or opus"`,
);

/**
 * Task decomposition signature
 * Input: complex task
 * Output: list of atomic subtasks
 */
export const DecompositionSignature = AxSignature.create(
	`task:string "The complex task to decompose" ->
	reasoning:string "Analysis of what needs to be done and why this decomposition makes sense",
	subtasks:string[] "List of atomic subtask objectives with file paths"`,
);

/**
 * PM decision signature
 * Input: decision context
 * Output: decision with confidence
 */
export const DecisionSignature = AxSignature.create(
	`question:string "The decision question",
	context:string "Surrounding context",
	options:string "Available options if any",
	similarDecisions:string "Past similar decisions and outcomes",
	relevantKnowledge:string "Related knowledge from past tasks" ->
	reasoning:string "Step-by-step analysis of the decision",
	decision:string "What to do",
	confidence:string "high, medium, or low",
	escalate:boolean "Should this go to human?"`,
);

/**
 * Complexity assessment signature
 * Input: task description
 * Output: complexity level, scope, and reasoning
 */
export const ComplexitySignature = AxSignature.create(
	`task:string "The coding task to assess for complexity" ->
	reasoning:string "Step-by-step analysis of task complexity",
	level:string "trivial, simple, standard, complex, or critical",
	scope:string "single-file, few-files, many-files, or cross-package",
	confidence:number "Confidence in assessment (0-1)"`,
);

/**
 * Review triage signature
 * Input: task and diff
 * Output: review strategy recommendations
 */
export const ReviewTriageSignature = AxSignature.create(
	`task:string "The coding task that was implemented",
	diff:string "Git diff of the changes" ->
	reasoning:string "Analysis of the changes and potential issues",
	riskLevel:string "low, medium, high, or critical",
	focusAreas:string[] "Specific areas to focus review on",
	suggestedTier:string "haiku, sonnet, or opus - starting review tier",
	confidence:number "Confidence in assessment (0-1)"`,
);

// ============================================================================
// Program Instances
// ============================================================================

/**
 * Create an Ax AI instance configured for Anthropic
 */
export function createAxAI(): AxAI {
	return new AxAI({
		name: "anthropic",
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
}

/**
 * Atomicity checker program
 * Uses reasoning field for chain-of-thought style output
 */
export function createAtomicityChecker(): AxGen {
	const gen = new AxGen(AtomicitySignature);
	gen.setInstruction(`You assess coding tasks for atomicity and model assignment.

ATOMICITY RULES:
- ATOMIC (true): Single file change, OR 2-3 closely related files with ONE clear objective
- NOT ATOMIC (false): Multiple unrelated changes, vague scope, "and" connecting different actions

MODEL SELECTION:
- "haiku": Trivial mechanical changes - typos, comments, simple renames
- "sonnet": Most tasks - bug fixes, features, anything requiring judgment
- "opus": Architectural changes, multi-system integration, ambiguous requirements

DEFAULT TO SONNET unless clearly trivial.

Think step by step in the reasoning field before giving your final assessment.`);
	return gen;
}

/**
 * Task decomposer program
 */
export function createTaskDecomposer(): AxGen {
	const gen = new AxGen(DecompositionSignature);
	gen.setInstruction(`You break complex tasks into atomic subtasks.

RULES:
1. Each subtask should modify 1 file (2-3 max for tightly coupled changes)
2. INCLUDE FILE PATH in each objective: "In src/auth.ts, add validation..."
3. Make objectives specific and unambiguous
4. Create 2-5 subtasks (fewer is better)
5. Order by dependency (prerequisites first)

GOOD: "In src/types.ts, add the UserRole enum with values ADMIN, USER, GUEST"
BAD: "Update the types" (which file? what types?)

Think through the task structure in the reasoning field before listing subtasks.`);
	return gen;
}

/**
 * Decision maker program
 */
export function createDecisionMaker(): AxGen {
	const gen = new AxGen(DecisionSignature);
	gen.setInstruction(`You are an automated Product Manager making judgment calls.

GOAL: Keep the system running efficiently without human intervention.

GUIDELINES:
- Favor simpler, less risky approaches
- Follow patterns from successful past decisions
- Be decisive - avoid analysis paralysis

SET escalate=true ONLY if:
- Security/auth/payments involved
- Could cause data loss
- Genuinely 50/50 decision
- Breaking backwards compatibility

Think through your analysis in the reasoning field before making a decision.`);
	return gen;
}

/**
 * Complexity assessor program
 * Uses reasoning field for chain-of-thought analysis
 */
export function createComplexityAssessor(): AxGen {
	const gen = new AxGen(ComplexitySignature);
	gen.setInstruction(`You assess the complexity of coding tasks.

COMPLEXITY LEVELS:
- trivial: Minimal changes - typos, comments, version bumps
- simple: Small localized changes - add a log, single function updates
- standard: Typical feature work - bug fixes, new features, tests
- complex: Significant changes - refactoring, multi-file architectural changes
- critical: High-risk changes - security, auth, payments, breaking changes

SCOPE:
- single-file: Change affects only one file
- few-files: 2-5 related files
- many-files: More than 5 files
- cross-package: Changes span multiple packages/modules

Think step by step in the reasoning field before giving your assessment.
Be conservative - err on the side of higher complexity when uncertain.`);
	return gen;
}

/**
 * Review triage program
 * Analyzes code changes to recommend review strategy
 */
export function createReviewTriager(): AxGen {
	const gen = new AxGen(ReviewTriageSignature);
	gen.setInstruction(`You triage code changes to recommend an appropriate review strategy.

RISK LEVELS:
- low: Trivial changes, typos, comments, style-only
- medium: Standard bug fixes, small features, localized changes
- high: Security-related, auth, data handling, cross-cutting changes
- critical: Breaking changes, production data, payments, compliance

REVIEW TIERS:
- haiku: Fast, cheap - good for low-risk, style, trivial issues
- sonnet: Balanced - good for standard features, bugs, medium complexity
- opus: Thorough - for security, architectural, high-stakes changes

FOCUS AREAS to identify:
- Security vulnerabilities (injection, auth bypass, etc.)
- Error handling gaps
- Edge cases not covered
- Missing validation
- Breaking API changes
- Performance regressions

Analyze the diff carefully and think step by step before recommending a strategy.`);
	return gen;
}

// ============================================================================
// Example Collection & Storage
// ============================================================================

interface Example<I, O> {
	input: I;
	output: O;
	outcome: "success" | "failure";
	timestamp: string;
}

interface ExampleStore<I, O> {
	program: string;
	examples: Example<I, O>[];
	lastOptimized?: string;
}

function getExamplesPath(programName: string, stateDir: string = ".undercity"): string {
	return join(stateDir, "ax-examples", `${programName}.json`);
}

/**
 * Load examples for a program
 */
export function loadExamples<I, O>(programName: string, stateDir: string = ".undercity"): ExampleStore<I, O> {
	const path = getExamplesPath(programName, stateDir);

	if (!existsSync(path)) {
		return { program: programName, examples: [] };
	}

	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { program: programName, examples: [] };
	}
}

/**
 * Save an example for a program
 */
export function saveExample<I, O>(
	programName: string,
	input: I,
	output: O,
	outcome: "success" | "failure",
	stateDir: string = ".undercity",
): void {
	const path = getExamplesPath(programName, stateDir);
	const dir = join(stateDir, "ax-examples");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const store = loadExamples<I, O>(programName, stateDir);

	store.examples.push({
		input,
		output,
		outcome,
		timestamp: new Date().toISOString(),
	});

	// Keep last 500 examples
	if (store.examples.length > 500) {
		store.examples = store.examples.slice(-500);
	}

	writeFileSync(path, JSON.stringify(store, null, 2));
	logger.debug({ programName, exampleCount: store.examples.length }, "Saved Ax example");
}

/**
 * Get successful examples for training
 */
export function getTrainingExamples<I, O>(
	programName: string,
	limit: number = 50,
	stateDir: string = ".undercity",
): Array<{ input: I; output: O }> {
	const store = loadExamples<I, O>(programName, stateDir);

	return store.examples
		.filter((e) => e.outcome === "success")
		.slice(-limit)
		.map((e) => ({ input: e.input, output: e.output }));
}

// ============================================================================
// Integration Functions
// ============================================================================

/**
 * Run atomicity check using Ax program
 * Loads successful examples as few-shot demos for self-improvement
 */
export async function checkAtomicityAx(
	task: string,
	stateDir: string = ".undercity",
): Promise<{
	isAtomic: boolean;
	confidence: number;
	estimatedFiles: number;
	recommendedModel: "haiku" | "sonnet" | "opus";
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const checker = createAtomicityCheckerWithExamples(stateDir);

		const result = await checker.forward(ai, { task });

		// Normalize model recommendation
		const validModels = ["haiku", "sonnet", "opus"] as const;
		const rawModel = String(result.recommendedModel || "sonnet").toLowerCase();
		const recommendedModel = validModels.includes(rawModel as (typeof validModels)[number])
			? (rawModel as "haiku" | "sonnet" | "opus")
			: "sonnet";

		const output = {
			isAtomic: Boolean(result.isAtomic),
			confidence: Number(result.confidence) || 0.5,
			estimatedFiles: Number(result.estimatedFiles) || 1,
			recommendedModel,
			reasoning: String(result.reasoning || ""),
		};

		logger.debug({ task: task.slice(0, 50), output }, "Ax atomicity check complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax atomicity check failed, using defaults");
		return {
			isAtomic: true,
			confidence: 0.3,
			estimatedFiles: 1,
			recommendedModel: "sonnet",
			reasoning: "Ax check failed, defaulting to atomic",
		};
	}
}

/**
 * Run task decomposition using Ax program
 * Loads successful examples as few-shot demos for self-improvement
 */
export async function decomposeTaskAx(
	task: string,
	stateDir: string = ".undercity",
): Promise<{
	subtasks: string[];
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const decomposer = createTaskDecomposerWithExamples(stateDir);

		const result = await decomposer.forward(ai, { task });

		const output = {
			subtasks: Array.isArray(result.subtasks) ? result.subtasks.map(String) : [],
			reasoning: String(result.reasoning || ""),
		};

		logger.debug({ task: task.slice(0, 50), subtaskCount: output.subtasks.length }, "Ax decomposition complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax decomposition failed");
		return {
			subtasks: [],
			reasoning: `Ax decomposition failed: ${error}`,
		};
	}
}

/**
 * Run PM decision using Ax program
 * Loads successful examples as few-shot demos for self-improvement
 */
export async function makeDecisionAx(
	question: string,
	context: string,
	options: string,
	similarDecisions: string,
	relevantKnowledge: string,
	stateDir: string = ".undercity",
): Promise<{
	decision: string;
	reasoning: string;
	confidence: "high" | "medium" | "low";
	escalate: boolean;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const decider = createDecisionMakerWithExamples(stateDir);

		const result = await decider.forward(ai, {
			question,
			context,
			options,
			similarDecisions,
			relevantKnowledge,
		});

		const validConfidence = ["high", "medium", "low"] as const;
		const rawConfidence = String(result.confidence || "medium").toLowerCase();
		const confidence = validConfidence.includes(rawConfidence as (typeof validConfidence)[number])
			? (rawConfidence as "high" | "medium" | "low")
			: "medium";

		const output = {
			decision: String(result.decision || "proceed"),
			reasoning: String(result.reasoning || ""),
			confidence,
			escalate: Boolean(result.escalate),
		};

		logger.debug({ question: question.slice(0, 50), output }, "Ax decision complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax decision failed, escalating");
		return {
			decision: "escalate due to error",
			reasoning: `Ax decision failed: ${error}`,
			confidence: "low",
			escalate: true,
		};
	}
}

/**
 * Run complexity assessment using Ax program
 * Loads successful examples as few-shot demos for self-improvement
 */
export async function checkComplexityAx(
	task: string,
	stateDir: string = ".undercity",
): Promise<{
	level: "trivial" | "simple" | "standard" | "complex" | "critical";
	scope: "single-file" | "few-files" | "many-files" | "cross-package";
	reasoning: string;
	confidence: number;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const assessor = createComplexityAssessorWithExamples(stateDir);

		const result = await assessor.forward(ai, { task });

		// Normalize level
		const validLevels = ["trivial", "simple", "standard", "complex", "critical"] as const;
		const rawLevel = String(result.level || "standard").toLowerCase();
		const level = validLevels.includes(rawLevel as (typeof validLevels)[number])
			? (rawLevel as (typeof validLevels)[number])
			: "standard";

		// Normalize scope
		const validScopes = ["single-file", "few-files", "many-files", "cross-package"] as const;
		const rawScope = String(result.scope || "few-files").toLowerCase();
		const scope = validScopes.includes(rawScope as (typeof validScopes)[number])
			? (rawScope as (typeof validScopes)[number])
			: "few-files";

		const output = {
			level,
			scope,
			reasoning: String(result.reasoning || ""),
			confidence: Number(result.confidence) || 0.5,
		};

		logger.debug({ task: task.slice(0, 50), output }, "Ax complexity assessment complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax complexity assessment failed, using defaults");
		return {
			level: "standard",
			scope: "few-files",
			reasoning: `Ax assessment failed: ${error}`,
			confidence: 0.3,
		};
	}
}

/**
 * Run review triage using Ax program
 * Loads successful examples as few-shot demos for self-improvement
 */
export async function triageReviewAx(
	task: string,
	diff: string,
	stateDir: string = ".undercity",
): Promise<{
	riskLevel: "low" | "medium" | "high" | "critical";
	focusAreas: string[];
	suggestedTier: "haiku" | "sonnet" | "opus";
	reasoning: string;
	confidence: number;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const triager = createReviewTriagerWithExamples(stateDir);

		// Truncate diff to avoid token limits
		const truncatedDiff = diff.length > 8000 ? `${diff.slice(0, 8000)}\n... (truncated)` : diff;

		const result = await triager.forward(ai, { task, diff: truncatedDiff });

		// Normalize risk level
		const validRiskLevels = ["low", "medium", "high", "critical"] as const;
		const rawRiskLevel = String(result.riskLevel || "medium").toLowerCase();
		const riskLevel = validRiskLevels.includes(rawRiskLevel as (typeof validRiskLevels)[number])
			? (rawRiskLevel as (typeof validRiskLevels)[number])
			: "medium";

		// Normalize suggested tier
		const validTiers = ["haiku", "sonnet", "opus"] as const;
		const rawTier = String(result.suggestedTier || "sonnet").toLowerCase();
		const suggestedTier = validTiers.includes(rawTier as (typeof validTiers)[number])
			? (rawTier as (typeof validTiers)[number])
			: "sonnet";

		// Normalize focus areas
		const focusAreas = Array.isArray(result.focusAreas) ? result.focusAreas.map(String) : [];

		const output = {
			riskLevel,
			focusAreas,
			suggestedTier,
			reasoning: String(result.reasoning || ""),
			confidence: Number(result.confidence) || 0.5,
		};

		logger.debug({ task: task.slice(0, 50), output }, "Ax review triage complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax review triage failed, using defaults");
		return {
			riskLevel: "medium",
			focusAreas: [],
			suggestedTier: "sonnet",
			reasoning: `Ax triage failed: ${error}`,
			confidence: 0.3,
		};
	}
}

// ============================================================================
// Example Recording Helpers
// ============================================================================

/**
 * Record atomicity check outcome for training
 */
export function recordAtomicityOutcome(
	task: string,
	result: {
		isAtomic: boolean;
		confidence: number;
		estimatedFiles: number;
		recommendedModel: string;
		reasoning: string;
	},
	taskSucceeded: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("atomicity", { task }, result, taskSucceeded ? "success" : "failure", stateDir);
}

/**
 * Record decomposition outcome for training
 */
export function recordDecompositionOutcome(
	task: string,
	subtasks: string[],
	reasoning: string,
	allSubtasksSucceeded: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample(
		"decomposition",
		{ task },
		{ subtasks, reasoning },
		allSubtasksSucceeded ? "success" : "failure",
		stateDir,
	);
}

/**
 * Record PM decision outcome for training
 */
export function recordDecisionOutcome(
	input: {
		question: string;
		context: string;
		options: string;
		similarDecisions: string;
		relevantKnowledge: string;
	},
	output: {
		decision: string;
		reasoning: string;
		confidence: string;
		escalate: boolean;
	},
	outcomeGood: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("decision", input, output, outcomeGood ? "success" : "failure", stateDir);
}

/**
 * Record complexity assessment outcome for training
 */
export function recordComplexityOutcome(
	task: string,
	result: {
		level: string;
		scope: string;
		reasoning: string;
		confidence: number;
	},
	taskSucceeded: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("complexity", { task }, result, taskSucceeded ? "success" : "failure", stateDir);
}

/**
 * Record review triage outcome for training
 */
export function recordReviewTriageOutcome(
	input: {
		task: string;
		diff: string;
	},
	result: {
		riskLevel: string;
		focusAreas: string[];
		suggestedTier: string;
		reasoning: string;
		confidence: number;
	},
	reviewSucceeded: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("reviewTriage", input, result, reviewSucceeded ? "success" : "failure", stateDir);
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Get stats about collected examples
 */
export function getAxProgramStats(stateDir: string = ".undercity"): {
	atomicity: { total: number; successful: number };
	decomposition: { total: number; successful: number };
	decision: { total: number; successful: number };
	complexity: { total: number; successful: number };
	reviewTriage: { total: number; successful: number };
} {
	const programs = ["atomicity", "decomposition", "decision", "complexity", "reviewTriage"] as const;
	const stats: Record<string, { total: number; successful: number }> = {};

	for (const prog of programs) {
		const store = loadExamples(prog, stateDir);
		stats[prog] = {
			total: store.examples.length,
			successful: store.examples.filter((e) => e.outcome === "success").length,
		};
	}

	return stats as {
		atomicity: { total: number; successful: number };
		decomposition: { total: number; successful: number };
		decision: { total: number; successful: number };
		complexity: { total: number; successful: number };
		reviewTriage: { total: number; successful: number };
	};
}

// ============================================================================
// Few-Shot Learning (apply examples to programs)
// ============================================================================

/**
 * Create atomicity checker with few-shot examples loaded
 */
export function createAtomicityCheckerWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createAtomicityChecker();
	const examples = getTrainingExamples<
		{ task: string },
		{
			isAtomic: boolean;
			confidence: number;
			estimatedFiles: number;
			recommendedModel: string;
			reasoning: string;
		}
	>("atomicity", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded atomicity examples for few-shot learning");
	}

	return gen;
}

/**
 * Create task decomposer with few-shot examples loaded
 */
export function createTaskDecomposerWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createTaskDecomposer();
	const examples = getTrainingExamples<
		{ task: string },
		{
			subtasks: string[];
			reasoning: string;
		}
	>("decomposition", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded decomposition examples for few-shot learning");
	}

	return gen;
}

/**
 * Create decision maker with few-shot examples loaded
 */
export function createDecisionMakerWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createDecisionMaker();
	const examples = getTrainingExamples<
		{
			question: string;
			context: string;
			options: string;
			similarDecisions: string;
			relevantKnowledge: string;
		},
		{
			decision: string;
			reasoning: string;
			confidence: string;
			escalate: boolean;
		}
	>("decision", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded decision examples for few-shot learning");
	}

	return gen;
}

/**
 * Create complexity assessor with few-shot examples loaded
 */
export function createComplexityAssessorWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createComplexityAssessor();
	const examples = getTrainingExamples<
		{ task: string },
		{
			level: string;
			scope: string;
			reasoning: string;
			confidence: number;
		}
	>("complexity", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded complexity examples for few-shot learning");
	}

	return gen;
}

/**
 * Create review triager with few-shot examples loaded
 */
export function createReviewTriagerWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createReviewTriager();
	const examples = getTrainingExamples<
		{ task: string; diff: string },
		{
			riskLevel: string;
			focusAreas: string[];
			suggestedTier: string;
			reasoning: string;
			confidence: number;
		}
	>("reviewTriage", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded review triage examples for few-shot learning");
	}

	return gen;
}
