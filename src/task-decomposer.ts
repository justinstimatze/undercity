/**
 * Task Decomposition Module
 *
 * Provides lazy complexity checking and task decomposition at pickup time.
 * Uses Ax/DSPy programs for self-improving prompts.
 *
 * Flow:
 * 1. Agent picks up task
 * 2. Quick atomicity check via Ax program
 * 3. If atomic → proceed with execution
 * 4. If not → decompose into subtasks, add to board
 * 5. Validate subtasks for quality (reject vague/research tasks)
 *
 * Training data collected in .undercity/ax-examples/ for prompt optimization.
 */

import { checkAtomicityAx, decomposeTaskAx } from "./ax-programs.js";
import { sessionLogger } from "./logger.js";

/** Maximum subtasks allowed per decomposition to prevent explosion */
const MAX_SUBTASKS = 5;

/** Minimum length for a subtask objective to be considered specific enough */
const MIN_SUBTASK_LENGTH = 30;

/** Patterns that indicate research/analysis tasks (no code output) */
const RESEARCH_PATTERNS = [
	/^identify\b/i,
	/^analyze\b/i,
	/^review\s+and\b/i,
	/^design\s+(?!.*\.(ts|js|tsx|jsx))/i,
	/^establish\b/i,
	/^determine\b/i,
	/^clarify\b/i,
	/^decide\b/i,
	/^research\b/i,
	/^examine\b/i,
	/^compile\b/i,
	/^conduct\b/i,
	/^document\s+(?!.*\.(ts|js|tsx|jsx))/i,
	// Added based on failure analysis - these patterns have high failure rates
	/^explore\b/i,
	/^investigate\b/i,
	/^study\b/i,
	/^understand\b/i,
	/^look\s+into\b/i,
	/^evaluate\b/i,
	/^assess\b/i,
	/^check\s+(?!and\s+(fix|update|add|create|implement))/i, // "check and fix" is OK
	/^verify\s+(?!and\s+(fix|update|add|create|implement))/i, // "verify and fix" is OK
];

/** Patterns that indicate actionable code tasks */
const ACTIONABLE_PATTERNS = [
	/\.(ts|js|tsx|jsx)[\s:,]/i, // File reference
	/(?:in|to|from)\s+src\//i, // src/ directory reference
	/(?:add|create|implement|update|modify|fix|refactor)\s+\w+\s+(?:in|to)\s+/i,
];

const logger = sessionLogger.child({ module: "task-decomposer" });

/**
 * Merge subtasks that target overlapping files into a single subtask.
 * Prevents parallel merge conflicts by ensuring file isolation between subtasks.
 */
export function mergeOverlappingSubtasks(subtasks: Subtask[]): Subtask[] {
	if (subtasks.length <= 1) return subtasks;

	// Build file-to-subtask-index map
	const fileToIndices = new Map<string, number[]>();
	for (let i = 0; i < subtasks.length; i++) {
		const files = subtasks[i].estimatedFiles ?? [];
		for (const file of files) {
			const normalized = file.toLowerCase();
			const existing = fileToIndices.get(normalized) ?? [];
			existing.push(i);
			fileToIndices.set(normalized, existing);
		}
	}

	// Build merge groups using union-find approach
	const parent = subtasks.map((_, i) => i);
	function find(x: number): number {
		if (parent[x] !== x) parent[x] = find(parent[x]);
		return parent[x];
	}
	function union(a: number, b: number): void {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	}

	for (const indices of fileToIndices.values()) {
		for (let i = 1; i < indices.length; i++) {
			union(indices[0], indices[i]);
		}
	}

	// Group subtasks by their root
	const groups = new Map<number, number[]>();
	for (let i = 0; i < subtasks.length; i++) {
		const root = find(i);
		const group = groups.get(root) ?? [];
		group.push(i);
		groups.set(root, group);
	}

	// Build merged subtasks
	const merged: Subtask[] = [];
	for (const indices of groups.values()) {
		if (indices.length === 1) {
			merged.push(subtasks[indices[0]]);
			continue;
		}

		// Merge multiple subtasks into one
		const parts = indices.map((i) => subtasks[i]);
		const combinedObjective = parts.map((s) => s.objective).join(" AND ");
		const allFiles = [...new Set(parts.flatMap((s) => s.estimatedFiles ?? []))];
		const minOrder = Math.min(...parts.map((s) => s.order));

		logger.info(
			{
				mergedCount: parts.length,
				files: allFiles,
				objectives: parts.map((s) => s.objective.substring(0, 40)),
			},
			"Merged overlapping subtasks to prevent file conflicts",
		);

		merged.push({
			objective: combinedObjective,
			estimatedFiles: allFiles,
			order: minOrder,
		});
	}

	// Re-sort by order
	merged.sort((a, b) => a.order - b.order);
	return merged;
}

/**
 * Result of atomicity check
 */
export interface AtomicityCheckResult {
	/** Whether the task can be completed in a single focused session */
	isAtomic: boolean;
	/** Confidence in the assessment (0-1) */
	confidence: number;
	/** Estimated number of files to modify */
	estimatedFiles: number;
	/** Brief reasoning */
	reasoning: string;
	/** Recommended starting model based on task complexity */
	recommendedModel: "haiku" | "sonnet" | "opus";
}

/**
 * A subtask decomposed from a larger task
 */
export interface Subtask {
	/** The subtask objective */
	objective: string;
	/** Estimated files this subtask will touch */
	estimatedFiles?: string[];
	/** Order/priority within the decomposition */
	order: number;
}

/**
 * Result of task decomposition
 */
export interface DecompositionResult {
	/** Whether decomposition was needed */
	wasDecomposed: boolean;
	/** Original task objective */
	originalTask: string;
	/** Subtasks if decomposed */
	subtasks: Subtask[];
	/** Why decomposition was needed (or why it wasn't) */
	reasoning: string;
	/** Subtasks that were filtered out during validation */
	filteredCount?: number;
}

/**
 * Result of subtask validation
 */
interface SubtaskValidation {
	isValid: boolean;
	reason?: string;
}

/**
 * Validate a single subtask for quality
 */
function validateSubtask(objective: string): SubtaskValidation {
	// Too short - likely vague
	if (objective.length < MIN_SUBTASK_LENGTH) {
		return { isValid: false, reason: "too_short" };
	}

	// Research/analysis task - no code output
	if (RESEARCH_PATTERNS.some((p) => p.test(objective))) {
		return { isValid: false, reason: "research_task" };
	}

	// Check if it has actionable patterns (file refs, specific verbs)
	const hasActionablePattern = ACTIONABLE_PATTERNS.some((p) => p.test(objective));

	// If no file reference and no clear action target, it's probably vague
	if (!hasActionablePattern && objective.length < 80) {
		// Allow longer objectives even without file refs - they may have enough context
		return { isValid: false, reason: "vague_no_target" };
	}

	return { isValid: true };
}

/**
 * Validate and filter decomposition results
 * Returns only high-quality, actionable subtasks
 */
function validateDecomposition(subtasks: Subtask[]): {
	valid: Subtask[];
	filtered: number;
	reasons: Record<string, number>;
} {
	const valid: Subtask[] = [];
	const reasons: Record<string, number> = {};

	for (const subtask of subtasks) {
		const validation = validateSubtask(subtask.objective);
		if (validation.isValid) {
			valid.push(subtask);
		} else {
			const reason = validation.reason || "unknown";
			reasons[reason] = (reasons[reason] || 0) + 1;
		}
	}

	// Cap at MAX_SUBTASKS to prevent explosion
	const capped = valid.slice(0, MAX_SUBTASKS);
	if (valid.length > MAX_SUBTASKS) {
		reasons.capped_max_subtasks = valid.length - MAX_SUBTASKS;
	}

	return {
		valid: capped,
		filtered: subtasks.length - capped.length,
		reasons,
	};
}

/**
 * Check if a task is atomic (can be completed in a single focused session)
 *
 * Uses Ax/DSPy program for self-improving assessment
 */
export async function checkAtomicity(task: string): Promise<AtomicityCheckResult> {
	logger.debug({ task: task.substring(0, 50) }, "Running Ax atomicity check");
	return checkAtomicityAx(task);
}

/**
 * Decompose a complex task into smaller, atomic subtasks
 *
 * Uses Ax/DSPy program for self-improving decomposition
 * Validates subtasks to reject vague/research tasks
 *
 * @param task The task to decompose
 * @param cwd Working directory for project detection (default: process.cwd())
 * @param ticketContent Optional rich ticket content (description, plan, etc.)
 */
export async function decomposeTask(
	task: string,
	cwd: string = process.cwd(),
	ticketContent?: string,
): Promise<DecompositionResult> {
	logger.debug({ task: task.substring(0, 50), hasTicketContent: !!ticketContent }, "Running Ax decomposition");

	const result = await decomposeTaskAx(task, ".undercity", cwd, ticketContent);

	if (result.subtasks.length === 0) {
		return {
			wasDecomposed: false,
			originalTask: task,
			subtasks: [],
			reasoning: result.reasoning || "Could not decompose task",
		};
	}

	// Transform string subtasks to Subtask objects
	// Extract file paths from objectives like "In src/file.ts, do something"
	const rawSubtasks: Subtask[] = result.subtasks.map((objective, idx) => {
		const fileMatch = objective.match(/(?:In |in )([\w/./-]+\.\w+)/);
		const estimatedFiles = fileMatch ? [fileMatch[1]] : undefined;

		return {
			objective,
			estimatedFiles,
			order: idx + 1,
		};
	});

	// Validate and filter subtasks for quality
	const validation = validateDecomposition(rawSubtasks);

	if (validation.filtered > 0) {
		logger.info(
			{
				task: task.substring(0, 50),
				original: rawSubtasks.length,
				kept: validation.valid.length,
				filtered: validation.filtered,
				reasons: validation.reasons,
			},
			"Filtered low-quality subtasks from decomposition",
		);
	}

	// If all subtasks were filtered, don't decompose
	if (validation.valid.length === 0) {
		logger.warn(
			{ task: task.substring(0, 50), reasons: validation.reasons },
			"All subtasks filtered - decomposition rejected",
		);
		return {
			wasDecomposed: false,
			originalTask: task,
			subtasks: [],
			reasoning: `Decomposition rejected: all ${rawSubtasks.length} subtasks were too vague or non-actionable`,
			filteredCount: validation.filtered,
		};
	}

	// Merge subtasks that target overlapping files
	const mergedSubtasks = mergeOverlappingSubtasks(validation.valid);

	// Re-number the valid subtasks
	const subtasks = mergedSubtasks.map((s, idx) => ({
		...s,
		order: idx + 1,
	}));

	return {
		wasDecomposed: true,
		originalTask: task,
		subtasks,
		reasoning: result.reasoning,
		filteredCount: validation.filtered,
	};
}

/**
 * Check and potentially decompose a task before execution
 *
 * This is the main entry point for the lazy decomposition flow:
 * 1. Check atomicity (cheap)
 * 2. If not atomic, decompose
 * 3. Return result indicating what happened
 */
export async function checkAndDecompose(
	task: string,
	options: {
		/** Skip check for tasks with certain tags */
		skipTags?: string[];
		/** Force decomposition regardless of check */
		forceDecompose?: boolean;
		/** Minimum confidence to trust atomicity check */
		minConfidence?: number;
		/** Working directory for project detection (default: process.cwd()) */
		cwd?: string;
		/** Optional rich ticket content (description, plan, etc.) for better decomposition */
		ticketContent?: string;
	} = {},
): Promise<{
	action: "proceed" | "decomposed" | "skip";
	subtasks?: Subtask[];
	reasoning: string;
	/** Recommended model for task execution */
	recommendedModel?: "haiku" | "sonnet" | "opus";
}> {
	const { forceDecompose = false, minConfidence = 0.6, cwd = process.cwd(), ticketContent } = options;

	// Force decomposition if requested
	if (forceDecompose) {
		const decomposition = await decomposeTask(task, cwd, ticketContent);
		if (decomposition.wasDecomposed && decomposition.subtasks.length > 0) {
			return {
				action: "decomposed",
				subtasks: decomposition.subtasks,
				reasoning: `Force decomposed: ${decomposition.reasoning}`,
			};
		}
		return {
			action: "proceed",
			reasoning: "Force decompose requested but decomposition failed, proceeding with original task",
		};
	}

	// Check atomicity
	const atomicity = await checkAtomicity(task);

	logger.info(
		{
			task: task.substring(0, 100),
			isAtomic: atomicity.isAtomic,
			confidence: atomicity.confidence,
			estimatedFiles: atomicity.estimatedFiles,
		},
		"Atomicity check complete",
	);

	// If atomic with sufficient confidence, proceed
	if (atomicity.isAtomic && atomicity.confidence >= minConfidence) {
		return {
			action: "proceed",
			reasoning: atomicity.reasoning,
			recommendedModel: atomicity.recommendedModel,
		};
	}

	// If not atomic or low confidence, decompose
	if (!atomicity.isAtomic || atomicity.confidence < minConfidence) {
		const decomposition = await decomposeTask(task, cwd, ticketContent);

		if (decomposition.wasDecomposed && decomposition.subtasks.length > 0) {
			logger.info(
				{
					originalTask: task.substring(0, 100),
					subtaskCount: decomposition.subtasks.length,
				},
				"Task decomposed into subtasks",
			);

			return {
				action: "decomposed",
				subtasks: decomposition.subtasks,
				reasoning: decomposition.reasoning,
			};
		}

		// Decomposition failed, proceed with original (better to try than block)
		return {
			action: "proceed",
			reasoning: `Decomposition attempted but failed: ${decomposition.reasoning}. Proceeding with original task.`,
			recommendedModel: atomicity.recommendedModel,
		};
	}

	return {
		action: "proceed",
		reasoning: atomicity.reasoning,
		recommendedModel: atomicity.recommendedModel,
	};
}
