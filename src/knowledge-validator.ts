/**
 * Knowledge Base Validator
 *
 * Runtime validation for knowledge.json structure using TypeScript type guards.
 * Ensures data integrity when loading/saving knowledge bases.
 * Follows the manual validation pattern from task-validator.ts.
 */

import type { KnowledgeBase, Learning, LearningCategory } from "./knowledge.js";

/**
 * Validation issue for knowledge base
 */
export interface KnowledgeValidationIssue {
	type:
		| "invalid_structure"
		| "missing_field"
		| "invalid_type"
		| "invalid_category"
		| "invalid_confidence"
		| "invalid_date"
		| "empty_array";
	severity: "error" | "warning";
	message: string;
	path: string; // JSON path to the issue (e.g., "learnings[0].confidence")
}

/**
 * Validation result for knowledge base
 */
export interface KnowledgeValidationResult {
	valid: boolean;
	issues: KnowledgeValidationIssue[];
}

/**
 * Valid learning categories
 */
const VALID_CATEGORIES: Set<string> = new Set<LearningCategory>(["pattern", "gotcha", "preference", "fact"]);

/**
 * Type guard: Check if value is a valid LearningCategory
 */
export function isLearningCategory(value: unknown): value is LearningCategory {
	return typeof value === "string" && VALID_CATEGORIES.has(value);
}

/**
 * Type guard: Check if value is a valid Learning object
 */
export function isLearning(value: unknown): value is Learning {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Check required fields and their types
	if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
		return false;
	}

	if (typeof obj.taskId !== "string" || obj.taskId.trim().length === 0) {
		return false;
	}

	if (!isLearningCategory(obj.category)) {
		return false;
	}

	if (typeof obj.content !== "string" || obj.content.trim().length === 0) {
		return false;
	}

	if (!Array.isArray(obj.keywords)) {
		return false;
	}

	// Validate keywords are all strings
	if (!obj.keywords.every((kw) => typeof kw === "string")) {
		return false;
	}

	if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
		return false;
	}

	if (typeof obj.usedCount !== "number" || obj.usedCount < 0 || !Number.isInteger(obj.usedCount)) {
		return false;
	}

	if (typeof obj.successCount !== "number" || obj.successCount < 0 || !Number.isInteger(obj.successCount)) {
		return false;
	}

	if (typeof obj.createdAt !== "string") {
		return false;
	}

	// Validate createdAt is a valid ISO date
	const createdDate = new Date(obj.createdAt);
	if (Number.isNaN(createdDate.getTime())) {
		return false;
	}

	// Optional fields
	if (obj.lastUsedAt !== undefined) {
		if (typeof obj.lastUsedAt !== "string") {
			return false;
		}
		const lastUsedDate = new Date(obj.lastUsedAt);
		if (Number.isNaN(lastUsedDate.getTime())) {
			return false;
		}
	}

	if (obj.structured !== undefined) {
		if (typeof obj.structured !== "object" || obj.structured === null) {
			return false;
		}

		const structured = obj.structured as Record<string, unknown>;
		if (structured.file !== undefined && typeof structured.file !== "string") {
			return false;
		}
		if (structured.pattern !== undefined && typeof structured.pattern !== "string") {
			return false;
		}
		if (structured.approach !== undefined && typeof structured.approach !== "string") {
			return false;
		}
	}

	return true;
}

/**
 * Type guard: Check if value is a valid KnowledgeBase object
 */
export function isKnowledgeBase(value: unknown): value is KnowledgeBase {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;

	// Check learnings array
	if (!Array.isArray(obj.learnings)) {
		return false;
	}

	// Validate each learning
	if (!obj.learnings.every((learning) => isLearning(learning))) {
		return false;
	}

	// Version and lastUpdated are optional for backward compatibility
	// If present, validate them
	if (obj.version !== undefined) {
		if (typeof obj.version !== "string") {
			return false;
		}
	}

	if (obj.lastUpdated !== undefined) {
		if (typeof obj.lastUpdated !== "string") {
			return false;
		}
		const lastUpdatedDate = new Date(obj.lastUpdated);
		if (Number.isNaN(lastUpdatedDate.getTime())) {
			return false;
		}
	}

	return true;
}

/**
 * Validate a single Learning object with detailed error reporting
 */
export function validateLearning(value: unknown, index?: number): KnowledgeValidationResult {
	const issues: KnowledgeValidationIssue[] = [];
	const basePath = index !== undefined ? `learnings[${index}]` : "learning";

	if (typeof value !== "object" || value === null) {
		issues.push({
			type: "invalid_structure",
			severity: "error",
			message: "Learning is not an object",
			path: basePath,
		});
		return { valid: false, issues };
	}

	const obj = value as Record<string, unknown>;

	// Required field: id
	if (typeof obj.id !== "string") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: id (must be string)",
			path: `${basePath}.id`,
		});
	} else if (obj.id.trim().length === 0) {
		issues.push({
			type: "invalid_type",
			severity: "error",
			message: "Learning id is empty",
			path: `${basePath}.id`,
		});
	}

	// Required field: taskId
	if (typeof obj.taskId !== "string") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: taskId (must be string)",
			path: `${basePath}.taskId`,
		});
	} else if (obj.taskId.trim().length === 0) {
		issues.push({
			type: "invalid_type",
			severity: "error",
			message: "Learning taskId is empty",
			path: `${basePath}.taskId`,
		});
	}

	// Required field: category
	if (!isLearningCategory(obj.category)) {
		issues.push({
			type: "invalid_category",
			severity: "error",
			message: `Invalid category: "${obj.category}". Must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
			path: `${basePath}.category`,
		});
	}

	// Required field: content
	if (typeof obj.content !== "string") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: content (must be string)",
			path: `${basePath}.content`,
		});
	} else if (obj.content.trim().length === 0) {
		issues.push({
			type: "invalid_type",
			severity: "error",
			message: "Learning content is empty",
			path: `${basePath}.content`,
		});
	}

	// Required field: keywords
	if (!Array.isArray(obj.keywords)) {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: keywords (must be array)",
			path: `${basePath}.keywords`,
		});
	} else {
		// Validate each keyword is a string
		for (let i = 0; i < obj.keywords.length; i++) {
			if (typeof obj.keywords[i] !== "string") {
				issues.push({
					type: "invalid_type",
					severity: "error",
					message: `Keyword at index ${i} is not a string`,
					path: `${basePath}.keywords[${i}]`,
				});
			}
		}
	}

	// Required field: confidence
	if (typeof obj.confidence !== "number") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: confidence (must be number)",
			path: `${basePath}.confidence`,
		});
	} else if (obj.confidence < 0 || obj.confidence > 1) {
		issues.push({
			type: "invalid_confidence",
			severity: "error",
			message: `Confidence must be between 0 and 1, got: ${obj.confidence}`,
			path: `${basePath}.confidence`,
		});
	}

	// Required field: usedCount
	if (typeof obj.usedCount !== "number") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: usedCount (must be number)",
			path: `${basePath}.usedCount`,
		});
	} else if (obj.usedCount < 0 || !Number.isInteger(obj.usedCount)) {
		issues.push({
			type: "invalid_type",
			severity: "error",
			message: `usedCount must be non-negative integer, got: ${obj.usedCount}`,
			path: `${basePath}.usedCount`,
		});
	}

	// Required field: successCount
	if (typeof obj.successCount !== "number") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: successCount (must be number)",
			path: `${basePath}.successCount`,
		});
	} else if (obj.successCount < 0 || !Number.isInteger(obj.successCount)) {
		issues.push({
			type: "invalid_type",
			severity: "error",
			message: `successCount must be non-negative integer, got: ${obj.successCount}`,
			path: `${basePath}.successCount`,
		});
	}

	// Required field: createdAt
	if (typeof obj.createdAt !== "string") {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Learning missing required field: createdAt (must be string)",
			path: `${basePath}.createdAt`,
		});
	} else {
		const createdDate = new Date(obj.createdAt);
		if (Number.isNaN(createdDate.getTime())) {
			issues.push({
				type: "invalid_date",
				severity: "error",
				message: `createdAt is not a valid ISO date: ${obj.createdAt}`,
				path: `${basePath}.createdAt`,
			});
		}
	}

	// Optional field: lastUsedAt
	if (obj.lastUsedAt !== undefined) {
		if (typeof obj.lastUsedAt !== "string") {
			issues.push({
				type: "invalid_type",
				severity: "error",
				message: "lastUsedAt must be string (ISO date)",
				path: `${basePath}.lastUsedAt`,
			});
		} else {
			const lastUsedDate = new Date(obj.lastUsedAt);
			if (Number.isNaN(lastUsedDate.getTime())) {
				issues.push({
					type: "invalid_date",
					severity: "error",
					message: `lastUsedAt is not a valid ISO date: ${obj.lastUsedAt}`,
					path: `${basePath}.lastUsedAt`,
				});
			}
		}
	}

	// Optional field: structured
	if (obj.structured !== undefined) {
		if (typeof obj.structured !== "object" || obj.structured === null) {
			issues.push({
				type: "invalid_type",
				severity: "error",
				message: "structured must be an object",
				path: `${basePath}.structured`,
			});
		} else {
			const structured = obj.structured as Record<string, unknown>;
			if (structured.file !== undefined && typeof structured.file !== "string") {
				issues.push({
					type: "invalid_type",
					severity: "error",
					message: "structured.file must be string",
					path: `${basePath}.structured.file`,
				});
			}
			if (structured.pattern !== undefined && typeof structured.pattern !== "string") {
				issues.push({
					type: "invalid_type",
					severity: "error",
					message: "structured.pattern must be string",
					path: `${basePath}.structured.pattern`,
				});
			}
			if (structured.approach !== undefined && typeof structured.approach !== "string") {
				issues.push({
					type: "invalid_type",
					severity: "error",
					message: "structured.approach must be string",
					path: `${basePath}.structured.approach`,
				});
			}
		}
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}

/**
 * Validate entire KnowledgeBase with detailed error reporting
 */
export function validateKnowledgeBase(value: unknown): KnowledgeValidationResult {
	const issues: KnowledgeValidationIssue[] = [];

	if (typeof value !== "object" || value === null) {
		issues.push({
			type: "invalid_structure",
			severity: "error",
			message: "Knowledge base is not an object",
			path: "root",
		});
		return { valid: false, issues };
	}

	const obj = value as Record<string, unknown>;

	// Required field: learnings
	if (!Array.isArray(obj.learnings)) {
		issues.push({
			type: "missing_field",
			severity: "error",
			message: "Knowledge base missing required field: learnings (must be array)",
			path: "learnings",
		});
		return { valid: false, issues };
	}

	// Validate each learning
	for (let i = 0; i < obj.learnings.length; i++) {
		const learningResult = validateLearning(obj.learnings[i], i);
		issues.push(...learningResult.issues);
	}

	// Optional field: version (backward compatibility)
	if (obj.version !== undefined && typeof obj.version !== "string") {
		issues.push({
			type: "invalid_type",
			severity: "warning",
			message: "version must be string",
			path: "version",
		});
	}

	// Optional field: lastUpdated (backward compatibility)
	if (obj.lastUpdated !== undefined) {
		if (typeof obj.lastUpdated !== "string") {
			issues.push({
				type: "invalid_type",
				severity: "warning",
				message: "lastUpdated must be string (ISO date)",
				path: "lastUpdated",
			});
		} else {
			const lastUpdatedDate = new Date(obj.lastUpdated);
			if (Number.isNaN(lastUpdatedDate.getTime())) {
				issues.push({
					type: "invalid_date",
					severity: "warning",
					message: `lastUpdated is not a valid ISO date: ${obj.lastUpdated}`,
					path: "lastUpdated",
				});
			}
		}
	}

	return {
		valid: issues.filter((i) => i.severity === "error").length === 0,
		issues,
	};
}

/**
 * Format validation issues for logging
 */
export function formatValidationIssues(result: KnowledgeValidationResult): string[] {
	if (result.issues.length === 0) {
		return [];
	}

	const lines: string[] = [];
	const errors = result.issues.filter((i) => i.severity === "error");
	const warnings = result.issues.filter((i) => i.severity === "warning");

	if (errors.length > 0) {
		lines.push(`Validation errors (${errors.length}):`);
		for (const issue of errors.slice(0, 10)) {
			lines.push(`  ✗ ${issue.path}: ${issue.message}`);
		}
		if (errors.length > 10) {
			lines.push(`  ... and ${errors.length - 10} more errors`);
		}
	}

	if (warnings.length > 0) {
		lines.push(`Validation warnings (${warnings.length}):`);
		for (const issue of warnings.slice(0, 5)) {
			lines.push(`  ⚠ ${issue.path}: ${issue.message}`);
		}
		if (warnings.length > 5) {
			lines.push(`  ... and ${warnings.length - 5} more warnings`);
		}
	}

	return lines;
}
