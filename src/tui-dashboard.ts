/**
 * TUI Dashboard Module
 *
 * Provides a terminal-based dashboard that combines:
 * - Status display (raid state, squad, waypoints, progress)
 * - Streaming logs in a scrolling area
 *
 * Uses ANSI escape codes for screen management without heavy dependencies.
 */

import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Persistence } from "./persistence.js";
import type { Raid, RaidStatus, SquadMember, Waypoint } from "./types.js";

/**
 * ANSI escape code helpers
 */
const ANSI = {
	clearScreen: "\x1b[2J",
	moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	clearLine: "\x1b[2K",
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
	saveCursor: "\x1b[s",
	restoreCursor: "\x1b[u",
	scrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
	resetScrollRegion: "\x1b[r",
};

/**
 * Dashboard configuration
 */
export interface DashboardConfig {
	/** Base directory for undercity state */
	stateDir?: string;
	/** Refresh interval in milliseconds */
	refreshInterval?: number;
	/** Number of log lines to display */
	logLines?: number;
	/** Whether to show detailed squad info */
	showSquadDetails?: boolean;
}

/**
 * Dashboard state for rendering
 */
interface DashboardState {
	raid: Raid | null;
	squad: SquadMember[];
	waypoints: Waypoint[];
	recentLogs: string[];
	lastUpdate: Date;
	terminalWidth: number;
	terminalHeight: number;
}

/**
 * TUI Dashboard
 *
 * Creates a split-screen terminal interface showing:
 * - Top: Status panel with raid info, progress bar, squad status
 * - Bottom: Scrolling log output
 */
export class TuiDashboard {
	private stateDir: string;
	private refreshInterval: number;
	private maxLogLines: number;
	private showSquadDetails: boolean;

	private persistence: Persistence;
	private state: DashboardState;
	private intervalId: NodeJS.Timeout | null = null;
	private isRunning = false;
	private logBuffer: string[] = [];
	private currentLogPath: string;

	constructor(config: DashboardConfig = {}) {
		this.stateDir = config.stateDir ?? ".undercity";
		this.refreshInterval = config.refreshInterval ?? 1000;
		this.maxLogLines = config.logLines ?? 15;
		this.showSquadDetails = config.showSquadDetails ?? true;

		this.persistence = new Persistence(this.stateDir);
		this.currentLogPath = join(this.stateDir, "logs", "current.log");

		this.state = {
			raid: null,
			squad: [],
			waypoints: [],
			recentLogs: [],
			lastUpdate: new Date(),
			terminalWidth: process.stdout.columns || 80,
			terminalHeight: process.stdout.rows || 24,
		};
	}

	/**
	 * Start the dashboard
	 */
	start(): void {
		if (this.isRunning) return;
		this.isRunning = true;

		// Handle terminal resize
		process.stdout.on("resize", () => {
			this.state.terminalWidth = process.stdout.columns || 80;
			this.state.terminalHeight = process.stdout.rows || 24;
			this.render();
		});

		// Handle exit gracefully
		process.on("SIGINT", () => this.stop());
		process.on("SIGTERM", () => this.stop());

		// Hide cursor and clear screen
		process.stdout.write(ANSI.hideCursor);
		process.stdout.write(ANSI.clearScreen);

		// Watch log file for changes
		if (existsSync(this.currentLogPath)) {
			this.loadRecentLogs();
			watchFile(this.currentLogPath, { interval: 500 }, () => {
				this.loadRecentLogs();
				this.render();
			});
		}

		// Initial render
		this.refreshState();
		this.render();

		// Start refresh interval
		this.intervalId = setInterval(() => {
			this.refreshState();
			this.render();
		}, this.refreshInterval);
	}

	/**
	 * Stop the dashboard
	 */
	stop(): void {
		if (!this.isRunning) return;
		this.isRunning = false;

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Stop watching log file
		if (existsSync(this.currentLogPath)) {
			unwatchFile(this.currentLogPath);
		}

		// Restore terminal state
		process.stdout.write(ANSI.resetScrollRegion);
		process.stdout.write(ANSI.showCursor);
		process.stdout.write(ANSI.clearScreen);
		process.stdout.write(ANSI.moveTo(1, 1));

		console.log(chalk.dim("Dashboard closed"));
	}

	/**
	 * Refresh state from persistence
	 */
	private refreshState(): void {
		try {
			const inventory = this.persistence.getInventory();
			this.state.raid = inventory.raid ?? null;
			this.state.squad = inventory.squad;
			this.state.waypoints = inventory.waypoints;
			this.state.lastUpdate = new Date();
		} catch {
			// Silently handle errors during refresh
		}
	}

	/**
	 * Load recent log entries
	 */
	private loadRecentLogs(): void {
		try {
			if (!existsSync(this.currentLogPath)) {
				this.state.recentLogs = [];
				return;
			}

			const content = readFileSync(this.currentLogPath, "utf-8");
			const lines = content.split("\n").filter((line) => line.trim());
			this.state.recentLogs = lines.slice(-this.maxLogLines);
		} catch {
			// Silently handle errors
		}
	}

	/**
	 * Render the full dashboard
	 */
	private render(): void {
		const { terminalWidth, terminalHeight } = this.state;

		// Calculate layout
		const statusHeight = this.calculateStatusHeight();
		const logHeight = terminalHeight - statusHeight - 2; // 2 for separator and padding

		// Clear and render status panel
		process.stdout.write(ANSI.moveTo(1, 1));
		this.renderStatusPanel(statusHeight);

		// Render separator
		const separatorRow = statusHeight + 1;
		process.stdout.write(ANSI.moveTo(separatorRow, 1));
		process.stdout.write(ANSI.clearLine);
		process.stdout.write(chalk.dim("─".repeat(terminalWidth)));

		// Render log panel
		this.renderLogPanel(separatorRow + 1, logHeight);
	}

	/**
	 * Calculate required height for status panel
	 */
	private calculateStatusHeight(): number {
		let height = 5; // Header + raid info + progress + padding

		if (this.state.squad.length > 0 && this.showSquadDetails) {
			height += Math.min(this.state.squad.length, 3) + 2; // Squad header + members
		}

		if (this.state.waypoints.length > 0) {
			height += Math.min(this.state.waypoints.length, 4) + 2; // Waypoints header + items
		}

		return Math.min(height, Math.floor(this.state.terminalHeight * 0.4));
	}

	/**
	 * Render the status panel
	 */
	private renderStatusPanel(maxRows: number): void {
		const { terminalWidth, raid, squad, waypoints } = this.state;
		let row = 1;

		// Header
		process.stdout.write(ANSI.moveTo(row, 1));
		process.stdout.write(ANSI.clearLine);
		const title = chalk.bold.cyan(" UNDERCITY DASHBOARD ");
		const timestamp = chalk.dim(new Date().toLocaleTimeString());
		const padding = " ".repeat(Math.max(0, terminalWidth - 24 - timestamp.length));
		process.stdout.write(`${title}${padding}${timestamp}`);
		row++;

		// Empty line
		process.stdout.write(ANSI.moveTo(row, 1));
		process.stdout.write(ANSI.clearLine);
		row++;

		if (!raid) {
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);
			process.stdout.write(chalk.gray(" No active raid"));
			row++;
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);
			process.stdout.write(chalk.dim(" Launch one with: undercity solo <goal>"));
			row++;
		} else {
			// Raid info
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);
			const statusStr = this.formatStatus(raid.status);
			process.stdout.write(` ${chalk.bold("Raid:")} ${raid.id.substring(0, 12)}  ${statusStr}`);
			row++;

			// Goal
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);
			const goalMaxLen = terminalWidth - 10;
			const goalDisplay = raid.goal.length > goalMaxLen ? `${raid.goal.substring(0, goalMaxLen - 3)}...` : raid.goal;
			process.stdout.write(` ${chalk.dim("Goal:")} ${goalDisplay}`);
			row++;

			// Progress bar
			if (waypoints.length > 0) {
				process.stdout.write(ANSI.moveTo(row, 1));
				process.stdout.write(ANSI.clearLine);
				const completed = waypoints.filter((w) => w.status === "complete").length;
				const progressBar = this.renderProgressBar(completed, waypoints.length, terminalWidth - 30);
				process.stdout.write(` ${chalk.dim("Progress:")} ${progressBar} ${completed}/${waypoints.length}`);
				row++;
			}

			// Squad section
			if (squad.length > 0 && this.showSquadDetails && row < maxRows - 3) {
				row++;
				process.stdout.write(ANSI.moveTo(row, 1));
				process.stdout.write(ANSI.clearLine);
				process.stdout.write(chalk.bold(" Squad"));
				row++;

				for (const member of squad.slice(0, 3)) {
					if (row >= maxRows) break;
					process.stdout.write(ANSI.moveTo(row, 1));
					process.stdout.write(ANSI.clearLine);
					const statusIcon = this.getMemberStatusIcon(member.status);
					const activity = member.waypoint ? chalk.dim(` → ${member.waypoint.description.substring(0, 40)}...`) : "";
					process.stdout.write(`  ${statusIcon} ${chalk.cyan(member.type)} ${activity}`);
					row++;
				}

				if (squad.length > 3) {
					process.stdout.write(ANSI.moveTo(row, 1));
					process.stdout.write(ANSI.clearLine);
					process.stdout.write(chalk.dim(`  ... and ${squad.length - 3} more`));
					row++;
				}
			}

			// Waypoints section
			if (waypoints.length > 0 && row < maxRows - 2) {
				row++;
				process.stdout.write(ANSI.moveTo(row, 1));
				process.stdout.write(ANSI.clearLine);
				const inProgress = waypoints.filter((w) => w.status === "in_progress").length;
				const pending = waypoints.filter((w) => w.status === "pending").length;
				process.stdout.write(chalk.bold(` Waypoints `) + chalk.dim(`(${inProgress} active, ${pending} pending)`));
				row++;

				const activeWaypoints = waypoints.filter((w) => w.status === "in_progress" || w.status === "assigned");
				for (const wp of activeWaypoints.slice(0, 3)) {
					if (row >= maxRows) break;
					process.stdout.write(ANSI.moveTo(row, 1));
					process.stdout.write(ANSI.clearLine);
					const icon = wp.status === "in_progress" ? chalk.yellow("🏃") : chalk.gray("○");
					const desc = wp.description.substring(0, terminalWidth - 10);
					process.stdout.write(`  ${icon} ${desc}`);
					row++;
				}
			}
		}

		// Clear remaining rows in status panel
		while (row <= maxRows) {
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);
			row++;
		}
	}

	/**
	 * Render the log panel
	 */
	private renderLogPanel(startRow: number, height: number): void {
		const { terminalWidth, recentLogs } = this.state;

		// Header
		process.stdout.write(ANSI.moveTo(startRow, 1));
		process.stdout.write(ANSI.clearLine);
		process.stdout.write(chalk.bold.dim(" Logs"));

		// Log lines
		const displayLogs = recentLogs.slice(-height + 1);
		for (let i = 0; i < height - 1; i++) {
			const row = startRow + 1 + i;
			process.stdout.write(ANSI.moveTo(row, 1));
			process.stdout.write(ANSI.clearLine);

			if (i < displayLogs.length) {
				const line = displayLogs[i];
				// Truncate and clean the line
				const cleanLine = this.cleanLogLine(line, terminalWidth - 2);
				process.stdout.write(` ${cleanLine}`);
			}
		}
	}

	/**
	 * Clean and truncate a log line
	 */
	private cleanLogLine(line: string, maxLen: number): string {
		// Remove ANSI codes for length calculation, but keep them for display
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control character matching
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		if (stripped.length <= maxLen) {
			return line;
		}
		// Truncate, being careful with ANSI codes
		return `${stripped.substring(0, maxLen - 3)}...`;
	}

	/**
	 * Render a progress bar
	 */
	private renderProgressBar(completed: number, total: number, width: number): string {
		const barWidth = Math.max(10, width);
		const percent = total > 0 ? completed / total : 0;
		const filled = Math.round(percent * barWidth);
		const empty = barWidth - filled;

		const filledBar = chalk.green("█".repeat(filled));
		const emptyBar = chalk.gray("░".repeat(empty));

		return `[${filledBar}${emptyBar}]`;
	}

	/**
	 * Format raid status with color
	 */
	private formatStatus(status: RaidStatus): string {
		const colors: Record<RaidStatus, (s: string) => string> = {
			planning: chalk.blue,
			awaiting_approval: chalk.yellow,
			executing: chalk.cyan,
			reviewing: chalk.magenta,
			merging: chalk.blue,
			merge_failed: chalk.red,
			extracting: chalk.green,
			complete: chalk.green,
			failed: chalk.red,
		};

		const color = colors[status] || chalk.white;
		return color(`[${status}]`);
	}

	/**
	 * Get status icon for squad member
	 */
	private getMemberStatusIcon(status: SquadMember["status"]): string {
		switch (status) {
			case "working":
				return chalk.yellow("🏃");
			case "done":
				return chalk.green("✓");
			case "error":
				return chalk.red("✗");
			case "stuck":
				return chalk.red("⚠");
			default:
				return chalk.gray("○");
		}
	}

	/**
	 * Write a log message to the dashboard
	 * Can be used to inject messages into the log stream
	 */
	writeLog(message: string): void {
		this.logBuffer.push(message);
		if (this.logBuffer.length > this.maxLogLines * 2) {
			this.logBuffer = this.logBuffer.slice(-this.maxLogLines);
		}
		this.state.recentLogs = [...this.state.recentLogs.slice(-this.maxLogLines + 1), message];
		if (this.isRunning) {
			this.render();
		}
	}
}

/**
 * Create and start a dashboard instance
 */
export function startDashboard(config?: DashboardConfig): TuiDashboard {
	const dashboard = new TuiDashboard(config);
	dashboard.start();
	return dashboard;
}

/**
 * Simple dashboard view for CLI (non-interactive)
 * Prints current status and recent logs, then exits
 */
export function printDashboardSnapshot(config?: DashboardConfig): void {
	const stateDir = config?.stateDir ?? ".undercity";
	const persistence = new Persistence(stateDir);
	const logPath = join(stateDir, "logs", "current.log");

	const inventory = persistence.getInventory();
	const raid = inventory.raid;
	const squad = inventory.squad;
	const waypoints = inventory.waypoints;

	console.log(chalk.bold.cyan("\n━━━ UNDERCITY DASHBOARD ━━━\n"));

	if (!raid) {
		console.log(chalk.gray("No active raid"));
		console.log(chalk.dim("Launch one with: undercity solo <goal>"));
	} else {
		// Raid info
		const statusColors: Record<RaidStatus, (s: string) => string> = {
			planning: chalk.blue,
			awaiting_approval: chalk.yellow,
			executing: chalk.cyan,
			reviewing: chalk.magenta,
			merging: chalk.blue,
			merge_failed: chalk.red,
			extracting: chalk.green,
			complete: chalk.green,
			failed: chalk.red,
		};
		const statusColor = statusColors[raid.status] || chalk.white;

		console.log(`${chalk.bold("Raid ID:")} ${raid.id}`);
		console.log(`${chalk.bold("Status:")}  ${statusColor(raid.status)}`);
		console.log(`${chalk.bold("Goal:")}    ${raid.goal}`);
		console.log(`${chalk.bold("Started:")} ${new Date(raid.startedAt).toLocaleString()}`);

		// Progress
		if (waypoints.length > 0) {
			const completed = waypoints.filter((w) => w.status === "complete").length;
			const percent = Math.round((completed / waypoints.length) * 100);
			const barLen = 20;
			const filled = Math.round((percent / 100) * barLen);
			const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(barLen - filled));
			console.log(`${chalk.bold("Progress:")} [${bar}] ${percent}% (${completed}/${waypoints.length})`);
		}

		// Squad
		if (squad.length > 0) {
			console.log(chalk.bold("\nSquad:"));
			for (const member of squad) {
				const statusIcon =
					member.status === "working"
						? chalk.yellow("🏃")
						: member.status === "done"
							? chalk.green("✓")
							: chalk.gray("○");
				console.log(`  ${statusIcon} ${chalk.cyan(member.type)} - ${member.status}`);
			}
		}

		// Active waypoints
		const activeWaypoints = waypoints.filter((w) => w.status === "in_progress" || w.status === "assigned");
		if (activeWaypoints.length > 0) {
			console.log(chalk.bold("\nActive Waypoints:"));
			for (const wp of activeWaypoints.slice(0, 5)) {
				console.log(`  ${chalk.yellow("🏃")} ${wp.description.substring(0, 60)}...`);
			}
		}
	}

	// Recent logs
	if (existsSync(logPath)) {
		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.split("\n").filter((line) => line.trim());
			const recentLines = lines.slice(-10);

			if (recentLines.length > 0) {
				console.log(chalk.bold("\nRecent Logs:"));
				console.log(chalk.dim("─".repeat(60)));
				for (const line of recentLines) {
					console.log(chalk.dim(line.substring(0, 80)));
				}
			}
		} catch {
			// Ignore log read errors
		}
	}

	console.log();
}
