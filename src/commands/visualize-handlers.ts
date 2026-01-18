/**
 * Command handlers for visualization commands
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getLatestSession, getSessionData, listGrindSessions, type VisualizationSession } from "../visualize.js";
import { generateVisualizationHTML } from "../visualize-html.js";

export interface VisualizeOptions {
	/** Show list of available sessions */
	list?: boolean;
	/** Specific session batch ID to visualize */
	session?: string;
	/** Open in browser after generating */
	open?: boolean;
	/** Custom output path */
	output?: string;
}

const VISUALIZATIONS_DIR = ".undercity/visualizations";

/**
 * Ensure the visualizations directory exists
 */
function ensureVisualizationsDir(): string {
	const dir = join(process.cwd(), VISUALIZATIONS_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Handle the visualize command
 */
export async function handleVisualize(options: VisualizeOptions): Promise<void> {
	// List mode: show available sessions
	if (options.list) {
		const sessions = listGrindSessions(20);
		if (sessions.length === 0) {
			console.log(chalk.yellow("No grind sessions found."));
			console.log(chalk.gray("Run `undercity grind` to generate session data."));
			return;
		}

		console.log(chalk.bold("Available Sessions:"));
		console.log();
		for (const batchId of sessions) {
			const session = getSessionData(batchId);
			if (session) {
				const status = session.endedAt ? chalk.green("complete") : chalk.yellow("in progress");
				const stats = `${session.stats.successful}/${session.stats.total} tasks`;
				const time = session.startedAt.toLocaleString();
				console.log(`  ${chalk.cyan(batchId)}`);
				console.log(`    ${status} | ${stats} | ${time}`);
			} else {
				console.log(`  ${chalk.cyan(batchId)} ${chalk.gray("(no data)")}`);
			}
		}
		console.log();
		console.log(chalk.gray("Use `undercity visualize -s <batch-id>` to visualize a specific session."));
		return;
	}

	// Get session data
	let session: VisualizationSession | null;
	if (options.session) {
		session = getSessionData(options.session);
		if (!session) {
			console.error(chalk.red(`Session not found: ${options.session}`));
			console.log(chalk.gray("Use `undercity visualize --list` to see available sessions."));
			process.exit(1);
		}
	} else {
		session = getLatestSession();
		if (!session) {
			console.log(chalk.yellow("No grind sessions found."));
			console.log(chalk.gray("Run `undercity grind` to generate session data."));
			return;
		}
	}

	// Generate HTML
	const html = generateVisualizationHTML(session);

	// Determine output path
	const outputDir = ensureVisualizationsDir();
	const outputPath = options.output || join(outputDir, `session-${session.batchId}.html`);

	// Write file
	writeFileSync(outputPath, html, "utf-8");
	console.log(chalk.green(`Visualization saved to: ${outputPath}`));

	// Print summary
	console.log();
	console.log(chalk.bold("Session Summary:"));
	console.log(`  Batch ID: ${chalk.cyan(session.batchId)}`);
	console.log(`  Duration: ${session.durationMins}m`);
	console.log(`  Tasks: ${session.stats.successful}/${session.stats.total} successful`);
	console.log(`  Tokens: ${session.stats.totalTokens.toLocaleString()}`);

	// Open in browser if requested
	if (options.open) {
		console.log();
		console.log(chalk.gray("Opening in browser..."));
		try {
			const platform = process.platform;
			const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
			execSync(`${cmd} "${outputPath}"`, { stdio: "ignore" });
		} catch {
			console.log(chalk.yellow(`Could not open browser. Open manually: ${outputPath}`));
		}
	}
}
