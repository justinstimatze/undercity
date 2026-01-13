/**
 * METRICS DASHBOARD
 *
 * Interactive TUI dashboard for viewing metrics:
 * - Token usage per model (haiku, sonnet, opus)
 * - Success/failure rates by complexity
 * - Cost tracking over time
 *
 * Integrates with live-metrics.ts for real-time data
 */

import blessed from "blessed";
import * as contrib from "blessed-contrib";
import { loadLiveMetrics, type LiveMetrics } from "./live-metrics.js";
import { loadTaskMetrics } from "./metrics.js";

// Type helpers for blessed-contrib widgets
interface LogWidget {
	log(msg: string): void;
	setContent(content: string): void;
}

interface GaugeWidget {
	setPercent(percent: number): void;
}

interface LineChartWidget {
	setData(data: LineChartData[]): void;
}

interface BarChartWidget {
	setData(data: { titles: string[]; data: number[] }): void;
}

interface LineChartData {
	title: string;
	x: string[];
	y: number[];
	style: { line: string };
}

// Model pricing per 1K tokens (approximate)
const MODEL_PRICING = {
	haiku: { input: 0.00025, output: 0.00125 },
	sonnet: { input: 0.003, output: 0.015 },
	opus: { input: 0.015, output: 0.075 },
};

function formatTokens(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function formatCost(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(4)}`;
}

/**
 * Calculate costs from live metrics
 */
function calculateCosts(metrics: LiveMetrics): {
	total: number;
	byModel: Record<"haiku" | "sonnet" | "opus", number>;
} {
	const byModel = {
		haiku: metrics.byModel.haiku.cost,
		sonnet: metrics.byModel.sonnet.cost,
		opus: metrics.byModel.opus.cost,
	};

	return {
		total: byModel.haiku + byModel.sonnet + byModel.opus,
		byModel,
	};
}

/**
 * Calculate success rates by complexity from historical metrics
 */
async function getComplexityStats(): Promise<Record<string, { total: number; successful: number; rate: number }>> {
	const metrics = await loadTaskMetrics();

	const stats: Record<string, { total: number; successful: number; rate: number }> = {
		trivial: { total: 0, successful: 0, rate: 0 },
		simple: { total: 0, successful: 0, rate: 0 },
		standard: { total: 0, successful: 0, rate: 0 },
		complex: { total: 0, successful: 0, rate: 0 },
		critical: { total: 0, successful: 0, rate: 0 },
	};

	for (const m of metrics) {
		const level = m.complexityLevel ?? "standard";
		if (stats[level]) {
			stats[level].total++;
			if (m.success) {
				stats[level].successful++;
			}
		}
	}

	// Calculate rates
	for (const level of Object.keys(stats)) {
		if (stats[level].total > 0) {
			stats[level].rate = (stats[level].successful / stats[level].total) * 100;
		}
	}

	return stats;
}

/**
 * Get daily cost data for the chart
 */
async function getDailyCostData(days = 14): Promise<{ dates: string[]; costs: number[] }> {
	const metrics = await loadTaskMetrics();

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - days);

	// Group by date
	const dailyMap: Record<string, number> = {};

	for (const m of metrics) {
		if (!m.startedAt) continue;

		const startDate = new Date(m.startedAt);
		if (startDate < cutoffDate) continue;

		const dateKey = startDate.toISOString().split("T")[0];
		const tokens = m.totalTokens || 0;
		const model = m.finalModel || "sonnet";

		// Estimate cost from tokens
		const pricing = MODEL_PRICING[model] || MODEL_PRICING.sonnet;
		// Assume 50/50 input/output split for estimation
		const cost = (tokens / 2000) * (pricing.input + pricing.output);

		dailyMap[dateKey] = (dailyMap[dateKey] || 0) + cost;
	}

	// Sort dates and fill gaps
	const allDates: string[] = [];
	const allCosts: number[] = [];

	for (let i = days - 1; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const dateKey = d.toISOString().split("T")[0];
		const shortDate = dateKey.slice(5); // MM-DD format

		allDates.push(shortDate);
		allCosts.push(dailyMap[dateKey] || 0);
	}

	return { dates: allDates, costs: allCosts };
}

/**
 * Get model usage distribution
 */
async function getModelDistribution(): Promise<Record<"haiku" | "sonnet" | "opus", number>> {
	const metrics = await loadTaskMetrics();

	const counts = { haiku: 0, sonnet: 0, opus: 0 };

	for (const m of metrics) {
		if (m.finalModel && counts[m.finalModel] !== undefined) {
			counts[m.finalModel]++;
		}
	}

	return counts;
}

export function launchMetricsDashboard(): void {
	const screen = blessed.screen({
		smartCSR: true,
		title: "UNDERCITY METRICS",
		fullUnicode: true,
	});

	const grid = new contrib.grid({ rows: 12, cols: 12, screen });

	// HEADER
	const headerBox = grid.set(0, 0, 1, 12, blessed.box, {
		tags: true,
		style: { fg: "cyan", bg: "black" },
	}) as LogWidget;

	// TOP LEFT - Token Usage by Model
	const tokenBox = grid.set(1, 0, 4, 4, blessed.box, {
		label: " TOKEN USAGE BY MODEL ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "cyan",
			bg: "black",
			border: { fg: "cyan" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// TOP CENTER - Cost Summary
	const costBox = grid.set(1, 4, 4, 4, blessed.box, {
		label: " COST SUMMARY ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "yellow",
			bg: "black",
			border: { fg: "yellow" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// TOP RIGHT - Session Stats
	const sessionBox = grid.set(1, 8, 4, 4, blessed.box, {
		label: " SESSION STATS ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "green",
			bg: "black",
			border: { fg: "green" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// MIDDLE - Cost Over Time Chart
	const costChart = grid.set(5, 0, 4, 8, contrib.line, {
		label: " DAILY COST (LAST 14 DAYS) ",
		style: {
			line: "yellow",
			text: "white",
			baseline: "white",
		},
		showLegend: true,
		wholeNumbersOnly: false,
		border: { type: "line" },
	}) as LineChartWidget;

	// MIDDLE RIGHT - Model Distribution Bar
	const modelBar = grid.set(5, 8, 4, 4, contrib.bar, {
		label: " MODEL DISTRIBUTION ",
		barWidth: 6,
		barSpacing: 2,
		xOffset: 2,
		maxHeight: 100,
		border: { type: "line" },
	}) as BarChartWidget;

	// BOTTOM - Success Rate by Complexity
	const complexityBox = grid.set(9, 0, 3, 8, blessed.box, {
		label: " SUCCESS RATE BY COMPLEXITY ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "magenta",
			bg: "black",
			border: { fg: "magenta" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// BOTTOM RIGHT - Overall Gauges
	const successGauge = grid.set(9, 8, 3, 4, contrib.gauge, {
		label: " SUCCESS RATE ",
		stroke: "green",
		fill: "black",
		border: { type: "line" },
		style: { border: { fg: "green" } },
	}) as GaugeWidget;

	// Track update state
	let lastUpdateTime = 0;
	let complexityStats: Record<string, { total: number; successful: number; rate: number }> | null = null;
	let dailyCostData: { dates: string[]; costs: number[] } | null = null;
	let modelDistribution: Record<"haiku" | "sonnet" | "opus", number> | null = null;

	async function loadHistoricalData(): Promise<void> {
		try {
			[complexityStats, dailyCostData, modelDistribution] = await Promise.all([
				getComplexityStats(),
				getDailyCostData(14),
				getModelDistribution(),
			]);
		} catch {
			// Ignore errors, data will be null
		}
	}

	async function update(): Promise<void> {
		const time = new Date().toISOString().slice(11, 19);
		const liveMetrics = loadLiveMetrics();

		// HEADER
		headerBox.setContent(
			`  {bold}{cyan-fg}UNDERCITY METRICS DASHBOARD{/}  {white-fg}${time}{/}  ` +
				`{dim}Press Q to exit | Refresh: 1s{/}`,
		);

		// TOKEN USAGE BY MODEL
		if (liveMetrics) {
			const opus = liveMetrics.byModel.opus;
			const sonnet = liveMetrics.byModel.sonnet;
			const haiku = liveMetrics.byModel.haiku;

			const totalTokens = liveMetrics.tokens.total;
			const opusPct = totalTokens > 0 ? ((opus.input + opus.output) / totalTokens) * 100 : 0;
			const sonnetPct = totalTokens > 0 ? ((sonnet.input + sonnet.output) / totalTokens) * 100 : 0;
			const haikuPct = totalTokens > 0 ? ((haiku.input + haiku.output) / totalTokens) * 100 : 0;

			tokenBox.setContent(
				`{bold}Total: {cyan-fg}${formatTokens(totalTokens)}{/}{/}\n\n` +
					`{magenta-fg}OPUS{/}   ${formatTokens(opus.input + opus.output).padStart(8)} {dim}(${opusPct.toFixed(1)}%){/}\n` +
					`  {dim}In:{/}  ${formatTokens(opus.input).padStart(8)}\n` +
					`  {dim}Out:{/} ${formatTokens(opus.output).padStart(8)}\n\n` +
					`{cyan-fg}SONNET{/} ${formatTokens(sonnet.input + sonnet.output).padStart(8)} {dim}(${sonnetPct.toFixed(1)}%){/}\n` +
					`  {dim}In:{/}  ${formatTokens(sonnet.input).padStart(8)}\n` +
					`  {dim}Out:{/} ${formatTokens(sonnet.output).padStart(8)}\n\n` +
					`{green-fg}HAIKU{/}  ${formatTokens(haiku.input + haiku.output).padStart(8)} {dim}(${haikuPct.toFixed(1)}%){/}\n` +
					`  {dim}In:{/}  ${formatTokens(haiku.input).padStart(8)}\n` +
					`  {dim}Out:{/} ${formatTokens(haiku.output).padStart(8)}`,
			);
		} else {
			tokenBox.setContent(`{gray-fg}No live metrics available{/}\n\n{dim}Run 'undercity grind' to generate metrics{/}`);
		}

		// COST SUMMARY
		if (liveMetrics) {
			const costs = calculateCosts(liveMetrics);
			const sessionMs = Date.now() - liveMetrics.sessionStartedAt;
			const sessionHours = sessionMs / 3600000;
			const burnRateHr = sessionHours > 0 ? costs.total / sessionHours : 0;

			costBox.setContent(
				`{bold}Total Cost:{/} {yellow-fg}${formatCost(costs.total)}{/}\n\n` +
					`{magenta-fg}OPUS{/}   ${formatCost(costs.byModel.opus).padStart(8)}\n` +
					`{cyan-fg}SONNET{/} ${formatCost(costs.byModel.sonnet).padStart(8)}\n` +
					`{green-fg}HAIKU{/}  ${formatCost(costs.byModel.haiku).padStart(8)}\n\n` +
					`{dim}Burn Rate:{/}\n` +
					`  {yellow-fg}${formatCost(burnRateHr)}/hr{/}`,
			);
		} else {
			costBox.setContent(`{gray-fg}No cost data{/}`);
		}

		// SESSION STATS
		if (liveMetrics) {
			const sessionMs = Date.now() - liveMetrics.sessionStartedAt;
			const sessionMin = Math.floor(sessionMs / 60000);
			const sessionHr = Math.floor(sessionMin / 60);
			const minRemaining = sessionMin % 60;
			const sessionStr = sessionHr > 0 ? `${sessionHr}h ${minRemaining}m` : `${sessionMin}m`;

			const successRate =
				liveMetrics.queries.total > 0 ? (liveMetrics.queries.successful / liveMetrics.queries.total) * 100 : 0;

			const cacheRate =
				liveMetrics.tokens.input + liveMetrics.tokens.cacheRead > 0
					? (liveMetrics.tokens.cacheRead / (liveMetrics.tokens.input + liveMetrics.tokens.cacheRead)) * 100
					: 0;

			sessionBox.setContent(
				`{bold}Session Duration:{/}\n  {green-fg}${sessionStr}{/}\n\n` +
					`{bold}Queries:{/}\n` +
					`  Total:    ${liveMetrics.queries.total}\n` +
					`  Success:  {green-fg}${liveMetrics.queries.successful}{/}\n` +
					`  Failed:   {red-fg}${liveMetrics.queries.failed}{/}\n` +
					`  Limited:  {yellow-fg}${liveMetrics.queries.rateLimited}{/}\n\n` +
					`{bold}Success Rate:{/} {green-fg}${successRate.toFixed(1)}%{/}\n` +
					`{bold}Cache Hit:{/}    {cyan-fg}${cacheRate.toFixed(1)}%{/}`,
			);

			// Update success gauge
			successGauge.setPercent(Math.round(successRate));
		} else {
			sessionBox.setContent(`{gray-fg}No session data{/}`);
			successGauge.setPercent(0);
		}

		// Reload historical data every 30 seconds
		const now = Date.now();
		if (now - lastUpdateTime > 30000) {
			lastUpdateTime = now;
			await loadHistoricalData();
		}

		// COST OVER TIME CHART
		if (dailyCostData && dailyCostData.dates.length > 0) {
			costChart.setData([
				{
					title: "Cost ($)",
					x: dailyCostData.dates,
					y: dailyCostData.costs.map((c) => Math.round(c * 100) / 100),
					style: { line: "yellow" },
				},
			]);
		}

		// MODEL DISTRIBUTION BAR
		if (modelDistribution) {
			const total = modelDistribution.haiku + modelDistribution.sonnet + modelDistribution.opus;
			if (total > 0) {
				modelBar.setData({
					titles: ["Haiku", "Sonnet", "Opus"],
					data: [
						Math.round((modelDistribution.haiku / total) * 100),
						Math.round((modelDistribution.sonnet / total) * 100),
						Math.round((modelDistribution.opus / total) * 100),
					],
				});
			}
		}

		// SUCCESS RATE BY COMPLEXITY
		if (complexityStats) {
			const levels = ["trivial", "simple", "standard", "complex", "critical"];
			let content = "";

			for (const level of levels) {
				const stats = complexityStats[level];
				if (!stats) continue;

				const rateColor = stats.rate >= 80 ? "green" : stats.rate >= 60 ? "yellow" : stats.rate > 0 ? "red" : "gray";
				const bar = stats.total > 0 ? createProgressBar(stats.rate, 20) : "{gray-fg}No data{/}";

				content +=
					`{cyan-fg}${level.toUpperCase().padEnd(10)}{/} ` +
					`${bar} ` +
					`{${rateColor}-fg}${stats.rate.toFixed(0)}%{/} ` +
					`{dim}(${stats.successful}/${stats.total}){/}\n`;
			}

			complexityBox.setContent(content || "{gray-fg}No complexity data available{/}");
		} else {
			complexityBox.setContent("{gray-fg}Loading historical metrics...{/}");
		}

		screen.render();
	}

	function createProgressBar(percent: number, width: number): string {
		const filled = Math.round((percent / 100) * width);
		const empty = width - filled;
		return `{green-fg}${"█".repeat(filled)}{/}{gray-fg}${"░".repeat(empty)}{/}`;
	}

	// KEYBOARD
	screen.key(["q", "C-c", "escape"], () => process.exit(0));

	// Initial load and update
	loadHistoricalData().then(() => {
		update();
	});

	// Update every second
	setInterval(update, 1000);

	screen.render();
}

// Direct execution support
if (import.meta.url === `file://${process.argv[1]}`) {
	launchMetricsDashboard();
}
