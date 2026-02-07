/**
 * Task Actionability Rules Configuration
 *
 * Defines configuration for validating whether task objectives are sufficiently
 * actionable for autonomous agent execution. This validation prevents vague or
 * overly broad tasks from entering the execution pipeline, reducing wasted
 * agent time and improving system effectiveness.
 *
 * The configuration supports:
 * - Pattern-based detection of vague, broad, or research-only tasks
 * - Ambition level tiers with different specificity requirements
 * - Configurable severity levels for different rule violations
 * - Concrete target detection patterns for verifying actionability
 */

/**
 * Ambition level for task proposals.
 * Determines how strictly file/function specificity is enforced.
 *
 * - **incremental**: Requires specific file paths and function names
 * - **moderate**: Requires module/directory targets (less specific)
 * - **ambitious**: Requires clear direction but allows cross-cutting scope
 */
export type AmbitionLevel = "incremental" | "moderate" | "ambitious";

/**
 * Severity level for actionability validation rules
 *
 * - **error**: Task should be rejected (not actionable)
 * - **warning**: Task may need refinement but can proceed
 * - **info**: Informational signal, doesn't block execution
 */
export type RuleSeverity = "error" | "warning" | "info";

/**
 * Rule type for actionability validation
 *
 * - **vague_verb**: Task starts with non-actionable verbs (explore, research, etc.)
 * - **overly_broad**: Task scope is unbounded (all files, entire codebase, etc.)
 * - **missing_target**: Task lacks concrete file/function/module targets
 * - **research_only**: Task produces no code output
 */
export type RuleType = "vague_verb" | "overly_broad" | "missing_target" | "research_only";

/**
 * A single actionability validation rule
 */
export interface ActionabilityRule {
	/** Unique identifier for this rule */
	id: string;

	/** Human-readable name for this rule */
	name: string;

	/** Rule type category */
	type: RuleType;

	/** Severity level for violations */
	severity: RuleSeverity;

	/** Regular expression pattern to match */
	pattern: RegExp;

	/** Description of what this rule detects */
	description: string;

	/** Example tasks that would trigger this rule */
	examples?: string[];

	/** Ambition levels this rule applies to (if undefined, applies to all) */
	applicableTo?: AmbitionLevel[];
}

/**
 * Configuration for concrete target detection
 *
 * Defines patterns that indicate a task has specific, actionable targets
 * rather than vague or unbounded scope.
 */
export interface ConcreteTargetConfig {
	/** Patterns that indicate specific file targets */
	filePatterns: RegExp[];

	/** Patterns that indicate specific function/method targets */
	functionPatterns: RegExp[];

	/** Patterns that indicate specific module/directory targets */
	modulePatterns: RegExp[];

	/** Patterns that indicate architectural/direction clarity (for ambitious tasks) */
	directionPatterns: RegExp[];
}

/**
 * Validation thresholds for different ambition levels
 */
export interface ValidationThresholds {
	/** Minimum number of concrete targets required */
	minConcreteTargets: number;

	/** Whether to require file-level specificity */
	requireFileSpecificity: boolean;

	/** Whether to require function-level specificity */
	requireFunctionSpecificity: boolean;

	/** Whether to allow cross-cutting architectural changes */
	allowCrossCutting: boolean;
}

/**
 * Configuration for task actionability validation rules
 *
 * This interface specifies the complete configuration for determining
 * whether a task objective is sufficiently actionable for autonomous
 * execution. The configuration is organized by ambition level, allowing
 * different validation strategies for incremental, moderate, and ambitious tasks.
 */
export interface TaskActionabilityConfig {
	/**
	 * List of validation rules to apply
	 *
	 * Rules are checked in order. First matching rule of severity "error"
	 * will cause validation to fail.
	 */
	rules: ActionabilityRule[];

	/**
	 * Configuration for detecting concrete targets
	 *
	 * Used to verify that tasks have specific, actionable targets rather
	 * than vague or unbounded scope.
	 */
	concreteTargets: ConcreteTargetConfig;

	/**
	 * Validation thresholds by ambition level
	 *
	 * Different ambition levels have different requirements for specificity
	 * and concrete targets.
	 */
	thresholds: {
		incremental: ValidationThresholds;
		moderate: ValidationThresholds;
		ambitious: ValidationThresholds;
	};

	/**
	 * Minimum confidence score (0-1) required for validation to pass
	 *
	 * The confidence score is calculated based on the number and type of
	 * concrete targets detected in the task objective.
	 */
	minConfidenceScore: number;

	/**
	 * Whether to enable strict validation mode
	 *
	 * Strict mode treats warnings as errors and applies all validation
	 * rules regardless of ambition level.
	 */
	strictMode: boolean;

	/**
	 * Custom rule parameters (extensible)
	 *
	 * Allows configuration of additional rule-specific parameters
	 * without modifying the main interface.
	 */
	customParams?: Record<string, unknown>;
}

/**
 * Result of actionability validation
 */
export interface ActionabilityValidationResult {
	/** Whether the task objective is actionable */
	isActionable: boolean;

	/** Confidence score (0-1) in the actionability assessment */
	confidence: number;

	/** Rules that were triggered during validation */
	triggeredRules: Array<{
		ruleId: string;
		severity: RuleSeverity;
		message: string;
	}>;

	/** Detected concrete targets (if any) */
	detectedTargets: {
		files: string[];
		functions: string[];
		modules: string[];
		hasDirection: boolean;
	};

	/** Suggested improvements (if task is not actionable) */
	suggestions?: string[];
}
