import { writeFileSync } from "node:fs";
import { SemanticAnalyzer } from "./analyzer.js";
import type { SemanticReport } from "./types.js";

export interface CLIOptions {
	rootDir: string;
	output?: string;
	fix?: boolean;
	human?: boolean;
	summary?: boolean;
}

export async function runSemanticCheck(options: CLIOptions): Promise<SemanticReport> {
	const analyzer = new SemanticAnalyzer();

	const report = await analyzer.analyze({
		rootDir: options.rootDir,
	});

	// Output report
	if (options.output) {
		writeFileSync(options.output, JSON.stringify(report, null, 2));
	}

	if (options.human) {
		printHumanReport(report);
	} else if (options.summary) {
		printSummaryReport(report);
	} else if (!options.output) {
		console.log(JSON.stringify(report, null, 2));
	}

	return report;
}

function printSummaryReport(report: SemanticReport): void {
	const high = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "high").length, 0);
	const medium = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "medium").length, 0);
	const low = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "low").length, 0);

	console.log(`Files: ${report.files.length} | Issues: ${high} high, ${medium} medium, ${low} low`);
	console.log(
		`Tokens: ${report.metrics.totalTokens} | Facts: ${report.metrics.totalFacts} | Density: ${report.metrics.avgDensity.toFixed(2)}`,
	);

	if (high > 0) {
		console.log("\nHigh priority:");
		const seen = new Set<string>();
		for (const file of report.files) {
			for (const issue of file.issues.filter((i) => i.severity === "high")) {
				const key = `${issue.type}:${issue.message}`;
				if (!seen.has(key)) {
					seen.add(key);
					console.log(`  ${file.path}:${issue.line || 0} ${issue.type}`);
				}
				if (seen.size >= 10) break;
			}
			if (seen.size >= 10) break;
		}
		if (high > 10) console.log(`  ... and ${high - 10} more`);
	}

	if (medium > 0 && high === 0) {
		console.log("\nMedium priority:");
		let count = 0;
		for (const file of report.files) {
			for (const issue of file.issues.filter((i) => i.severity === "medium")) {
				console.log(`  ${file.path}:${issue.line || 0} ${issue.type}`);
				if (++count >= 5) break;
			}
			if (count >= 5) break;
		}
		if (medium > 5) console.log(`  ... and ${medium - 5} more`);
	}
}

function printHumanReport(report: SemanticReport): void {
	console.log("📊 Semantic Density Report\n");

	// Summary
	console.log("Summary:");
	console.log(`  Total tokens: ${report.metrics.totalTokens}`);
	console.log(`  Total facts: ${report.metrics.totalFacts}`);
	console.log(`  Avg density: ${report.metrics.avgDensity.toFixed(3)} facts/1k tokens`);
	console.log(
		`  Potential savings: ${report.metrics.potentialSavings} tokens (${report.metrics.savingsPercent.toFixed(1)}%)\n`,
	);

	// Files by type
	console.log("Files by type:");
	for (const [type, count] of Object.entries(report.metrics.filesByType)) {
		if (count > 0) {
			console.log(`  ${type}: ${count}`);
		}
	}
	console.log();

	// Issues by type
	console.log("Issues by type:");
	for (const [type, count] of Object.entries(report.metrics.issuesByType)) {
		console.log(`  ${type}: ${count}`);
	}
	console.log();

	// Top issues
	console.log("Files with most issues:");
	const filesByIssues = report.files
		.filter((f) => f.issues.length > 0)
		.sort((a, b) => b.issues.length - a.issues.length)
		.slice(0, 10);

	for (const file of filesByIssues) {
		console.log(`  ${file.path}: ${file.issues.length} issues`);
	}
	console.log();

	// Redundancies
	if (report.redundancies.length > 0) {
		console.log("Redundancies:");
		for (const redundancy of report.redundancies) {
			console.log(`  ${redundancy.fact}: ${redundancy.locations.length} locations`);
		}
		console.log();
	}

	// Actions
	console.log(`${report.actions.length} actions available`);
	const highPriority = report.actions.filter((a) => a.priority === "high");
	if (highPriority.length > 0) {
		console.log(`  ${highPriority.length} high priority`);
	}
}

export function printMachineReport(report: SemanticReport): void {
	// ESLint-style output for CI/agent consumption
	for (const file of report.files) {
		for (const issue of file.issues) {
			const location = issue.line
				? `${file.path}:${issue.line}:1`
				: issue.startLine
					? `${file.path}:${issue.startLine}-${issue.endLine}:1`
					: `${file.path}`;

			console.log(`${location}  ${issue.severity}  ${issue.type}  ${issue.message}`);
		}
	}

	// Summary
	console.log();
	const totalIssues = report.files.reduce((sum, f) => sum + f.issues.length, 0);
	const high = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "high").length, 0);
	const medium = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "medium").length, 0);
	const low = report.files.reduce((sum, f) => sum + f.issues.filter((i) => i.severity === "low").length, 0);

	console.log(`${totalIssues} issues (${high} high, ${medium} medium, ${low} low)`);
	console.log(
		`Potential savings: ${report.metrics.potentialSavings} tokens (${report.metrics.savingsPercent.toFixed(1)}%)`,
	);
}
