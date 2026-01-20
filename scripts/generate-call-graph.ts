#!/usr/bin/env npx tsx
/**
 * Generate call-graph.json for learning system integration functions.
 *
 * This script parses TypeScript files to find where key integration functions
 * are called from, producing a machine-readable call graph.
 *
 * Usage: npx tsx scripts/generate-call-graph.ts
 * Output: .claude/call-graph.json
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Key integration functions to track
const TRACKED_FUNCTIONS = [
	// knowledge.ts
	"findRelevantLearnings",
	"formatLearningsForPrompt",
	"addLearning",
	"markLearningsUsed",

	// task-file-patterns.ts
	"findRelevantFiles",
	"formatFileSuggestionsForPrompt",
	"formatCoModificationHints",
	"recordTaskFiles",
	"findCoModifiedFiles",

	// error-fix-patterns.ts
	"tryAutoRemediate",
	"recordPendingError",
	"recordSuccessfulFix",
	"recordPermanentFailure",
	"getFailureWarningsForTask",

	// knowledge-extractor.ts
	"extractAndStoreLearnings",

	// capability-ledger.ts
	"updateLedger",
	"getRecommendedModel",

	// decision-tracker.ts
	"captureDecision",
	"resolveDecision",
	"getPendingDecisions",

	// automated-pm.ts
	"quickDecision",
	"pmDecide",
	"pmResearch",
	"pmPropose",
	"pmIdeate",

	// task-planner.ts
	"planTaskWithReview",
];

interface CallSite {
	file: string;
	line: number;
	context: string;
}

interface FunctionCallGraph {
	function: string;
	definedIn: string | null;
	calledFrom: CallSite[];
}

interface CallGraph {
	version: string;
	generatedAt: string;
	functions: FunctionCallGraph[];
}

function findDefinition(funcName: string): string | null {
	try {
		const result = execSync(
			`grep -rn "^export function ${funcName}\\|^export async function ${funcName}" src/ --include="*.ts" 2>/dev/null | head -1`,
			{ encoding: "utf-8" },
		).trim();

		if (result) {
			const match = result.match(/^([^:]+):/);
			return match ? match[1].replace("src/", "") : null;
		}
	} catch {
		// Function not found
	}
	return null;
}

function findCallSites(funcName: string): CallSite[] {
	const callSites: CallSite[] = [];

	try {
		// Find all usages (excluding the definition, imports, and test files)
		const result = execSync(
			`grep -rn "${funcName}(" src/ --include="*.ts" --exclude-dir="__tests__" 2>/dev/null || true`,
			{ encoding: "utf-8" },
		);

		for (const line of result.split("\n")) {
			if (!line.trim()) continue;

			const match = line.match(/^([^:]+):(\d+):(.*)$/);
			if (!match) continue;

			const [, file, lineNum, content] = match;
			const normalizedFile = file.replace("src/", "");

			// Skip definition lines and import statements
			if (content.includes("export function") || content.includes("export async function")) continue;
			if (content.includes("import ")) continue;

			// Extract context (function/method being called from)
			let context = "unknown";
			try {
				const fileContent = readFileSync(file, "utf-8").split("\n");
				const lineIndex = parseInt(lineNum, 10) - 1;

				// Look backwards for function/method definition
				for (let i = lineIndex; i >= 0 && i > lineIndex - 50; i--) {
					const l = fileContent[i];
					const funcMatch = l.match(
						/(?:private\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/,
					);
					if (funcMatch) {
						context = funcMatch[1];
						break;
					}
					const methodMatch = l.match(/(?:private\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)/);
					if (methodMatch && l.includes("{")) {
						context = methodMatch[1];
						break;
					}
				}
			} catch {
				// Can't read file
			}

			callSites.push({
				file: normalizedFile,
				line: parseInt(lineNum, 10),
				context,
			});
		}
	} catch {
		// Grep failed
	}

	return callSites;
}

function generateCallGraph(): CallGraph {
	const functions: FunctionCallGraph[] = [];

	for (const funcName of TRACKED_FUNCTIONS) {
		const definedIn = findDefinition(funcName);
		const calledFrom = findCallSites(funcName);

		functions.push({
			function: funcName,
			definedIn,
			calledFrom,
		});
	}

	return {
		version: "1.0",
		generatedAt: new Date().toISOString(),
		functions,
	};
}

// Main
const callGraph = generateCallGraph();

// Ensure .claude directory exists
const outputDir = join(process.cwd(), ".claude");
if (!existsSync(outputDir)) {
	mkdirSync(outputDir, { recursive: true });
}

const outputPath = join(outputDir, "call-graph.json");
writeFileSync(outputPath, JSON.stringify(callGraph, null, 2));

console.log(`Generated call graph at ${outputPath}`);
console.log(`Tracked ${callGraph.functions.length} functions`);

// Summary
const withCallers = callGraph.functions.filter((f) => f.calledFrom.length > 0);
const withoutCallers = callGraph.functions.filter((f) => f.calledFrom.length === 0);

console.log(`  - ${withCallers.length} have call sites`);
console.log(`  - ${withoutCallers.length} have no detected callers`);

if (withoutCallers.length > 0) {
	console.log("\nFunctions with no detected callers:");
	for (const f of withoutCallers) {
		console.log(`  - ${f.function} (defined in ${f.definedIn || "unknown"})`);
	}
}
