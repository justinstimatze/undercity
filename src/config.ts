/**
 * Configuration File Support
 *
 * Loads configuration from .undercityrc (JSON format) to provide
 * default options for CLI commands like --stream, model choices, etc.
 *
 * Configuration is loaded from (in order of precedence, highest first):
 * 1. CLI flags (always override)
 * 2. .undercityrc in current directory
 * 3. .undercityrc in home directory
 * 4. Built-in defaults
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Model tier options
 */
export type ModelTier = "haiku" | "sonnet" | "opus";

/**
 * Worker model options (haiku or sonnet only)
 */
export type WorkerModel = "haiku" | "sonnet";

/**
 * Configuration interface for .undercityrc
 */
export interface UndercityRc {
	// Output options
	stream?: boolean;
	verbose?: boolean;

	// Model configuration
	model?: ModelTier;
	worker?: WorkerModel;

	// Execution options
	autoCommit?: boolean;
	typecheck?: boolean;
	local?: boolean;
	review?: boolean;
	annealing?: boolean;
	supervised?: boolean;

	// Grind options
	parallel?: number;
	/** Push to remote after successful merge (default: false) */
	push?: boolean;

	// Verification retry options
	/** Maximum attempts per task before failing (default: 3) */
	maxAttempts?: number;
	/** Maximum fix attempts at the same model tier before escalating (default: 3) */
	maxRetriesPerTier?: number;
	/** Maximum review passes per tier before escalating (default: 2) */
	maxReviewPassesPerTier?: number;
	/** Maximum review passes at opus tier (default: 6) */
	maxOpusReviewPasses?: number;

	// Legacy session options
	autoApprove?: boolean;
	maxSquad?: number;
	maxRetries?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<UndercityRc> = {
	stream: false,
	verbose: false,
	model: "sonnet",
	worker: "sonnet",
	autoCommit: true,
	typecheck: true,
	local: true,
	review: false,
	annealing: false,
	supervised: false,
	parallel: 1,
	push: false,
	maxAttempts: 3,
	maxRetriesPerTier: 3,
	maxReviewPassesPerTier: 2,
	maxOpusReviewPasses: 6,
	autoApprove: false,
	maxSquad: 5,
	maxRetries: 3,
};

/**
 * Valid model tiers for validation
 */
const VALID_MODEL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus"];
const VALID_WORKER_MODELS: WorkerModel[] = ["haiku", "sonnet"];

/**
 * Cached configuration to avoid repeated file reads
 */
let cachedConfig: UndercityRc | null = null;
let configLoadedFrom: string | null = null;

/**
 * Type guard for model tier
 */
function isValidModelTier(value: unknown): value is ModelTier {
	return typeof value === "string" && VALID_MODEL_TIERS.includes(value as ModelTier);
}

/**
 * Type guard for worker model
 */
function isValidWorkerModel(value: unknown): value is WorkerModel {
	return typeof value === "string" && VALID_WORKER_MODELS.includes(value as WorkerModel);
}

/**
 * Validate and sanitize config object
 */
function validateConfig(raw: unknown, filePath: string): UndercityRc | null {
	if (typeof raw !== "object" || raw === null) {
		console.warn(`Warning: Config in ${filePath} is not an object`);
		return null;
	}

	const config: UndercityRc = {};
	const obj = raw as Record<string, unknown>;
	const warnings: string[] = [];

	// Boolean options
	const booleanKeys: (keyof UndercityRc)[] = [
		"stream",
		"verbose",
		"autoCommit",
		"typecheck",
		"local",
		"review",
		"annealing",
		"supervised",
		"autoApprove",
		"push",
	];

	for (const key of booleanKeys) {
		if (key in obj) {
			if (typeof obj[key] === "boolean") {
				(config as Record<string, boolean>)[key] = obj[key] as boolean;
			} else {
				warnings.push(`${key}: expected boolean, got ${typeof obj[key]}`);
			}
		}
	}

	// Number options
	const numberKeys: { key: keyof UndercityRc; min: number; max: number }[] = [
		{ key: "parallel", min: 1, max: 10 },
		{ key: "maxAttempts", min: 1, max: 20 },
		{ key: "maxRetriesPerTier", min: 1, max: 10 },
		{ key: "maxReviewPassesPerTier", min: 1, max: 10 },
		{ key: "maxOpusReviewPasses", min: 1, max: 20 },
		{ key: "maxSquad", min: 1, max: 10 },
		{ key: "maxRetries", min: 0, max: 10 },
	];

	for (const { key, min, max } of numberKeys) {
		if (key in obj) {
			const val = obj[key];
			if (typeof val === "number" && Number.isInteger(val) && val >= min && val <= max) {
				(config as Record<string, number>)[key] = val;
			} else {
				warnings.push(`${key}: expected integer between ${min} and ${max}`);
			}
		}
	}

	// Model tier
	if ("model" in obj) {
		if (isValidModelTier(obj.model)) {
			config.model = obj.model;
		} else {
			warnings.push(`model: expected one of ${VALID_MODEL_TIERS.join(", ")}`);
		}
	}

	// Worker model
	if ("worker" in obj) {
		if (isValidWorkerModel(obj.worker)) {
			config.worker = obj.worker;
		} else {
			warnings.push(`worker: expected one of ${VALID_WORKER_MODELS.join(", ")}`);
		}
	}

	// Log any warnings
	if (warnings.length > 0) {
		console.warn(`Warning: Invalid config values in ${filePath}:`);
		for (const warning of warnings) {
			console.warn(`  - ${warning}`);
		}
	}

	return config;
}

/**
 * Try to read and parse a config file
 */
function tryReadConfig(filePath: string): UndercityRc | null {
	try {
		if (!fs.existsSync(filePath)) {
			return null;
		}

		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		return validateConfig(parsed, filePath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			console.warn(`Warning: Invalid JSON in ${filePath}: ${error.message}`);
		}
		return null;
	}
}

/**
 * Load configuration from .undercityrc files
 *
 * Searches for config in order:
 * 1. Current directory .undercityrc
 * 2. Home directory .undercityrc
 *
 * Returns merged config with defaults
 */
export function loadConfig(forceReload = false): Required<UndercityRc> {
	if (cachedConfig && !forceReload) {
		return { ...DEFAULT_CONFIG, ...cachedConfig };
	}

	// Start with empty config (will merge with defaults at the end)
	let config: UndercityRc = {};

	// Try home directory first (lower precedence)
	const homeConfigPath = path.join(os.homedir(), ".undercityrc");
	const homeConfig = tryReadConfig(homeConfigPath);
	if (homeConfig) {
		config = { ...config, ...homeConfig };
		configLoadedFrom = homeConfigPath;
	}

	// Try current directory (higher precedence)
	const cwdConfigPath = path.join(process.cwd(), ".undercityrc");
	const cwdConfig = tryReadConfig(cwdConfigPath);
	if (cwdConfig) {
		config = { ...config, ...cwdConfig };
		configLoadedFrom = cwdConfigPath;
	}

	cachedConfig = config;
	return { ...DEFAULT_CONFIG, ...config };
}

/**
 * Get the path where config was loaded from (for debugging)
 */
export function getConfigSource(): string | null {
	return configLoadedFrom;
}

/**
 * Merge CLI options with config file defaults
 *
 * CLI options (when explicitly set) override config file values.
 * This function handles the precedence logic.
 *
 * @param cliOptions - Options from commander CLI
 * @returns Merged options with config defaults applied
 */
export function mergeWithConfig<T extends Record<string, unknown>>(cliOptions: T): T & Required<UndercityRc> {
	const config = loadConfig();

	// Create a new object starting with config defaults
	const merged = { ...config } as T & Required<UndercityRc>;

	// Override with CLI options that are explicitly set
	// Commander sets undefined for unset options, so we check for that
	for (const [key, value] of Object.entries(cliOptions)) {
		if (value !== undefined) {
			(merged as Record<string, unknown>)[key] = value;
		}
	}

	return merged;
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
	cachedConfig = null;
	configLoadedFrom = null;
}

/**
 * Get default config values (for documentation)
 */
export function getDefaultConfig(): Required<UndercityRc> {
	return { ...DEFAULT_CONFIG };
}
