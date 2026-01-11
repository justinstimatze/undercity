/**
 * Shared utilities for command modules
 */
import chalk from "chalk";
import type { RaidStatus } from "../types.js";

/**
 * Deprecation warning helper
 */
export function showDeprecationWarning(command: string, alternative: string): void {
	console.log(chalk.yellow.bold("\n⚠️  DEPRECATED COMMAND"));
	console.log(chalk.yellow(`   '${command}' uses the legacy raid workflow.`));
	console.log(chalk.yellow(`   Recommended: ${chalk.cyan(alternative)}`));
	console.log(chalk.dim("   The raid system will be removed in a future version.\n"));
}

/**
 * Status color mapping
 */
export function statusColor(status: RaidStatus): string {
	switch (status) {
		case "planning":
			return chalk.blue(status);
		case "awaiting_approval":
			return chalk.yellow(status);
		case "executing":
			return chalk.cyan(status);
		case "reviewing":
			return chalk.magenta(status);
		case "merging":
			return chalk.blue(status);
		case "extracting":
			return chalk.green(status);
		case "complete":
			return chalk.green(status);
		case "failed":
			return chalk.red(status);
		default:
			return status;
	}
}