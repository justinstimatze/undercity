/**
 * Semantic density analyzer types
 * Machine-readable output for agent consumption
 */

export interface SemanticReport {
	files: FileAnalysis[];
	redundancies: Redundancy[];
	actions: Action[];
	metrics: GlobalMetrics;
}

export interface FileAnalysis {
	path: string;
	type: FileType;
	tokens: number;
	facts: number;
	density: number;
	issues: Issue[];
}

export type FileType = "code" | "docs" | "claude_rules" | "config" | "test" | "other";

export interface Issue {
	type: IssueType;
	line?: number;
	startLine?: number;
	endLine?: number;
	severity: "low" | "medium" | "high";
	message: string;
	data?: Record<string, unknown>;
}

export type IssueType =
	| "redundant_comment"
	| "unclear_naming"
	| "low_density"
	| "outdated_comment"
	| "duplicate_definition"
	| "prose_vs_table"
	| "scattered_feature"
	| "missing_structure";

export interface Redundancy {
	fact: string;
	locations: string[];
	action: "consolidate" | "remove_duplicates";
	primaryLocation?: string;
}

export interface Action {
	priority: "low" | "medium" | "high";
	type: ActionType;
	file: string;
	data: Record<string, unknown>;
	description: string;
}

export type ActionType =
	| "rename_symbol"
	| "remove_lines"
	| "convert_to_table"
	| "consolidate_definition"
	| "restructure_prose"
	| "add_structure";

export interface GlobalMetrics {
	totalTokens: number;
	totalFacts: number;
	avgDensity: number;
	potentialSavings: number;
	savingsPercent: number;
	filesByType: Record<FileType, number>;
	issuesByType: Record<IssueType, number>;
}

/**
 * Facts are atomic pieces of information:
 * - Type definitions
 * - Function signatures
 * - Constants/enums
 * - Configuration values
 * - Decision tree branches
 * - Table rows
 * - Command descriptions
 */
export interface Fact {
	type: FactType;
	value: string;
	location: string;
	line: number;
}

export type FactType =
	| "type_definition"
	| "function_signature"
	| "constant"
	| "enum_value"
	| "config_value"
	| "command"
	| "decision_branch"
	| "table_row"
	| "mapping"
	| "constraint";
