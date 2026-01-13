/**
 * Efficiency Tools Module
 *
 * Provides information about available CLI tools that agents can use
 * for faster, more reliable code transformations via Bash.
 *
 * These tools are OPTIONAL - agents can always fall back to manual edits.
 * But when available, they're faster and more reliable for certain tasks.
 */

import { execSync } from "node:child_process";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "efficiency-tools" });

/**
 * Tool definition with availability check and usage examples
 */
interface EfficiencyTool {
	name: string;
	description: string;
	checkCommand: string;
	/** When to use this tool */
	useCases: string[];
	/** Example commands */
	examples: string[];
	/** Install hint if not available */
	installHint: string;
}

/**
 * Available efficiency tools
 */
const TOOLS: EfficiencyTool[] = [
	{
		name: "ast-grep",
		description: "Structural code search and replace using AST patterns",
		checkCommand: "ast-grep --version",
		useCases: [
			"Renaming functions/variables across files",
			"Removing console.log statements",
			"Changing function signatures",
			"Pattern-based refactoring",
		],
		examples: [
			"ast-grep --pattern 'console.log($$$)' --rewrite '' --lang ts . --update-all",
			"ast-grep --pattern '$FUNC($$$ARGS)' --rewrite 'newFunc($$$ARGS)' --lang ts src/",
			"ast-grep --pattern 'oldName' --rewrite 'newName' --lang ts file.ts --update-all",
		],
		installHint: "cargo install ast-grep (requires Rust)",
	},
	{
		name: "jq",
		description: "JSON processor for precise JSON manipulation",
		checkCommand: "jq --version",
		useCases: [
			"Updating specific fields in JSON/package.json",
			"Adding/removing array elements",
			"Transforming JSON structure",
			"Extracting data from JSON",
		],
		examples: [
			"jq '.version = \"1.2.3\"' package.json > tmp && mv tmp package.json",
			"jq '.scripts.test = \"vitest\"' package.json | sponge package.json",
			"jq 'del(.devDependencies.oldPkg)' package.json > tmp && mv tmp package.json",
		],
		installHint: "apt install jq / brew install jq",
	},
	{
		name: "comby",
		description: "Language-agnostic structural search and replace",
		checkCommand: "comby --version",
		useCases: ["Cross-language refactoring", "Simpler patterns than ast-grep", "Template-based transformations"],
		examples: [
			"comby 'console.log(:[args])' '' .ts -in-place",
			"comby 'function :[name](:[params])' 'const :[name] = (:[params]) =>' .ts",
			"comby 'import { :[x] } from \"old\"' 'import { :[x] } from \"new\"' .ts -in-place",
		],
		installHint: "bash <(curl -sL get.comby.dev)",
	},
	{
		name: "biome",
		description: "Fast formatter and linter (Rust-based)",
		checkCommand: "pnpm biome --version",
		useCases: ["Auto-formatting after changes", "Quick lint fixes", "Consistent code style"],
		examples: [
			"pnpm biome format --write src/file.ts",
			"pnpm biome check --fix src/",
			"pnpm biome lint --fix src/file.ts",
		],
		installHint: "Usually available via pnpm in this project",
	},
	{
		name: "sd",
		description: "Simple, fast find-and-replace (sed alternative)",
		checkCommand: "sd --version",
		useCases: ["Simple string replacements", "Faster than sed for basic cases", "Regex replacements"],
		examples: [
			"sd 'oldString' 'newString' src/**/*.ts",
			"sd 'v1\\.0' 'v2.0' package.json",
			"sd -F 'exact match' 'replacement' file.ts",
		],
		installHint: "cargo install sd",
	},
];

/**
 * Check if a tool is available
 */
function isToolAvailable(tool: EfficiencyTool): boolean {
	try {
		execSync(tool.checkCommand, { stdio: "pipe", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Cached tool availability (checked once per process)
 */
let cachedAvailability: Map<string, boolean> | null = null;

/**
 * Get availability of all tools (cached)
 */
export function getToolAvailability(): Map<string, boolean> {
	if (cachedAvailability) {
		return cachedAvailability;
	}

	cachedAvailability = new Map();
	for (const tool of TOOLS) {
		const available = isToolAvailable(tool);
		cachedAvailability.set(tool.name, available);
		if (available) {
			logger.debug({ tool: tool.name }, "Efficiency tool available");
		}
	}

	return cachedAvailability;
}

/**
 * Get list of available tools
 */
export function getAvailableTools(): EfficiencyTool[] {
	const availability = getToolAvailability();
	return TOOLS.filter((tool) => availability.get(tool.name));
}

/**
 * Generate prompt section describing available efficiency tools
 *
 * This is injected into the agent prompt so it knows what tools are available
 * and how to use them via Bash.
 */
export function generateToolsPrompt(): string {
	const available = getAvailableTools();

	if (available.length === 0) {
		return "";
	}

	const sections: string[] = [
		"## Efficiency Tools (via Bash)",
		"",
		"These CLI tools are available for faster code transformations.",
		"Use them via `Bash` when appropriate - they're faster and more reliable than manual edits for certain tasks.",
		"",
	];

	for (const tool of available) {
		sections.push(`### ${tool.name}`);
		sections.push(tool.description);
		sections.push("");
		sections.push("**When to use:**");
		for (const useCase of tool.useCases) {
			sections.push(`- ${useCase}`);
		}
		sections.push("");
		sections.push("**Examples:**");
		sections.push("```bash");
		for (const example of tool.examples) {
			sections.push(example);
		}
		sections.push("```");
		sections.push("");
	}

	sections.push("**Note:** Always verify changes with `git diff` after using these tools.");

	return sections.join("\n");
}

/**
 * Get a quick reference for a specific tool
 */
export function getToolQuickRef(toolName: string): string | null {
	const tool = TOOLS.find((t) => t.name === toolName);
	if (!tool) return null;

	const availability = getToolAvailability();
	if (!availability.get(toolName)) return null;

	return [`${tool.name}: ${tool.description}`, `Examples: ${tool.examples[0]}`].join("\n");
}

/**
 * Check if any efficiency tools are available
 */
export function hasAnyTools(): boolean {
	return getAvailableTools().length > 0;
}
