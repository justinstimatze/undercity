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
 * Falls back to legacy implementation on error
 */
export async function checkAtomicityAx(
	task: string,
	_stateDir: string = ".undercity",
): Promise<{
	isAtomic: boolean;
	confidence: number;
	estimatedFiles: number;
	recommendedModel: "haiku" | "sonnet" | "opus";
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		const checker = createAtomicityChecker();

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
 */
export async function decomposeTaskAx(
	task: string,
	_stateDir: string = ".undercity",
): Promise<{
	subtasks: string[];
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		const decomposer = createTaskDecomposer();

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
 */
export async function makeDecisionAx(
	question: string,
	context: string,
	options: string,
	similarDecisions: string,
	relevantKnowledge: string,
	_stateDir: string = ".undercity",
): Promise<{
	decision: string;
	reasoning: string;
	confidence: "high" | "medium" | "low";
	escalate: boolean;
}> {
	try {
		const ai = createAxAI();
		const decider = createDecisionMaker();

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
} {
	const programs = ["atomicity", "decomposition", "decision"] as const;
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
	};
}
