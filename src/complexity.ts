/**
 * Complexity Assessment Module
 *
 * | Output          | Description                        |
 * |-----------------|------------------------------------|
 * | Model routing   | haiku / sonnet / opus selection    |
 * | Execution mode  | solo vs full chain                 |
 * | Verification    | review requirements                |
 *
 * | Method       | Signals                                          |
 * |--------------|--------------------------------------------------|
 * | Quantitative | file metrics, code health, git history, packages |
 * | Heuristics   | keywords, patterns, scope indicators             |
 * | LLM fallback | low-confidence fast assessment → Haiku analysis  |
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkComplexityAx } from "./ax-programs.js";
import { TIMEOUT_GIT_CMD_MS } from "./constants.js";
import { sessionLogger } from "./logger.js";
import type { ModelTier } from "./types.js";

/**
 * Complexity levels with associated configurations
 */
export type ComplexityLevel = "trivial" | "simple" | "standard" | "complex" | "critical";

/**
 * Team Composition by Complexity Level
 *
 * | Level     | Planning | Workers | Validators | Model    | Validation Strategy |
 * |-----------|----------|---------|------------|----------|---------------------|
 * | Trivial   | None     | 1       | 0          | Haiku    | Fast path, no extra review |
 * | Simple    | None     | 1       | 1          | Haiku    | Basic independent review |
 * | Standard  | Sonnet   | 1       | 2          | Sonnet   | Thorough independent review |
 * | Complex   | Opus     | 1       | 3          | Sonnet   | Comprehensive independent review |
 * | Critical  | Opus     | 1       | 5          | Sonnet   | Extensive independent review |
 *
 * Key insight: Independent validators can't hide test failures, ensuring higher quality.
 */
export interface TeamComposition {
	/** Whether planning phase is needed */
	needsPlanning: boolean;
	/** Model for planning (if needed) */
	plannerModel?: "haiku" | "sonnet" | "opus";
	/** Model for implementation */
	workerModel: "haiku" | "sonnet" | "opus";
	/** Number of independent validators */
	validatorCount: number;
	/** Model for validators */
	validatorModel: "haiku" | "sonnet" | "opus";
	/** Whether validators must be independent (didn't write code) */
	independentValidators: boolean;
	/** Optional ceiling to prevent unnecessary model escalation */
	modelCeiling?: "haiku" | "sonnet" | "opus";
}

/**
 * Result of complexity assessment
 */
export interface ComplexityAssessment {
	/** The assessed complexity level */
	level: ComplexityLevel;
	/** Confidence in the assessment (0-1) */
	confidence: number;
	/** Recommended model for execution */
	model: "haiku" | "sonnet" | "opus";
	/** Whether to use full agent chain or solo mode */
	useFullChain: boolean;
	/** Whether reviewer check is recommended */
	needsReview: boolean;
	/** Estimated scope (files likely to change) */
	estimatedScope: "single-file" | "few-files" | "many-files" | "cross-package";
	/** Signals that influenced the decision */
	signals: string[];
	/** Raw score used for assessment */
	score: number;
	/** Quantitative metrics used (if available) */
	metrics?: QuantitativeMetrics;
	/** Team composition for this complexity level */
	team: TeamComposition;
	/** If set, task can be handled by local tools alone (no LLM) */
	localTool?: LocalToolResult;
}

/**
 * Quantitative code metrics for complexity assessment
 */
export interface QuantitativeMetrics {
	/** Number of files likely to be affected */
	fileCount: number;
	/** Total lines of code in target files */
	totalLines: number;
	/** Number of functions/methods in target files */
	functionCount: number;
	/** Average CodeScene health score (1-10, lower = worse) */
	avgCodeHealth?: number;
	/** Files with health score < 7 (problematic) */
	unhealthyFiles: string[];
	/** Whether task spans multiple packages */
	crossPackage: boolean;
	/** Packages involved */
	packages: string[];
	/** Git metrics */
	git: {
		/** Average commits per file in last 90 days */
		avgChangeFrequency: number;
		/** Files with > 10 commits (hotspots) */
		hotspots: string[];
		/** Files with "fix" commits (bug-prone) */
		bugProneFiles: string[];
	};
}

/**
 * File metrics for a single file
 */
interface FileMetrics {
	path: string;
	lines: number;
	functions: number;
	codeHealth?: number;
	recentCommits: number;
	bugFixes: number;
}

/**
 * Result when a task can be handled by local tools (no LLM needed)
 */
export interface LocalToolResult {
	/** The shell command to execute */
	command: string;
	/** Human-readable description */
	description: string;
}

/**
 * Patterns for tasks that can be handled by local tools alone (no LLM)
 * These are FREE - no tokens consumed
 */
const LOCAL_TOOL_PATTERNS: Array<{ pattern: RegExp; command: string; description: string }> = [
	{ pattern: /^(run\s+)?(format|prettier|biome\s+format)/i, command: "pnpm format", description: "Format code" },
	{ pattern: /^(run\s+)?(lint|biome\s+lint)/i, command: "pnpm lint:fix", description: "Lint and fix" },
	{ pattern: /^(run\s+)?typecheck/i, command: "pnpm typecheck", description: "Run type checking" },
	{ pattern: /^(run\s+)?test($|\s)/i, command: "pnpm test", description: "Run tests" },
	{ pattern: /^(run\s+)?build($|\s)/i, command: "pnpm build", description: "Build project" },
	{ pattern: /^organize\s+imports/i, command: "pnpm check:fix", description: "Organize imports" },
	{ pattern: /^sort\s+imports/i, command: "pnpm check:fix", description: "Sort imports" },
	{ pattern: /^(run\s+)?spell\s*check/i, command: "pnpm spell", description: "Run spell check" },
];

/**
 * Check if a task can be handled by local tools alone (no LLM needed)
 * Returns the command to run if so, null otherwise
 */
export function canHandleWithLocalTools(task: string): LocalToolResult | null {
	for (const { pattern, command, description } of LOCAL_TOOL_PATTERNS) {
		if (pattern.test(task)) {
			return { command, description };
		}
	}
	return null;
}

/**
 * Get quantitative metrics for a set of target files
 */
export function getFileMetrics(files: string[], repoRoot: string = process.cwd()): QuantitativeMetrics {
	// TODO: Consider adding support for more complex function counting,
	// potentially using an AST parser for more accurate method/function detection
	// and to handle edge cases like arrow functions, method shorthand, etc.
	const metrics: QuantitativeMetrics = {
		fileCount: files.length,
		totalLines: 0,
		functionCount: 0,
		unhealthyFiles: [],
		crossPackage: false,
		packages: [],
		git: {
			avgChangeFrequency: 0,
			hotspots: [],
			bugProneFiles: [],
		},
	};

	if (files.length === 0) {
		return metrics;
	}

	const fileMetricsList: FileMetrics[] = [];
	const packageSet = new Set<string>();

	for (const file of files) {
		const fullPath = path.isAbsolute(file) ? file : path.join(repoRoot, file);

		// Detect package from path
		const pkg = detectPackage(file);
		if (pkg) packageSet.add(pkg);

		const fm: FileMetrics = {
			path: file,
			lines: 0,
			functions: 0,
			recentCommits: 0,
			bugFixes: 0,
		};

		// Count lines and functions
		try {
			if (fs.existsSync(fullPath)) {
				const content = fs.readFileSync(fullPath, "utf-8");
				fm.lines = content.split("\n").length;
				// Simple function detection - count function/method declarations
				const funcMatches = content.match(
					/(?:function\s+\w+|(?:async\s+)?(?:\w+\s*)?(?:=>|\(.*\)\s*(?:=>|{))|\w+\s*\([^)]*\)\s*{)/g,
				);
				fm.functions = funcMatches?.length || 0;
			}
		} catch {
			// File not readable
		}

		// Get git history for this file
		try {
			// Commits in last 90 days
			const commitCount = execSync(`git log --oneline --since="90 days ago" -- "${file}" 2>/dev/null | wc -l`, {
				encoding: "utf-8",
				cwd: repoRoot,
			}).trim();
			fm.recentCommits = parseInt(commitCount, 10) || 0;

			// Bug fix commits (contain "fix" in message)
			const fixCount = execSync(
				`git log --oneline --since="90 days ago" --grep="fix" -i -- "${file}" 2>/dev/null | wc -l`,
				{ encoding: "utf-8", cwd: repoRoot },
			).trim();
			fm.bugFixes = parseInt(fixCount, 10) || 0;
		} catch {
			// Git command failed
		}

		// Try to get CodeScene health score
		try {
			const csOutput = execSync(`cs check "${fullPath}" 2>/dev/null || true`, {
				encoding: "utf-8",
				cwd: repoRoot,
				timeout: TIMEOUT_GIT_CMD_MS,
			});
			const healthMatch = csOutput.match(/Code Health:\s*(\d+(?:\.\d+)?)/i);
			if (healthMatch) {
				fm.codeHealth = parseFloat(healthMatch[1]);
			}
		} catch {
			// CodeScene not available or failed
		}

		fileMetricsList.push(fm);
	}

	// Aggregate metrics
	metrics.packages = [...packageSet];
	metrics.crossPackage = packageSet.size > 1;

	let totalCommits = 0;
	let healthSum = 0;
	let healthCount = 0;

	for (const fm of fileMetricsList) {
		metrics.totalLines += fm.lines;
		metrics.functionCount += fm.functions;
		totalCommits += fm.recentCommits;

		if (fm.codeHealth !== undefined) {
			healthSum += fm.codeHealth;
			healthCount++;
			if (fm.codeHealth < 7) {
				metrics.unhealthyFiles.push(fm.path);
			}
		}

		if (fm.recentCommits > 10) {
			metrics.git.hotspots.push(fm.path);
		}

		if (fm.bugFixes > 2) {
			metrics.git.bugProneFiles.push(fm.path);
		}
	}

	metrics.git.avgChangeFrequency = fileMetricsList.length > 0 ? totalCommits / fileMetricsList.length : 0;

	if (healthCount > 0) {
		metrics.avgCodeHealth = healthSum / healthCount;
	}

	return metrics;
}

/**
 * Detect which package a file belongs to
 */
function detectPackage(filePath: string): string | null {
	const parts = filePath.split(path.sep);

	// Common package directories
	const packageDirs = ["next-client", "express-server", "common", "pyserver", "pipeline-worker", "utils", "undercity"];

	for (const dir of packageDirs) {
		if (parts.includes(dir)) {
			return dir;
		}
	}

	// Check for src/ pattern (might be in root package)
	if (parts[0] === "src") {
		return "root";
	}

	return null;
}

/**
 * Calculate complexity score from quantitative metrics
 */
export function scoreFromMetrics(metrics: QuantitativeMetrics): {
	score: number;
	signals: string[];
} {
	let score = 0;
	const signals: string[] = [];

	// File count scoring
	if (metrics.fileCount === 0) {
		// No files identified - uncertain
		signals.push("no-files-identified");
	} else if (metrics.fileCount === 1) {
		score += 0;
		signals.push(`files:1`);
	} else if (metrics.fileCount <= 3) {
		score += 1;
		signals.push(`files:${metrics.fileCount}`);
	} else if (metrics.fileCount <= 7) {
		score += 2;
		signals.push(`files:${metrics.fileCount}`);
	} else {
		score += 3;
		signals.push(`files:${metrics.fileCount}(many)`);
	}

	// Lines of code scoring
	if (metrics.totalLines > 1000) {
		score += 2;
		signals.push(`lines:${metrics.totalLines}(large)`);
	} else if (metrics.totalLines > 500) {
		score += 1;
		signals.push(`lines:${metrics.totalLines}`);
	}

	// Function count scoring
	if (metrics.functionCount > 20) {
		score += 2;
		signals.push(`functions:${metrics.functionCount}(many)`);
	} else if (metrics.functionCount > 10) {
		score += 1;
		signals.push(`functions:${metrics.functionCount}`);
	}

	// Cross-package scoring
	if (metrics.crossPackage) {
		score += 3;
		signals.push(`cross-package:${metrics.packages.join(",")}`);
	}

	// Code health scoring
	if (metrics.avgCodeHealth !== undefined) {
		if (metrics.avgCodeHealth < 5) {
			score += 3;
			signals.push(`code-health:${metrics.avgCodeHealth.toFixed(1)}(poor)`);
		} else if (metrics.avgCodeHealth < 7) {
			score += 2;
			signals.push(`code-health:${metrics.avgCodeHealth.toFixed(1)}(fair)`);
		} else {
			signals.push(`code-health:${metrics.avgCodeHealth.toFixed(1)}(good)`);
		}
	}

	// Unhealthy files
	if (metrics.unhealthyFiles.length > 0) {
		score += metrics.unhealthyFiles.length;
		signals.push(`unhealthy-files:${metrics.unhealthyFiles.length}`);
	}

	// Git hotspots (frequently changed = risky)
	if (metrics.git.hotspots.length > 0) {
		score += metrics.git.hotspots.length;
		signals.push(`git-hotspots:${metrics.git.hotspots.length}`);
	}

	// Bug-prone files
	if (metrics.git.bugProneFiles.length > 0) {
		score += metrics.git.bugProneFiles.length * 2;
		signals.push(`bug-prone:${metrics.git.bugProneFiles.length}`);
	}

	// High change frequency
	if (metrics.git.avgChangeFrequency > 5) {
		score += 1;
		signals.push(`high-churn:${metrics.git.avgChangeFrequency.toFixed(1)}`);
	}

	return { score, signals };
}

/**
 * Get team composition for a complexity level
 *
 * Inspired by Zeroshot's complexity-based team sizing:
 * - trivial: Single agent, no validation (fast path)
 * - simple: Worker + 1 validator
 * - standard: Planner + worker + 2 validators
 * - complex: Planner + worker + 3 validators
 * - critical: Planner (opus) + worker + 5 validators
 *
 * Model ceiling can restrict expensive models (e.g., force sonnet max)
 */
export function getTeamComposition(
	level: ComplexityLevel,
	modelCeiling?: "haiku" | "sonnet" | "opus",
): TeamComposition {
	// Helper to apply model ceiling
	const capModel = (
		model: "haiku" | "sonnet" | "opus",
		ceiling?: "haiku" | "sonnet" | "opus",
	): "haiku" | "sonnet" | "opus" => {
		if (!ceiling) return model;
		const order = ["haiku", "sonnet", "opus"];
		const ceilingIdx = order.indexOf(ceiling);
		const modelIdx = order.indexOf(model);
		return modelIdx > ceilingIdx ? ceiling : model;
	};

	// Note: We skip haiku entirely - sonnet requires less steering and has
	// higher first-attempt success rates, making it cheaper overall.
	const compositions: Record<ComplexityLevel, TeamComposition> = {
		trivial: {
			needsPlanning: false,
			workerModel: "sonnet",
			validatorCount: 0,
			validatorModel: "sonnet",
			independentValidators: false,
		},
		simple: {
			needsPlanning: false,
			workerModel: "sonnet",
			validatorCount: 1,
			validatorModel: "sonnet",
			independentValidators: true,
		},
		standard: {
			needsPlanning: true,
			plannerModel: "sonnet",
			workerModel: "sonnet",
			validatorCount: 2,
			validatorModel: "sonnet",
			independentValidators: true,
		},
		complex: {
			needsPlanning: true,
			plannerModel: "opus",
			workerModel: "sonnet",
			validatorCount: 3,
			validatorModel: "sonnet",
			independentValidators: true,
		},
		critical: {
			needsPlanning: true,
			plannerModel: "opus",
			workerModel: "sonnet",
			validatorCount: 5,
			validatorModel: "sonnet",
			independentValidators: true,
		},
	};

	const composition = compositions[level];
	return {
		needsPlanning: composition.needsPlanning,
		workerModel: capModel(composition.workerModel, modelCeiling),
		validatorCount: composition.validatorCount,
		validatorModel: capModel(composition.validatorModel, modelCeiling),
		independentValidators: composition.independentValidators,
		plannerModel: composition.plannerModel ? capModel(composition.plannerModel, modelCeiling) : undefined,
	};
}

/**
 * Shared complexity level configuration
 * Purpose: explicit review + model escalation rules, prevent simple task over-escalation
 */
function getLevelConfig(
	level: ComplexityLevel,
	modelCeiling?: "haiku" | "sonnet" | "opus",
): {
	model: "haiku" | "sonnet" | "opus";
	useFullChain: boolean;
	needsReview: boolean;
	description: string;
} {
	// Helper to apply model ceiling, preventing unnecessary escalation
	const capModel = (
		model: "haiku" | "sonnet" | "opus",
		ceiling?: "haiku" | "sonnet" | "opus",
	): "haiku" | "sonnet" | "opus" => {
		if (!ceiling) return model;
		const order = ["haiku", "sonnet", "opus"];
		const ceilingIdx = order.indexOf(ceiling);
		const modelIdx = order.indexOf(model);
		return modelIdx > ceilingIdx ? ceiling : model;
	};

	const levelConfig: Record<
		ComplexityLevel,
		{
			model: "haiku" | "sonnet" | "opus";
			useFullChain: boolean;
			needsReview: boolean;
			description: string;
			defaultModelCeiling?: "haiku" | "sonnet" | "opus";
		}
	> = {
		// Trivial tasks: typos, comments, version bumps
		// Note: We skip haiku - sonnet requires less steering, higher first-attempt success
		trivial: {
			model: "sonnet",
			useFullChain: false,
			needsReview: false,
			description: "Minimal changes, no review needed",
			defaultModelCeiling: "sonnet",
		},
		// Simple tasks: small changes, single function/file tweaks - cap at sonnet
		simple: {
			model: "sonnet",
			useFullChain: false,
			needsReview: false,
			description: "Minor changes within single file or function",
			defaultModelCeiling: "sonnet",
		},
		// Standard tasks: typical features, bug fixes - use sonnet, review recommended
		standard: {
			model: "sonnet",
			useFullChain: false,
			needsReview: true,
			description: "Typical features requiring basic review",
		},
		// Complex tasks: multi-file changes, refactors - start with sonnet, let escalation handle opus
		// Previously sent directly to opus, wasting tokens when sonnet could handle it
		complex: {
			model: "sonnet",
			useFullChain: true,
			needsReview: true,
			description: "Significant architectural or multi-file changes",
		},
		// Critical tasks: security, auth, production - full opus escalation
		critical: {
			model: "opus",
			useFullChain: true,
			needsReview: true,
			description: "High-stakes changes requiring comprehensive review",
		},
	};

	const config = levelConfig[level];
	const _ceiling = config.defaultModelCeiling || modelCeiling;

	return {
		...config,
		model: capModel(config.model, _ceiling),
	};
}

/**
 * Minimum success rate thresholds for model tiers
 * Below these, escalate to next tier
 */
const MODEL_SUCCESS_THRESHOLDS = {
	haiku: 0.7, // If haiku succeeds < 70%, try sonnet
	sonnet: 0.6, // If sonnet succeeds < 60%, try opus
	opus: 0.0, // Opus is the ceiling
};

/**
 * Check historical metrics and potentially upgrade model tier
 * Returns: adjusted model if success rate too low
 * Strategy: learned routing profile → fallback to raw metrics + thresholds
 */
export async function adjustModelFromMetrics(
	recommendedModel: ModelTier | "haiku",
	complexityLevel: ComplexityLevel,
	minSamples: number = 3,
): Promise<ModelTier> {
	// Map legacy haiku to sonnet
	const normalizedModel: ModelTier = recommendedModel === "haiku" ? "sonnet" : recommendedModel;
	try {
		// First, try using learned routing profile
		const { loadRoutingProfile, shouldSkipModel, getThreshold } = await import("./self-tuning.js");
		const profile = loadRoutingProfile();

		if (profile && profile.taskCount >= minSamples) {
			// Check if we should skip this model entirely
			if (shouldSkipModel(profile, normalizedModel, complexityLevel)) {
				const upgraded = upgradeModel(normalizedModel);
				sessionLogger.info(
					{
						originalModel: normalizedModel,
						upgradedModel: upgraded,
						complexity: complexityLevel,
						reason: "learned_skip",
					},
					"Upgrading model based on learned routing profile",
				);
				return upgraded;
			}

			// Check learned threshold
			const threshold = getThreshold(profile, normalizedModel, complexityLevel);
			const successRate = profile.modelSuccessRates[normalizedModel];

			if (successRate < threshold.minSuccessRate && profile.taskCount >= threshold.minSamples) {
				const upgraded = upgradeModel(normalizedModel);
				sessionLogger.info(
					{
						originalModel: normalizedModel,
						upgradedModel: upgraded,
						successRate,
						threshold: threshold.minSuccessRate,
						profileTaskCount: profile.taskCount,
					},
					"Upgrading model due to learned low success rate",
				);
				return upgraded;
			}

			return normalizedModel;
		}

		// Fall back to raw metrics analysis
		const { getMetricsAnalysis } = await import("./feedback-metrics.js");
		const analysis = getMetricsAnalysis();

		// Check if we have enough data
		if (analysis.totalTasks < minSamples) {
			sessionLogger.debug(
				{ totalTasks: analysis.totalTasks, minSamples },
				"Not enough metrics data for adjustment, using default model",
			);
			return normalizedModel;
		}

		// Check success rate for this model + complexity combo
		const comboKey = `${normalizedModel}:${complexityLevel}`;
		const combo = analysis.byModelAndComplexity[comboKey];

		if (!combo || combo.total < minSamples) {
			// Not enough specific data, check model-level success rate
			const modelStats = analysis.byModel[normalizedModel];
			if (!modelStats || modelStats.total < minSamples) {
				return normalizedModel;
			}

			// Check if model-level success rate is below threshold
			const threshold = MODEL_SUCCESS_THRESHOLDS[normalizedModel];
			if (modelStats.rate < threshold) {
				const upgraded = upgradeModel(normalizedModel);
				sessionLogger.info(
					{
						originalModel: normalizedModel,
						upgradedModel: upgraded,
						successRate: modelStats.rate,
						threshold,
					},
					"Upgrading model due to low historical success rate",
				);
				return upgraded;
			}
			return normalizedModel;
		}

		// Check specific combo success rate
		const comboThreshold = MODEL_SUCCESS_THRESHOLDS[normalizedModel];
		if (combo.rate < comboThreshold) {
			const upgraded = upgradeModel(normalizedModel);
			sessionLogger.info(
				{
					originalModel: normalizedModel,
					upgradedModel: upgraded,
					complexity: complexityLevel,
					successRate: combo.rate,
					threshold: comboThreshold,
					samples: combo.total,
				},
				"Upgrading model due to low historical success rate for complexity level",
			);
			return upgraded;
		}

		return normalizedModel;
	} catch (error) {
		// Metrics unavailable - use default
		sessionLogger.debug({ error: String(error) }, "Could not load metrics, using default model");
		return normalizedModel;
	}
}

/**
 * Upgrade model to next tier
 */
function upgradeModel(model: ModelTier | "haiku"): ModelTier {
	switch (model) {
		case "haiku":
			return "sonnet";
		case "sonnet":
			return "opus";
		case "opus":
			return "opus";
	}
}

/**
 * Keywords and patterns that indicate complexity
 */
// Complexity signals: refined categorization distinguishing simple vs review-requiring tasks
const COMPLEXITY_SIGNALS = {
	// Absolutely minimal changes - guaranteed haiku, no review
	trivial: {
		keywords: ["typo", "comment", "rename", "fix typo", "update comment", "version bump", "jsdoc"],
		patterns: [
			/^fix\s+typo/i,
			/^update\s+comment/i,
			/^bump\s+version/i,
			/^correct\s+(spelling|grammar)/i,
			/^add\s+(a\s+)?(simple\s+)?comment/i,
			/^add\s+(a\s+)?jsdoc/i,
			/^add\s+(a\s+)?(brief\s+)?inline\s+comment/i,
			/^add\s+(a\s+)?todo\s+comment/i,
		],
		weight: -2, // Negative weight to counteract standard "add" pattern
	},
	// Simple, self-contained changes that don't require escalation
	simple: {
		keywords: [
			"add log",
			"simple fix",
			"small change",
			"minor",
			"tweak",
			"adjust",
			"update import",
			"add import",
			"clean up",
			"organize",
			"improve readability",
			"simplify code",
			"remove unused",
		],
		patterns: [
			/^add\s+(a\s+)?log/i,
			/^simple\s+/i,
			/^small\s+/i,
			/^clean\s+up/i,
			/^remove\s+unused/i,
			/^improve\s+readability/i,
		],
		weight: 1,
	},
	// Typical feature work or bugfixes that need basic review
	standard: {
		keywords: [
			"add feature",
			"implement",
			"create",
			"build",
			"update",
			"modify",
			"fix bug",
			"add test",
			"enhance",
			"improve",
		],
		patterns: [/^add\s+/i, /^implement\s+/i, /^create\s+/i, /^fix\s+/i, /^enhance\s+/i],
		weight: 2,
	},
	// Significant changes that warrant opus escalation
	// Weight increased to ensure complex tasks hit threshold (9-11) with expanded thresholds
	complex: {
		keywords: [
			"refactor",
			"migrate",
			"redesign",
			"rewrite",
			"integrate",
			"cross-package",
			"multi-file",
			"architecture",
			"api change",
			"breaking change",
			"performance optimization",
			"major restructure",
		],
		patterns: [
			/refactor/i,
			/migrate/i,
			/redesign/i,
			/integration/i,
			/across\s+(multiple|all)/i,
			/performance\s+optimization/i,
			/major\s+restructure/i,
		],
		weight: 5,
	},
	// Highest risk tasks requiring full review and escalation
	// Weight increased to ensure critical keywords always hit critical threshold (> 11)
	critical: {
		keywords: [
			"security",
			"authentication",
			"authorization",
			"payment",
			"database migration",
			"production",
			"critical",
			"breaking",
			"compliance",
			"data integrity",
			"high-risk",
		],
		patterns: [/security/i, /auth/i, /payment/i, /production/i, /data\s+integrity/i, /high\s*-?\s*risk/i],
		weight: 10,
	},
};

/**
 * Scope indicators based on task description
 */
const SCOPE_SIGNALS = {
	"single-file": ["in file", "this file", "one file", "the function", "the component"],
	"few-files": ["a few files", "related files", "and tests", "with types"],
	"many-files": ["multiple files", "several files", "across files", "throughout"],
	"cross-package": ["cross-package", "multiple packages", "common and", "server and client"],
};

/**
 * Assess complexity via heuristics
 * Characteristics: fast, no API calls, initial triage
 *
 * @param task - Task description to analyze
 * @returns ComplexityAssessment with level, model recommendation, and score
 *
 * ## Scoring System
 *
 * The function calculates a complexity score by adding weights from multiple components:
 *
 * ### Keyword/Pattern Weights:
 * - **trivial** (weight: 0): typos, comments, renames, version bumps
 * - **simple** (weight: 1): logs, small changes, imports, cleanup
 * - **standard** (weight: 2): features, bug fixes, tests, typical work
 * - **complex** (weight: 3): refactors, migrations, architecture changes
 * - **critical** (weight: 4): security, auth, payments, production changes
 *
 * ### Scope Modifiers:
 * - **single-file**: +0 points
 * - **few-files**: +1 point
 * - **many-files**: +2 points
 * - **cross-package**: +3 points
 *
 * ### Length Modifiers:
 * - **>50 words**: +1 point ("long-description")
 * - **>100 words**: +1 additional point ("very-long-description")
 *
 * ### Score → Complexity Level Mapping:
 * - **≤2**: trivial (sonnet, no review) - haiku skipped for better first-attempt success
 * - **3-5**: simple (sonnet, no review)
 * - **6-8**: standard (sonnet, review recommended)
 * - **9-11**: complex (sonnet, full chain + review)
 * - **≥12**: critical (opus, full chain + review)
 *
 * ### Special Cases:
 * - **Empty task**: Returns "simple" with score 1
 * - **Local tools** (format, lint, test): Returns "trivial" with score 0
 *
 * @example
 * ```typescript
 * // "fix typo in readme" → trivial (0) + single-file (0) = 0 → trivial
 * // "add new feature" → standard (2) + few-files (1) = 3 → simple
 * // "refactor auth system" → complex (3) + cross-package (3) = 6 → standard
 * // "security audit and payment integration" → critical (4+4) + cross-package (3) = 11 → critical
 * ```
 */
export function assessComplexityFast(task: string): ComplexityAssessment {
	if (!task) {
		const assessment = {
			level: "simple" as ComplexityLevel,
			confidence: 0.5,
			model: "sonnet", // haiku skipped - sonnet is the minimum
			useFullChain: false,
			needsReview: false,
			estimatedScope: "single-file" as ComplexityAssessment["estimatedScope"],
			score: 1,
			signals: ["no task description provided"],
			team: getTeamComposition("simple"),
		} as ComplexityAssessment;

		sessionLogger.info(
			{
				task: "Empty task description",
				assessmentType: "empty_task",
				recommendedModel: assessment.model,
			},
			"No task description provided - using default model",
		);

		return assessment;
	}

	// Check if local tools can handle it (FREE - no LLM needed)
	const localTool = canHandleWithLocalTools(task);
	if (localTool) {
		const assessment = {
			level: "trivial" as ComplexityLevel,
			confidence: 1.0,
			model: "sonnet", // Not used for local tools, but required field
			useFullChain: false,
			needsReview: false,
			estimatedScope: "single-file" as ComplexityAssessment["estimatedScope"],
			score: 0,
			signals: [`local-tool:${localTool.command}`],
			team: getTeamComposition("trivial"),
			localTool,
		} as ComplexityAssessment;

		sessionLogger.info(
			{
				task: task.slice(0, 50),
				assessmentType: "local_tool",
				recommendedModel: assessment.model,
				localToolCommand: localTool.command,
			},
			"Local tool detected - using minimal model",
		);

		return assessment;
	}

	const taskLower = task.toLowerCase();
	const signals: string[] = [];
	let score = 0;

	// Check each complexity level
	for (const [level, config] of Object.entries(COMPLEXITY_SIGNALS)) {
		// Check keywords
		for (const keyword of config.keywords) {
			if (taskLower.includes(keyword)) {
				signals.push(`${level}:keyword:${keyword}`);
				score += config.weight;
			}
		}

		// Check patterns
		for (const pattern of config.patterns) {
			if (pattern.test(task)) {
				signals.push(`${level}:pattern:${pattern.source}`);
				score += config.weight;
			}
		}
	}

	// Assess scope
	let estimatedScope: ComplexityAssessment["estimatedScope"] = "few-files";
	for (const [scope, keywords] of Object.entries(SCOPE_SIGNALS)) {
		for (const keyword of keywords) {
			if (taskLower.includes(keyword)) {
				estimatedScope = scope as ComplexityAssessment["estimatedScope"];
				signals.push(`scope:${scope}`);
				break;
			}
		}
	}

	// Scope affects score
	const scopeWeights: Record<string, number> = {
		"single-file": 0,
		"few-files": 1,
		"many-files": 2,
		"cross-package": 3,
	};
	score += scopeWeights[estimatedScope] || 0;

	// Task length is a weak signal of complexity
	const wordCount = task.split(/\s+/).length;
	if (wordCount > 50) {
		score += 1;
		signals.push("long-description");
	}
	if (wordCount > 100) {
		score += 1;
		signals.push("very-long-description");
	}

	// Check for risky keywords from operational learning
	// Keywords with historically low success rates indicate higher complexity
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const patterns = require("./task-file-patterns.js") as typeof import("./task-file-patterns.js");
		const store = patterns.loadTaskFileStore();
		const taskKeywords = patterns.extractTaskKeywords(task);

		for (const keyword of taskKeywords) {
			const correlation = store.keywordCorrelations[keyword];
			if (correlation && correlation.taskCount >= 3) {
				const successRate = correlation.successCount / correlation.taskCount;
				if (successRate < 0.5) {
					// Very risky keyword - add 2 to score
					score += 2;
					signals.push(`risky-keyword:${keyword}(${Math.round(successRate * 100)}%)`);
				} else if (successRate < 0.7) {
					// Moderately risky - add 1 to score
					score += 1;
					signals.push(`caution-keyword:${keyword}(${Math.round(successRate * 100)}%)`);
				}
			}
		}
	} catch {
		// Task-file patterns unavailable - continue without
	}

	// Determine level from score
	// Thresholds tuned for ~85-90% sonnet, 5-10% opus (haiku skipped)
	// Opus reserved for critical/high-stakes tasks only
	let level: ComplexityLevel;
	if (score <= 2) {
		level = "trivial";
	} else if (score <= 5) {
		level = "simple";
	} else if (score <= 8) {
		level = "standard";
	} else if (score <= 11) {
		level = "complex";
	} else {
		level = "critical";
	}

	const config = getLevelConfig(level);

	const assessment = {
		level,
		confidence: signals.length > 0 ? Math.min(0.9, 0.5 + signals.length * 0.1) : 0.3,
		model: config.model,
		useFullChain: config.useFullChain,
		needsReview: config.needsReview,
		estimatedScope,
		signals,
		score,
		team: getTeamComposition(level),
	};

	sessionLogger.info(
		{
			task: task.slice(0, 50),
			assessmentType: "keyword_assessment",
			level,
			recommendedModel: assessment.model,
			score,
			scope: estimatedScope,
		},
		"Complexity determined by keyword heuristics",
	);

	return assessment;
}

/**
 * Get accurate complexity assessment via Haiku analysis
 * Use case: when fast assessment confidence is low
 */
export const COMPLEXITY_LEVELS_GUIDE = {
	trivial: {
		description: "Minimal changes with low impact",
		examples: ["typos", "comments", "trivial fixes"],
	},
	simple: {
		description: "Small, localized changes",
		examples: ["add a log", "small changes", "single function updates"],
	},
	standard: {
		description: "Typical feature work or bug fixes",
		examples: ["feature implementation", "bug fix", "add tests"],
	},
	complex: {
		description: "Significant architectural or structural changes",
		examples: ["refactoring", "multi-file changes", "architectural redesign"],
	},
	critical: {
		description: "High-risk, sensitive, or potentially disruptive changes",
		examples: ["security updates", "authentication", "breaking changes", "production data handling"],
	},
};

export async function assessComplexityDeep(task: string): Promise<ComplexityAssessment> {
	// Start with fast assessment
	const fastAssessment = assessComplexityFast(task);

	// If confidence is high enough, trust it
	if (fastAssessment.confidence >= 0.7) {
		return fastAssessment;
	}

	// Use Ax/DSPy for self-improving complexity assessment
	try {
		const axResult = await checkComplexityAx(task);

		const level = axResult.level;
		const scope = axResult.scope;

		// Use shared level configuration
		const config = getLevelConfig(level);

		const assessment = {
			level,
			confidence: axResult.confidence,
			model: config.model,
			useFullChain: config.useFullChain,
			needsReview: config.needsReview,
			estimatedScope: scope,
			signals: [...fastAssessment.signals, `ax:${axResult.reasoning}`],
			score: fastAssessment.score,
			team: getTeamComposition(level),
		};

		sessionLogger.info(
			{
				task: task.slice(0, 50),
				assessmentType: "ax_assessment",
				level,
				recommendedModel: assessment.model,
				axReasoning: axResult.reasoning,
				scope,
			},
			"Complexity determined by Ax analysis",
		);

		return assessment;
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Deep complexity assessment failed, using fast assessment");
	}

	// Fall back to fast assessment
	return fastAssessment;
}

/**
 * Assess complexity via quantitative code analysis (preferred method)
 *
 * Method: actual code metrics vs keyword matching
 * Prerequisite: target files identified (via prepareContext or explicit list)
 *
 * @param task - Task description
 * @param targetFiles - Files likely affected (from context briefing)
 * @param repoRoot - Repository root directory
 */
export function assessComplexityQuantitative(
	task: string,
	targetFiles: string[],
	repoRoot: string = process.cwd(),
): ComplexityAssessment {
	// Get quantitative metrics from target files
	const metrics = getFileMetrics(targetFiles, repoRoot);
	const { score: metricsScore, signals: metricsSignals } = scoreFromMetrics(metrics);

	// Also get keyword-based signals (for critical/security detection)
	const keywordAssessment = assessComplexityFast(task);

	// Combine scores - metrics are primary, keywords add critical signals
	let combinedScore = metricsScore;
	const combinedSignals = [...metricsSignals];

	// Add critical keyword signals (security, auth, payment, etc.)
	const criticalSignals = keywordAssessment.signals.filter(
		(s) => s.startsWith("critical:") || s.includes("security") || s.includes("auth") || s.includes("payment"),
	);
	if (criticalSignals.length > 0) {
		combinedScore += criticalSignals.length * 2;
		combinedSignals.push(...criticalSignals);
	}

	// IMPORTANT: If task keywords indicate trivial/simple work, cap the level
	// This prevents large file metrics from overriding obviously simple tasks
	// e.g., "add a log statement" in a 5000-line file shouldn't be critical
	let levelCap: ComplexityLevel | null = null;
	if (keywordAssessment.level === "trivial") {
		levelCap = "simple"; // Trivial tasks cap at simple even in large files
		combinedSignals.push("keyword-cap:simple");
	} else if (keywordAssessment.level === "simple" && keywordAssessment.confidence >= 0.6) {
		levelCap = "standard"; // Simple tasks cap at standard
		combinedSignals.push("keyword-cap:standard");
	}

	// Determine level from combined score
	let level: ComplexityLevel;
	if (combinedScore <= 1) {
		level = "trivial";
	} else if (combinedScore <= 3) {
		level = "simple";
	} else if (combinedScore <= 6) {
		level = "standard";
	} else if (combinedScore <= 10) {
		level = "complex";
	} else {
		level = "critical";
	}

	// Apply level cap from keyword assessment
	if (levelCap) {
		const levelOrder: ComplexityLevel[] = ["trivial", "simple", "standard", "complex", "critical"];
		const capIndex = levelOrder.indexOf(levelCap);
		const levelIndex = levelOrder.indexOf(level);
		if (levelIndex > capIndex) {
			level = levelCap;
			combinedSignals.push(`capped-from:${levelOrder[levelIndex]}`);
		}
	}

	// Determine scope from metrics
	let estimatedScope: ComplexityAssessment["estimatedScope"];
	if (metrics.crossPackage) {
		estimatedScope = "cross-package";
	} else if (metrics.fileCount > 5) {
		estimatedScope = "many-files";
	} else if (metrics.fileCount > 1) {
		estimatedScope = "few-files";
	} else {
		estimatedScope = "single-file";
	}

	// Use shared level configuration
	const config = getLevelConfig(level);

	// Confidence is higher when we have good metrics
	const confidence = metrics.fileCount > 0 ? Math.min(0.95, 0.7 + metricsSignals.length * 0.05) : 0.5; // Low confidence if no files found

	const assessment = {
		level,
		confidence,
		model: config.model,
		useFullChain: config.useFullChain,
		needsReview: config.needsReview,
		estimatedScope,
		signals: combinedSignals,
		score: combinedScore,
		metrics,
		team: getTeamComposition(level),
	};

	sessionLogger.info(
		{
			task: task.slice(0, 50),
			assessmentType: "quantitative_assessment",
			level,
			recommendedModel: assessment.model,
			fileCount: metrics.fileCount,
			linesOfCode: metrics.totalLines,
			functionCount: metrics.functionCount,
			scope: estimatedScope,
			score: combinedScore,
		},
		"Complexity determined by quantitative analysis",
	);

	return assessment;
}

/**
 * Full complexity assessment pipeline
 *
 * Steps:
 * 1. prepareContext → identify target files
 * 2. getQuantitativeMetrics → analyze files
 * 3. combineWithKeywordSignals → critical detection
 *
 * Note: async due to prepareContext file I/O
 */
export async function assessComplexityFull(
	task: string,
	repoRoot: string = process.cwd(),
): Promise<ComplexityAssessment> {
	// Import prepareContext dynamically to avoid circular deps
	const { prepareContext } = await import("./context.js");

	try {
		// Get target files from context preparation
		const briefing = await prepareContext(task, { repoRoot });
		const targetFiles = briefing.targetFiles;

		if (targetFiles.length > 0) {
			// Use quantitative assessment
			const assessment = assessComplexityQuantitative(task, targetFiles, repoRoot);
			sessionLogger.info(
				{
					task: task.slice(0, 50),
					assessmentType: "context_preparation",
					targetFiles: targetFiles.length,
					recommendedModel: assessment.model,
					score: assessment.score,
				},
				"Complexity assessed using context preparation",
			);
			return assessment;
		}
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Context preparation failed, falling back to keyword assessment");
	}

	// Fall back to keyword-based assessment if no files found
	return assessComplexityFast(task);
}

/**
 * Recommend escalation from solo to full chain
 * Timing: after initial work, before finalizing
 */
export function shouldEscalateToFullChain(
	assessment: ComplexityAssessment,
	workResult: {
		filesChanged: number;
		linesChanged: number;
		hasTests: boolean;
		hasTypeErrors: boolean;
		hasBuildErrors: boolean;
	},
): boolean {
	// Always escalate if there are errors
	if (workResult.hasTypeErrors || workResult.hasBuildErrors) {
		return true;
	}

	// Escalate if scope was underestimated
	if (assessment.estimatedScope === "single-file" && workResult.filesChanged > 3) {
		return true;
	}

	if (assessment.estimatedScope === "few-files" && workResult.filesChanged > 10) {
		return true;
	}

	// Large changes without tests should be reviewed
	if (workResult.linesChanged > 200 && !workResult.hasTests) {
		return true;
	}

	// Complex/critical always gets full chain
	if (assessment.level === "complex" || assessment.level === "critical") {
		return true;
	}

	return false;
}
