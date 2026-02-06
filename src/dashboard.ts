/**
 * UNDERCITY DASHBOARD
 *
 * Honest TUI for monitoring grind operations.
 * Shows ONLY real data. No fake animations.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import blessed from "blessed";
import * as contrib from "blessed-contrib";
import { getMainWorktreePath, type LiveMetrics } from "./live-metrics.js";

// Type helpers for blessed-contrib widgets
interface LogWidget {
	log(msg: string): void;
	setContent(content: string): void;
}

interface GaugeWidget {
	setPercent(percent: number): void;
}

// Read last N lines from a file
function tailFile(filePath: string, lines: number = 10): string[] {
	try {
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8");
		const allLines = content.split("\n").filter(Boolean);
		return allLines.slice(-lines);
	} catch {
		return [];
	}
}

// Check for active worktrees
function getActiveWorktrees(): string[] {
	try {
		const result = execFileSync("git", ["worktree", "list", "--porcelain"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
		});
		// Parse porcelain format: lines starting with "worktree " contain the path
		const trees = result
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.substring(9)) // Remove "worktree " prefix
			.filter((path) => path.includes("undercity-wt-"));
		return trees;
	} catch {
		return [];
	}
}

// Get file modification time
function getFileMtime(filePath: string): number {
	try {
		if (!existsSync(filePath)) return 0;
		return statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

// Load live metrics from file (use main worktree path for consistency)
function loadLiveMetrics(): LiveMetrics | null {
	try {
		const basePath = getMainWorktreePath();
		const metricsPath = join(basePath, ".undercity", "live-metrics.json");
		if (!existsSync(metricsPath)) return null;
		const content = readFileSync(metricsPath, "utf-8");
		return JSON.parse(content) as LiveMetrics;
	} catch {
		return null;
	}
}

interface WorkerInfo {
	pid: number;
	model: string;
}

export function launchDashboard(): void {
	const screen = blessed.screen({
		smartCSR: true,
		title: "UNDERCITY",
		fullUnicode: true,
	});

	const grid = new contrib.grid({ rows: 12, cols: 12, screen });

	// HEADER
	const headerBox = grid.set(0, 0, 1, 12, blessed.box, {
		tags: true,
		style: { fg: "green", bg: "black" },
	}) as LogWidget;

	// LEFT - WORKERS
	const workersBox = grid.set(1, 0, 3, 4, blessed.box, {
		label: " WORKERS ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "green" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// LEFT BOTTOM - SDK METRICS
	const metricsBox = grid.set(4, 0, 3, 4, blessed.box, {
		label: " SDK METRICS ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "cyan",
			bg: "black",
			border: { fg: "cyan" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// CENTER TOP - FILE OUTPUT
	const logBox = grid.set(1, 4, 3, 5, blessed.log, {
		label: " OUTPUT ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "cyan" },
			label: { fg: "white", bold: true },
		},
		scrollable: true,
		alwaysScroll: true,
		scrollbar: { ch: "█", fg: "cyan" },
	}) as LogWidget;

	// CENTER BOTTOM - MODEL BREAKDOWN
	const modelBox = grid.set(4, 4, 3, 5, blessed.box, {
		label: " BY MODEL ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "magenta",
			bg: "black",
			border: { fg: "magenta" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// RIGHT - BURN RATE GAUGE
	const burnGauge = grid.set(1, 9, 3, 3, contrib.gauge, {
		label: " BURN RATE ",
		stroke: "cyan",
		fill: "black",
		border: { type: "line" },
		style: { border: { fg: "cyan" } },
	}) as GaugeWidget;

	// RIGHT BOTTOM - CACHE EFFICIENCY GAUGE
	const cacheGauge = grid.set(4, 9, 3, 3, contrib.gauge, {
		label: " CACHE % ",
		stroke: "green",
		fill: "black",
		border: { type: "line" },
		style: { border: { fg: "green" } },
	}) as GaugeWidget;

	// MIDDLE - GIT
	const commitsBox = grid.set(7, 0, 2, 6, blessed.box, {
		label: " GIT ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "yellow" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// MIDDLE RIGHT - TASKS
	const taskBox = grid.set(7, 6, 2, 6, blessed.box, {
		label: " TASKS ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "magenta" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// BOTTOM - EVENTS LOG
	const activityLog = grid.set(9, 0, 3, 12, blessed.log, {
		label: " EVENTS ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "green" },
			label: { fg: "white", bold: true },
		},
		scrollable: true,
		alwaysScroll: true,
		mouse: true,
	}) as LogWidget;

	// STATE
	let lastCommitSha = "";
	let lastLogLines: string[] = [];
	let lastLogMtime = 0;
	let lastMetricsMtime = 0;
	let _outputLineCount = 0;

	function getWorkers(): WorkerInfo[] {
		try {
			const ps = execFileSync("pgrep", ["-f", "undercity.*grind"], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
			}).trim();

			if (!ps) return [];

			const grindPid = ps.split("\n")[0];
			const pstree = execFileSync("pstree", ["-p", grindPid], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
			});

			const workers: WorkerInfo[] = [];
			const matches = [...pstree.matchAll(/claude\((\d+)\)/g)];

			const seen = new Set<number>();
			for (const m of matches) {
				const pid = parseInt(m[1], 10);
				if (!seen.has(pid)) {
					seen.add(pid);
					workers.push({
						pid,
						model: workers.length === 0 ? "opus" : workers.length === 1 ? "sonnet" : "haiku",
					});
				}
			}

			return workers.slice(0, 5);
		} catch {
			return [];
		}
	}

	function getCommits(): string[] {
		try {
			const output = execFileSync("git", ["log", "--oneline", "-6"], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
			});
			return output.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}

	function getTaskStats(): { pending: number; complete: number; failed: number; total: number; inProgress: number } {
		try {
			const basePath = getMainWorktreePath();
			const tasksPath = join(basePath, ".undercity", "tasks.json");
			if (!existsSync(tasksPath)) return { pending: 0, complete: 0, failed: 0, total: 0, inProgress: 0 };
			const data = JSON.parse(readFileSync(tasksPath, "utf-8"));
			const q = data.tasks || [];
			return {
				pending: q.filter((x: { status: string }) => x.status === "pending").length,
				complete: q.filter((x: { status: string }) => x.status === "complete").length,
				failed: q.filter((x: { status: string }) => x.status === "failed").length,
				inProgress: q.filter((x: { status: string }) => x.status === "in_progress").length,
				total: q.length,
			};
		} catch {
			return { pending: 0, complete: 0, failed: 0, total: 0, inProgress: 0 };
		}
	}

	function formatTokens(n: number): string {
		if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}

	function update(): void {
		const workers = getWorkers();
		const isActive = workers.length > 0;
		const time = new Date().toISOString().slice(11, 19);
		const worktrees = getActiveWorktrees();
		const metrics = loadLiveMetrics();

		// HEADER
		if (isActive) {
			headerBox.setContent(
				`  {bold}{green-fg}UNDERCITY{/}  {white-fg}${time}{/}  ` +
					`{green-fg}● ACTIVE{/}  {white-fg}${workers.length} worker(s)  ${worktrees.length} worktree(s){/}`,
			);
		} else {
			headerBox.setContent(`  {gray-fg}UNDERCITY  ${time}  ○ IDLE{/}`);
		}

		// WORKERS
		if (!isActive) {
			workersBox.setContent(`{gray-fg}No workers{/}\n\n{gray-fg}undercity grind{/}`);
		} else {
			const lines = workers.map((w) => {
				const modelColor = w.model === "opus" ? "magenta" : w.model === "sonnet" ? "cyan" : "green";
				return `{${modelColor}-fg}${w.model.toUpperCase().padEnd(6)}{/} {white-fg}${w.pid}{/}`;
			});
			workersBox.setContent(lines.join("\n"));
		}

		// SDK METRICS
		if (metrics) {
			const sessionMs = Date.now() - metrics.sessionStartedAt;
			const sessionMin = sessionMs / 60000;
			const burnRate = sessionMin > 0 ? Math.round(metrics.tokens.total / sessionMin) : 0;

			metricsBox.setContent(
				`{white-fg}Tokens:{/}  {cyan-fg}${formatTokens(metrics.tokens.total)}{/}\n` +
					`{white-fg}Cost:{/}    {yellow-fg}$${metrics.cost.total.toFixed(3)}{/}\n` +
					`{white-fg}Queries:{/} {green-fg}${metrics.queries.successful}{/}/{white-fg}${metrics.queries.total}{/}\n` +
					`{white-fg}Burn:{/}    {cyan-fg}${formatTokens(burnRate)}/min{/}`,
			);

			// BURN GAUGE - tokens per minute, scaled to 10k/min = 100%
			const burnPct = Math.min(100, (burnRate / 10000) * 100);
			burnGauge.setPercent(Math.round(burnPct));

			// CACHE GAUGE - cache read tokens as % of total input
			const totalInput = metrics.tokens.cacheRead + metrics.tokens.input;
			const cachePct = totalInput > 0 ? (metrics.tokens.cacheRead / totalInput) * 100 : 0;
			cacheGauge.setPercent(Math.round(cachePct));

			// BY MODEL
			const opus = metrics.byModel.opus;
			const sonnet = metrics.byModel.sonnet;
			const haiku = metrics.byModel.sonnet;

			modelBox.setContent(
				`{magenta-fg}OPUS{/}   ${formatTokens(opus.input + opus.output).padStart(6)}  {yellow-fg}$${opus.cost.toFixed(3)}{/}\n` +
					`{cyan-fg}SONNET{/} ${formatTokens(sonnet.input + sonnet.output).padStart(6)}  {yellow-fg}$${sonnet.cost.toFixed(3)}{/}\n` +
					`{green-fg}HAIKU{/}  ${formatTokens(haiku.input + haiku.output).padStart(6)}  {yellow-fg}$${haiku.cost.toFixed(3)}{/}\n` +
					`{gray-fg}Cache read: ${formatTokens(metrics.tokens.cacheRead)}{/}`,
			);

			// Check for metrics file updates to log
			const metricsBasePath = getMainWorktreePath();
			const metricsPath = join(metricsBasePath, ".undercity", "live-metrics.json");
			const currentMetricsMtime = getFileMtime(metricsPath);
			if (currentMetricsMtime > lastMetricsMtime && lastMetricsMtime > 0) {
				activityLog.log(
					`{cyan-fg}[SDK]{/} ${formatTokens(metrics.tokens.total)} tokens, $${metrics.cost.total.toFixed(3)}`,
				);
			}
			lastMetricsMtime = currentMetricsMtime;
		} else {
			metricsBox.setContent(`{gray-fg}No metrics yet{/}\n\n{gray-fg}Waiting for SDK data...{/}`);
			modelBox.setContent(`{gray-fg}No model data{/}`);
			burnGauge.setPercent(0);
			cacheGauge.setPercent(0);
		}

		// OUTPUT FILE
		const logBasePath = getMainWorktreePath();
		const logPath = join(logBasePath, ".undercity", "logs", "current.log");
		const currentMtime = getFileMtime(logPath);

		if (currentMtime > lastLogMtime) {
			lastLogMtime = currentMtime;
			const logLines = tailFile(logPath, 20);
			const newLines = logLines.filter((l) => !lastLogLines.includes(l));

			for (const line of newLines) {
				_outputLineCount++;
				const truncated = line.slice(0, 55);
				if (line.includes("ERROR") || line.includes("FAIL")) {
					logBox.log(`{red-fg}${truncated}{/}`);
					activityLog.log(`{red-fg}[ERR]{/} ${truncated}`);
				} else if (line.includes("SUCCESS") || line.includes("PASS") || line.includes("✓")) {
					logBox.log(`{green-fg}${truncated}{/}`);
				} else {
					logBox.log(`{white-fg}${truncated}{/}`);
				}
			}
			lastLogLines = logLines;
		}

		// GIT COMMITS
		const commits = getCommits();
		if (commits.length > 0) {
			const sha = commits[0].split(" ")[0];
			if (lastCommitSha && sha !== lastCommitSha) {
				activityLog.log(`{green-fg}[GIT]{/} New commit: {cyan-fg}${sha}{/}`);
			}
			lastCommitSha = sha;

			const lines = commits.slice(0, 4).map((c) => {
				const s = c.slice(0, 7);
				const m = c.slice(8, 40);
				return `{cyan-fg}${s}{/} {gray-fg}${m}{/}`;
			});
			commitsBox.setContent(lines.join("\n"));
		} else {
			commitsBox.setContent(`{gray-fg}No commits{/}`);
		}

		// TASKS - show grind progress if active, otherwise task board status
		const stats = getTaskStats();
		const grindProgress = metrics?.grind;

		if (grindProgress && grindProgress.total > 0) {
			// Active grind session - show progress
			const pct = Math.round((grindProgress.completed / grindProgress.total) * 100);
			const barWidth = 20;
			const filled = Math.floor((pct / 100) * barWidth);
			const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
			const modeLabel = grindProgress.mode === "fixed" ? "Tasks" : "Board";

			taskBox.setContent(
				`{bold}{cyan-fg}${modeLabel}: ${grindProgress.completed}/${grindProgress.total}{/}\n` +
					`{green-fg}${bar}{/} ${pct}%\n` +
					`{cyan-fg}Active: ${stats.inProgress}{/}  {yellow-fg}Pending: ${stats.pending}{/}`,
			);
		} else if (stats.total === 0) {
			taskBox.setContent(`{gray-fg}No tasks{/}`);
		} else {
			// No active grind - show board summary
			const pct = Math.round((stats.complete / stats.total) * 100);
			const barWidth = 20;
			const filled = Math.floor((pct / 100) * barWidth);
			const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

			taskBox.setContent(
				`{yellow-fg}${stats.pending} pending{/}\n` +
					`{green-fg}${bar}{/} ${pct}%\n` +
					`{green-fg}Done: ${stats.complete}{/}  {red-fg}Failed: ${stats.failed}{/}`,
			);
		}

		screen.render();
	}

	// KEYBOARD
	screen.key(["q", "C-c", "escape"], () => process.exit(0));

	// BOOT
	activityLog.log("{gray-fg}Dashboard started. Press Q to exit.{/}");

	// Update every 500ms
	setInterval(update, 500);
	update();
	screen.render();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	launchDashboard();
}
