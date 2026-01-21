/**
 * Review Lenses - Focused code review perspectives
 *
 * Replaces the tarot-based system with deterministic,
 * evidence-based review lenses that ensure consistent coverage
 * of critical review dimensions.
 */

export interface ReviewLens {
	id: string;
	name: string;
	priority: "critical" | "high" | "medium";
	prompt: string;
}

/**
 * Core review lenses ordered by priority.
 * Critical lenses run first, then high, then medium.
 */
export const REVIEW_LENSES: ReviewLens[] = [
	// CRITICAL - Always check these
	{
		id: "security",
		name: "Security",
		priority: "critical",
		prompt: `Check for security issues:
- Injection vulnerabilities (SQL, command, path traversal)
- Input validation gaps (user input, external data)
- Authentication/authorization bypasses
- Sensitive data exposure (logs, errors, responses)
- Insecure defaults or configurations`,
	},
	{
		id: "error-handling",
		name: "Error Handling",
		priority: "critical",
		prompt: `Check error handling:
- Unhandled exceptions or rejections
- Missing null/undefined checks
- Error messages that leak implementation details
- Silent failures that should be logged
- Missing try/catch around external calls`,
	},

	// HIGH - Important for code quality
	{
		id: "correctness",
		name: "Correctness",
		priority: "high",
		prompt: `Check for logic errors:
- Off-by-one errors in loops/slices
- Incorrect boolean logic or conditions
- Race conditions in async code
- Type coercion issues
- Incorrect assumptions about data shape`,
	},
	{
		id: "edge-cases",
		name: "Edge Cases",
		priority: "high",
		prompt: `Check edge case handling:
- Empty arrays/objects/strings
- Zero, negative, or very large numbers
- Concurrent access patterns
- Timeout and cancellation scenarios
- Partial failure states`,
	},

	// MEDIUM - Nice to have
	{
		id: "performance",
		name: "Performance",
		priority: "medium",
		prompt: `Check for performance issues:
- N+1 queries or redundant operations
- Missing early returns
- Unnecessary allocations in hot paths
- Blocking operations that could be async
- Missing caching opportunities`,
	},
	{
		id: "maintainability",
		name: "Maintainability",
		priority: "medium",
		prompt: `Check maintainability:
- Unclear variable/function names
- Functions doing too many things
- Deep nesting that could be flattened
- Magic numbers without constants
- Missing or misleading comments`,
	},
];

/**
 * Get lenses by priority level
 */
export function getLensesByPriority(priority: "critical" | "high" | "medium"): ReviewLens[] {
	return REVIEW_LENSES.filter((lens) => lens.priority === priority);
}

/**
 * Get a subset of lenses for quick review (critical + high priority)
 */
export function getQuickReviewLenses(): ReviewLens[] {
	return REVIEW_LENSES.filter((lens) => lens.priority === "critical" || lens.priority === "high");
}

/**
 * Get all lenses for thorough review
 */
export function getAllLenses(): ReviewLens[] {
	return [...REVIEW_LENSES];
}

/**
 * Format a lens for display
 */
export function formatLens(lens: ReviewLens): string {
	const priorityIcon = lens.priority === "critical" ? "🔴" : lens.priority === "high" ? "🟡" : "🟢";
	return `${priorityIcon} ${lens.name}`;
}
