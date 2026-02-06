/**
 * Daemon Command Helpers
 *
 * Extracted helper functions for the daemon command to reduce complexity
 * and improve testability.
 */

import chalk from "chalk";

/**
 * Daemon status response structure
 */
export interface DaemonStatus {
	daemon: {
		port: number;
		pid: number;
		uptime: number;
		paused: boolean;
	};
	session: {
		id: string;
		goal: string;
	} | null;
	agents: Array<{
		type: string;
		status: string;
	}>;
	tasks: {
		pending: number;
		inProgress: number;
		complete: number;
	};
}

/**
 * Check if daemon is running and display message if not
 * @returns true if daemon is running, false otherwise
 */
export function checkDaemonRunning(isDaemonRunning: () => boolean, showStartHint = true): boolean {
	if (!isDaemonRunning()) {
		console.log(chalk.gray("Daemon not running"));
		if (showStartHint) {
			console.log(chalk.dim("Start with: undercity serve"));
		}
		return false;
	}
	return true;
}

/**
 * Display daemon status in human-readable format
 */
export function displayDaemonStatus(status: DaemonStatus): void {
	const { daemon, session, agents, tasks } = status;

	console.log(chalk.green.bold("✓ Daemon Running"));
	console.log(chalk.dim(`  Port: ${daemon.port} | PID: ${daemon.pid}`));
	console.log(chalk.dim(`  Uptime: ${Math.round(daemon.uptime)}s`));
	console.log(chalk.dim(`  State: ${daemon.paused ? chalk.yellow("PAUSED") : chalk.green("active")}`));

	if (session) {
		console.log();
		console.log(chalk.bold("Session:"));
		console.log(chalk.dim(`  ${session.id}: ${session.goal}`));
	}

	if (agents && agents.length > 0) {
		console.log();
		console.log(chalk.bold(`Agents (${agents.length}):`));
		for (const a of agents) {
			console.log(chalk.dim(`  ${a.type}: ${a.status}`));
		}
	}

	console.log();
	console.log(chalk.bold("Tasks:"));
	console.log(chalk.dim(`  ${tasks.pending} pending, ${tasks.inProgress} in progress, ${tasks.complete} complete`));
}

/**
 * Display daemon action result
 */
export function displayDaemonActionResult(action: string, wasSuccessful: boolean, message?: string): void {
	const messages: Record<string, { success: string; color: typeof chalk.green }> = {
		stop: { success: "Daemon stopped", color: chalk.green },
		pause: { success: "Grind paused", color: chalk.yellow },
		resume: { success: "Grind resumed", color: chalk.green },
		drain: { success: "Drain initiated - finishing current tasks, starting no more", color: chalk.yellow },
	};

	const config = messages[action];
	if (config && wasSuccessful) {
		console.log(config.color(message || config.success));
	}
}

/**
 * Handle a daemon action (stop, pause, resume, drain)
 */
export async function executeDaemonAction(
	action: "stop" | "pause" | "resume" | "drain",
	queryDaemon: (path: string, method?: "POST" | "GET") => Promise<unknown>,
): Promise<void> {
	const endpoint = `/${action}`;

	try {
		await queryDaemon(endpoint, "POST");
		displayDaemonActionResult(action, true);
	} catch {
		// For stop action, error is expected as daemon shuts down
		if (action === "stop") {
			displayDaemonActionResult(action, true);
		} else {
			throw new Error(`Failed to ${action} daemon`);
		}
	}
}
