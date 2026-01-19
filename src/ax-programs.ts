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
import { type AxAIService, AxGen, AxSignature } from "@ax-llm/ax";
import { getAxAgentSDK } from "./ax-agent-sdk.js";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "ax-programs" });

// ============================================================================
// Project Language Detection
// ============================================================================

/**
 * Detected project language and framework information
 */
export interface ProjectContext {
	language: "typescript" | "javascript" | "python" | "go" | "rust" | "unknown";
	framework?: string;
	packageManager?: string;
	fileExtensions: string[];
}

/**
 * Detect project language from common project files
 * @param cwd Working directory to check (defaults to process.cwd())
 */
export function detectProjectLanguage(cwd: string = process.cwd()): ProjectContext {
	// TypeScript/JavaScript
	if (existsSync(join(cwd, "package.json"))) {
		const hasTS =
			existsSync(join(cwd, "tsconfig.json")) ||
			existsSync(join(cwd, "tsconfig.build.json")) ||
			existsSync(join(cwd, "src/index.ts"));

		// Detect package manager
		let packageManager = "npm";
		if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
		else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn";
		else if (existsSync(join(cwd, "bun.lockb"))) packageManager = "bun";

		// Detect framework
		let framework: string | undefined;
		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if (deps.next) framework = "Next.js";
			else if (deps.react) framework = "React";
			else if (deps.vue) framework = "Vue";
			else if (deps.express) framework = "Express";
			else if (deps["@nestjs/core"]) framework = "NestJS";
		} catch {
			// Ignore package.json parse errors
		}

		return {
			language: hasTS ? "typescript" : "javascript",
			framework,
			packageManager,
			fileExtensions: hasTS ? [".ts", ".tsx", ".js", ".jsx"] : [".js", ".jsx"],
		};
	}

	// Python
	if (
		existsSync(join(cwd, "requirements.txt")) ||
		existsSync(join(cwd, "pyproject.toml")) ||
		existsSync(join(cwd, "setup.py"))
	) {
		let framework: string | undefined;
		if (existsSync(join(cwd, "manage.py"))) framework = "Django";
		else if (existsSync(join(cwd, "app.py")) || existsSync(join(cwd, "main.py"))) {
			// Could be FastAPI, Flask, etc.
		}

		return {
			language: "python",
			framework,
			packageManager: existsSync(join(cwd, "poetry.lock")) ? "poetry" : "pip",
			fileExtensions: [".py"],
		};
	}

	// Go
	if (existsSync(join(cwd, "go.mod"))) {
		return {
			language: "go",
			packageManager: "go mod",
			fileExtensions: [".go"],
		};
	}

	// Rust
	if (existsSync(join(cwd, "Cargo.toml"))) {
		return {
			language: "rust",
			packageManager: "cargo",
			fileExtensions: [".rs"],
		};
	}

	return {
		language: "unknown",
		fileExtensions: [],
	};
}

/**
 * Format project context as a string for prompts
 */
export function formatProjectContext(ctx: ProjectContext): string {
	const parts = [`Language: ${ctx.language}`];
	if (ctx.framework) parts.push(`Framework: ${ctx.framework}`);
	if (ctx.packageManager) parts.push(`Package Manager: ${ctx.packageManager}`);
	parts.push(`File Extensions: ${ctx.fileExtensions.join(", ")}`);
	return parts.join("\n");
}

// ============================================================================
// Subtask Filtering
// ============================================================================

/**
 * Patterns that indicate a subtask is actually a question/clarification request
 * These should be handled by PM decision-making, not converted to subtasks
 */
const INVALID_SUBTASK_PATTERNS = [
	/^clarify\b/i, // "Clarify project context..."
	/^determine\s+(if|whether)\b/i, // "Determine if..."
	/^define\s+what\b/i, // "Define what 'X' means..."
	/^define\s+\w+\s+means\b/i, // "Define scope means..."
	/\?$/, // Ends with question mark
	/^is\s+this\b/i, // "Is this for..."
	/^what\s+(is|are|should|does)\b/i, // "What is the..." "What should..." "What does..."
	/^how\s+(should|do|does|will|would|can)\b/i, // "How should we..." "How do we..."
	/^where\s+(should|is|are|do)\b/i, // "Where should..." "Where is..."
	/^which\s+(one|approach)\b/i, // "Which one..." "Which approach..."
	/^should\s+(we|i|the)\b/i, // "Should we..."
	/^do\s+we\s+(need|have|want)\b/i, // "Do we need..."
	/^confirm\b/i, // "Confirm the..."
	/^verify\s+with\b/i, // "Verify with stakeholder..."
	/^ask\s+(the|about)\b/i, // "Ask the user..."
	/^check\s+with\b/i, // "Check with..."
	// Numbered questions (e.g., "1. Clarify...", "2. Define what...")
	/^\d+\.\s*(clarify|determine|confirm|ask|check|define\s+what|is\s+this|what|how\s+should|where)\b/i,
];

/**
 * Filter out question-like subtasks from decomposition output
 * Questions should be handled by PM decisions, not as subtasks
 */
export function filterQuestionSubtasks(subtasks: string[]): string[] {
	return subtasks.filter((subtask) => {
		const trimmed = subtask.trim();
		// Check each invalid pattern
		for (const pattern of INVALID_SUBTASK_PATTERNS) {
			if (pattern.test(trimmed)) {
				logger.debug({ subtask: trimmed.slice(0, 50), pattern: pattern.source }, "Filtered question-like subtask");
				return false;
			}
		}
		return true;
	});
}

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
	confidence:number "DECIMAL NUMBER ONLY between 0.0 and 1.0, e.g. 0.85",
	estimatedFiles:number "Integer count of files to modify, e.g. 3",
	recommendedModel:string "haiku, sonnet, or opus"`,
);

/**
 * Task decomposition signature
 * Input: complex task + project context
 * Output: list of atomic subtasks
 */
export const DecompositionSignature = AxSignature.create(
	`task:string "The complex task to decompose",
	projectContext:string "Project language, framework, and file extensions" ->
	reasoning:string "Analysis of what needs to be done and why this decomposition makes sense",
	subtasks:string[] "List of atomic subtask objectives with file paths using correct extensions"`,
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
	confidence:number "DECIMAL NUMBER ONLY between 0.0 and 1.0, e.g. 0.75"`,
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
	confidence:number "DECIMAL NUMBER ONLY between 0.0 and 1.0, e.g. 0.80"`,
);

/**
 * Plan creation signature
 * Input: task and pre-gathered context
 * Output: structured execution plan
 */
export const PlanCreationSignature = AxSignature.create(
	`task:string "The coding task to plan",
	contextBriefing:string "Pre-gathered context: target files, types, learnings" ->
	reasoning:string "Analysis of the task and approach",
	filesToRead:string[] "Files to read for context",
	filesToModify:string[] "Files that will be changed",
	filesToCreate:string[] "New files to create if any",
	steps:string[] "Step-by-step implementation approach",
	risks:string[] "Potential issues or edge cases",
	expectedOutcome:string "What success looks like",
	alreadyComplete:boolean "Task appears to already be done",
	alreadyCompleteReason:string "Why task appears done if alreadyComplete is true",
	needsDecomposition:boolean "Task is too large and needs breaking down",
	suggestedSubtasks:string[] "Subtasks if needsDecomposition is true"`,
);

/**
 * Plan review signature
 * Input: task and proposed plan
 * Output: review assessment with approval/issues
 */
export const PlanReviewSignature = AxSignature.create(
	`task:string "The original coding task",
	plan:string "The proposed execution plan as JSON" ->
	reasoning:string "Analysis of plan quality and completeness",
	approved:boolean "Plan is ready for execution",
	issues:string[] "Problems found with the plan",
	suggestions:string[] "Improvements to consider",
	skipExecution:boolean "Task should be skipped entirely",
	skipReason:string "Why execution should be skipped if skipExecution is true"`,
);

// ============================================================================
// Program Instances
// ============================================================================

/**
 * Get the Ax AI instance
 *
 * Uses AxAgentSDK which wraps the Claude Agent SDK for Claude Max OAuth auth.
 * No API key required - uses the same auth as the rest of undercity.
 */
export function createAxAI(): AxAIService {
	return getAxAgentSDK();
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

CRITICAL - READ projectContext FIRST:
The projectContext field tells you EXACTLY what language this project uses.
You MUST use the file extensions from projectContext.fileExtensions.
NEVER use extensions from a different language than projectContext.language.

LANGUAGE RULES:
- If projectContext says "typescript" → use ONLY .ts/.tsx (NEVER .py, .go, .rs)
- If projectContext says "python" → use ONLY .py (NEVER .ts, .js)
- If projectContext says "go" → use ONLY .go
- If projectContext says "rust" → use ONLY .rs
- VIOLATION: Using wrong language extensions = TASK FAILURE

SUBTASK RULES:
1. Each subtask should modify 1 file (2-3 max for tightly coupled changes)
2. INCLUDE FILE PATH in each objective: "In src/auth.ts, add validation..."
3. Make objectives specific and unambiguous
4. Create 2-5 subtasks (fewer is better)
5. Order by dependency (prerequisites first)

EXAMPLE (when projectContext.language = "typescript"):
GOOD: "In src/types.ts, add the UserRole enum with values ADMIN, USER, GUEST"
BAD: "In types.py, add UserRole class" ← WRONG! Project is TypeScript, not Python!

EXAMPLE (when projectContext.language = "python"):
GOOD: "In src/models.py, add the UserRole class"
BAD: "In src/models.ts, add the UserRole type" ← WRONG! Project is Python, not TypeScript!

Think through the task structure in the reasoning field before listing subtasks.
Verify each subtask uses correct file extensions for the projectContext.language.`);
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

/**
 * Plan creator program
 * Creates structured execution plans from task + context
 */
export function createPlanCreator(): AxGen {
	const gen = new AxGen(PlanCreationSignature);
	gen.setInstruction(`You create execution plans for coding tasks.

PLANNING RULES:
1. Use the pre-gathered context - don't duplicate exploration work
2. Be specific about files: include exact paths
3. Steps should be concrete and actionable
4. Identify risks proactively
5. If task is done, set alreadyComplete=true with reason
6. If task is too big, set needsDecomposition=true with subtasks

GOOD PLAN:
- filesToModify: ["src/auth.ts", "src/types.ts"]
- steps: ["Add UserRole enum to types.ts", "Import UserRole in auth.ts", "Add role check to validateUser"]

BAD PLAN:
- filesToModify: ["somewhere"]
- steps: ["Update the code", "Fix things"]

Think through your approach in the reasoning field first.`);
	return gen;
}

/**
 * Plan reviewer program
 * Reviews execution plans for quality and completeness
 */
export function createPlanReviewer(): AxGen {
	const gen = new AxGen(PlanReviewSignature);
	gen.setInstruction(`You review execution plans for coding tasks.

REVIEW CRITERIA:
1. Do referenced files exist? (Check paths are plausible)
2. Are steps specific and actionable?
3. Is scope appropriate? (not too big, not trivial)
4. Are obvious risks identified?
5. Is the approach sound?

SET approved=false if:
- Files look wrong (e.g., referencing src/services/ when none exists)
- Steps are vague ("update the code")
- Missing obvious considerations
- Scope is too large for one task

SET skipExecution=true if:
- Task appears already done
- Task is invalid (references non-existent things)
- Task is duplicate of another

Provide specific, actionable feedback in issues/suggestions.
Think through your analysis in the reasoning field.`);
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
 * @param task The task to decompose
 * @param stateDir State directory (default: .undercity)
 * @param cwd Working directory for project detection (default: process.cwd())
 */
export async function decomposeTaskAx(
	task: string,
	stateDir: string = ".undercity",
	cwd: string = process.cwd(),
): Promise<{
	subtasks: string[];
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		// Load program with examples from past successful runs
		const decomposer = createTaskDecomposerWithExamples(stateDir);

		// Detect project language to provide context
		const projectCtx = detectProjectLanguage(cwd);
		const projectContext = formatProjectContext(projectCtx);

		logger.debug({ task: task.slice(0, 50), projectContext }, "Running decomposition with project context");

		const result = await decomposer.forward(ai, { task, projectContext });

		// Filter out question-like subtasks (these should be PM decisions, not subtasks)
		const rawSubtasks = Array.isArray(result.subtasks) ? result.subtasks.map(String) : [];
		const filteredSubtasks = filterQuestionSubtasks(rawSubtasks);

		if (filteredSubtasks.length < rawSubtasks.length) {
			logger.info(
				{ filtered: rawSubtasks.length - filteredSubtasks.length },
				"Filtered out question-like subtasks from decomposition",
			);
		}

		const output = {
			subtasks: filteredSubtasks,
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

/**
 * Create execution plan using Ax program
 * Returns structured plan from task + context
 */
export async function createPlanAx(
	task: string,
	contextBriefing: string,
	stateDir: string = ".undercity",
): Promise<{
	filesToRead: string[];
	filesToModify: string[];
	filesToCreate: string[];
	steps: string[];
	risks: string[];
	expectedOutcome: string;
	alreadyComplete: boolean;
	alreadyCompleteReason: string;
	needsDecomposition: boolean;
	suggestedSubtasks: string[];
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		const creator = createPlanCreatorWithExamples(stateDir);

		const result = await creator.forward(ai, { task, contextBriefing });

		// Filter out question-like subtasks from suggested decomposition
		const rawSubtasks = Array.isArray(result.suggestedSubtasks) ? result.suggestedSubtasks.map(String) : [];
		const filteredSubtasks = filterQuestionSubtasks(rawSubtasks);

		const output = {
			filesToRead: Array.isArray(result.filesToRead) ? result.filesToRead.map(String) : [],
			filesToModify: Array.isArray(result.filesToModify) ? result.filesToModify.map(String) : [],
			filesToCreate: Array.isArray(result.filesToCreate) ? result.filesToCreate.map(String) : [],
			steps: Array.isArray(result.steps) ? result.steps.map(String) : [],
			risks: Array.isArray(result.risks) ? result.risks.map(String) : [],
			expectedOutcome: String(result.expectedOutcome || "Task completion"),
			alreadyComplete: Boolean(result.alreadyComplete),
			alreadyCompleteReason: String(result.alreadyCompleteReason || ""),
			needsDecomposition: Boolean(result.needsDecomposition),
			suggestedSubtasks: filteredSubtasks,
			reasoning: String(result.reasoning || ""),
		};

		logger.debug({ task: task.slice(0, 50), filesCount: output.filesToModify.length }, "Ax plan creation complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax plan creation failed, using defaults");
		return {
			filesToRead: [],
			filesToModify: [],
			filesToCreate: [],
			steps: ["Execute the task as described"],
			risks: ["Ax planning failed - proceeding with minimal plan"],
			expectedOutcome: "Task completion",
			alreadyComplete: false,
			alreadyCompleteReason: "",
			needsDecomposition: false,
			suggestedSubtasks: [],
			reasoning: `Ax planning failed: ${error}`,
		};
	}
}

/**
 * Review execution plan using Ax program
 * Returns structured review assessment
 */
export async function reviewPlanAx(
	task: string,
	plan: string,
	stateDir: string = ".undercity",
): Promise<{
	approved: boolean;
	issues: string[];
	suggestions: string[];
	skipExecution: boolean;
	skipReason: string;
	reasoning: string;
}> {
	try {
		const ai = createAxAI();
		const reviewer = createPlanReviewerWithExamples(stateDir);

		const result = await reviewer.forward(ai, { task, plan });

		const output = {
			approved: Boolean(result.approved),
			issues: Array.isArray(result.issues) ? result.issues.map(String) : [],
			suggestions: Array.isArray(result.suggestions) ? result.suggestions.map(String) : [],
			skipExecution: Boolean(result.skipExecution),
			skipReason: String(result.skipReason || ""),
			reasoning: String(result.reasoning || ""),
		};

		logger.debug({ task: task.slice(0, 50), approved: output.approved }, "Ax plan review complete");

		return output;
	} catch (error) {
		logger.warn({ error: String(error) }, "Ax plan review failed, approving by default");
		return {
			approved: true,
			issues: ["Ax review failed - approving by default"],
			suggestions: [],
			skipExecution: false,
			skipReason: "",
			reasoning: `Ax review failed: ${error}`,
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

/**
 * Record plan creation outcome for training
 */
export function recordPlanCreationOutcome(
	input: {
		task: string;
		contextBriefing: string;
	},
	result: {
		filesToRead: string[];
		filesToModify: string[];
		filesToCreate: string[];
		steps: string[];
		risks: string[];
		expectedOutcome: string;
		alreadyComplete: boolean;
		needsDecomposition: boolean;
		reasoning: string;
	},
	taskSucceeded: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("planCreation", input, result, taskSucceeded ? "success" : "failure", stateDir);
}

/**
 * Record plan review outcome for training
 */
export function recordPlanReviewOutcome(
	input: {
		task: string;
		plan: string;
	},
	result: {
		approved: boolean;
		issues: string[];
		suggestions: string[];
		skipExecution: boolean;
		reasoning: string;
	},
	reviewAccurate: boolean,
	stateDir: string = ".undercity",
): void {
	saveExample("planReview", input, result, reviewAccurate ? "success" : "failure", stateDir);
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
	planCreation: { total: number; successful: number };
	planReview: { total: number; successful: number };
} {
	const programs = [
		"atomicity",
		"decomposition",
		"decision",
		"complexity",
		"reviewTriage",
		"planCreation",
		"planReview",
	] as const;
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
		planCreation: { total: number; successful: number };
		planReview: { total: number; successful: number };
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

/**
 * Create plan creator with few-shot examples loaded
 */
export function createPlanCreatorWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createPlanCreator();
	const examples = getTrainingExamples<
		{ task: string; contextBriefing: string },
		{
			filesToRead: string[];
			filesToModify: string[];
			filesToCreate: string[];
			steps: string[];
			risks: string[];
			expectedOutcome: string;
			alreadyComplete: boolean;
			needsDecomposition: boolean;
			reasoning: string;
		}
	>("planCreation", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded plan creation examples for few-shot learning");
	}

	return gen;
}

/**
 * Create plan reviewer with few-shot examples loaded
 */
export function createPlanReviewerWithExamples(stateDir: string = ".undercity"): AxGen {
	const gen = createPlanReviewer();
	const examples = getTrainingExamples<
		{ task: string; plan: string },
		{
			approved: boolean;
			issues: string[];
			suggestions: string[];
			skipExecution: boolean;
			reasoning: string;
		}
	>("planReview", 10, stateDir);

	if (examples.length > 0) {
		gen.setExamples(examples);
		logger.info({ count: examples.length }, "Loaded plan review examples for few-shot learning");
	}

	return gen;
}
