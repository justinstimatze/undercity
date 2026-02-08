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
import { type LiveMetrics, loadLiveMetrics } from "./live-metrics.js";
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
	sonnet: { input: 0.003, output: 0.015 },
	opus: { input: 0.015, output: 0.075 },
	haiku: { input: 0.015, output: 0.075 },
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
		sonnet: metrics.byModel.sonnet.cost,
		opus: metrics.byModel.opus.cost,
		haiku: metrics.byModel.opus.cost,
	};

	return {
		total: byModel.sonnet + byModel.sonnet + byModel.opus,
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

/**
 * Calculate duration estimates by complexity level and model
 * Returns average duration in milliseconds for each combination
 */
async function getDurationEstimates(): Promise<{
	byComplexity: Record<string, { avgDurationMs: number; count: number; p50: number; p90: number }>;
	byModel: Record<string, { avgDurationMs: number; count: number; p50: number; p90: number }>;
	overall: { avgDurationMs: number; count: number; p50: number; p90: number };
}> {
	const metrics = await loadTaskMetrics();

	// Filter to successful tasks with valid duration
	const validMetrics = metrics.filter((m) => m.success && m.durationMs > 0);

	if (validMetrics.length === 0) {
		return {
			byComplexity: {},
			byModel: {},
			overall: { avgDurationMs: 0, count: 0, p50: 0, p90: 0 },
		};
	}

	// Helper to calculate percentiles
	const calculatePercentiles = (durations: number[]): { p50: number; p90: number } => {
		if (durations.length === 0) return { p50: 0, p90: 0 };
		const sorted = [...durations].sort((a, b) => a - b);
		const p50Index = Math.floor(sorted.length * 0.5);
		const p90Index = Math.floor(sorted.length * 0.9);
		return {
			p50: sorted[p50Index] || 0,
			p90: sorted[p90Index] || sorted[sorted.length - 1] || 0,
		};
	};

	// Group by complexity level
	const byComplexity: Record<string, number[]> = {};
	for (const m of validMetrics) {
		const level = m.complexityLevel || "standard";
		if (!byComplexity[level]) byComplexity[level] = [];
		byComplexity[level].push(m.durationMs);
	}

	// Group by model
	const byModel: Record<string, number[]> = {};
	for (const m of validMetrics) {
		const model = m.finalModel || "sonnet";
		if (!byModel[model]) byModel[model] = [];
		byModel[model].push(m.durationMs);
	}

	// Calculate stats for each group
	const complexityStats: Record<string, { avgDurationMs: number; count: number; p50: number; p90: number }> = {};
	for (const [level, durations] of Object.entries(byComplexity)) {
		const percentiles = calculatePercentiles(durations);
		complexityStats[level] = {
			avgDurationMs: durations.reduce((sum, d) => sum + d, 0) / durations.length,
			count: durations.length,
			p50: percentiles.p50,
			p90: percentiles.p90,
		};
	}

	const modelStats: Record<string, { avgDurationMs: number; count: number; p50: number; p90: number }> = {};
	for (const [model, durations] of Object.entries(byModel)) {
		const percentiles = calculatePercentiles(durations);
		modelStats[model] = {
			avgDurationMs: durations.reduce((sum, d) => sum + d, 0) / durations.length,
			count: durations.length,
			p50: percentiles.p50,
			p90: percentiles.p90,
		};
	}

	// Overall stats
	const allDurations = validMetrics.map((m) => m.durationMs);
	const overallPercentiles = calculatePercentiles(allDurations);
	const overall = {
		avgDurationMs: allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length,
		count: allDurations.length,
		p50: overallPercentiles.p50,
		p90: overallPercentiles.p90,
	};

	return { byComplexity: complexityStats, byModel: modelStats, overall };
}

/**
 * Calculate prediction accuracy metrics by comparing predicted vs actual durations
 * Uses historical data where predictions were recorded
 */
async function getPredictionAccuracy(): Promise<{
	mae: number; // Mean Absolute Error in ms
	rmse: number; // Root Mean Squared Error in ms
	withinThreshold: number; // % of predictions within 20% of actual
	sampleSize: number;
} | null> {
	const metrics = await loadTaskMetrics();

	// For now, we don't have stored predictions in the schema
	// This would require storing predicted duration when task starts
	// Return null to indicate no prediction data available yet
	// Future enhancement: add predictedDurationMs field to TaskMetrics

	// As a placeholder, calculate prediction accuracy using avg duration by complexity
	const validMetrics = metrics.filter((m) => m.success && m.durationMs > 0 && m.complexityLevel);

	if (validMetrics.length < 5) {
		return null; // Not enough data
	}

	// Build a simple prediction model: avg duration by complexity
	const complexityAvg: Record<string, number> = {};
	const complexityCounts: Record<string, number> = {};

	for (const m of validMetrics) {
		const level = m.complexityLevel as string;
		complexityAvg[level] = (complexityAvg[level] || 0) + m.durationMs;
		complexityCounts[level] = (complexityCounts[level] || 0) + 1;
	}

	for (const level of Object.keys(complexityAvg)) {
		complexityAvg[level] /= complexityCounts[level];
	}

	// Calculate errors using leave-one-out cross-validation approach
	let sumAbsError = 0;
	let sumSqError = 0;
	let withinThresholdCount = 0;

	for (const m of validMetrics) {
		const level = m.complexityLevel as string;
		const predicted = complexityAvg[level] || 0;
		const actual = m.durationMs;

		const absError = Math.abs(predicted - actual);
		const sqError = (predicted - actual) ** 2;
		const percentError = actual > 0 ? absError / actual : 0;

		sumAbsError += absError;
		sumSqError += sqError;

		if (percentError <= 0.2) {
			// Within 20%
			withinThresholdCount++;
		}
	}

	const mae = sumAbsError / validMetrics.length;
	const rmse = Math.sqrt(sumSqError / validMetrics.length);
	const withinThreshold = (withinThresholdCount / validMetrics.length) * 100;

	return {
		mae,
		rmse,
		withinThreshold,
		sampleSize: validMetrics.length,
	};
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
	const successGauge = grid.set(9, 8, 1.5, 4, contrib.gauge, {
		label: " SUCCESS RATE ",
		stroke: "green",
		fill: "black",
		border: { type: "line" },
		style: { border: { fg: "green" } },
	}) as GaugeWidget;

	// NEW - Duration Estimates by Complexity
	const durationEstimatesBox = grid.set(10.5, 8, 1.5, 4, blessed.box, {
		label: " DURATION ESTIMATES ",
		tags: true,
		border: { type: "line" },
		style: {
			fg: "blue",
			bg: "black",
			border: { fg: "blue" },
			label: { fg: "white", bold: true },
		},
	}) as LogWidget;

	// Track update state
	let lastUpdateTime = 0;
	let complexityStats: Record<string, { total: number; successful: number; rate: number }> | null = null;
	let dailyCostData: { dates: string[]; costs: number[] } | null = null;
	let modelDistribution: Record<"haiku" | "sonnet" | "opus", number> | null = null;
	let durationEstimates: Awaited<ReturnType<typeof getDurationEstimates>> | null = null;
	let predictionAccuracy: Awaited<ReturnType<typeof getPredictionAccuracy>> | null = null;

	async function loadHistoricalData(): Promise<void> {
		try {
			[complexityStats, dailyCostData, modelDistribution, durationEstimates, predictionAccuracy] = await Promise.all([
				getComplexityStats(),
				getDailyCostData(14),
				getModelDistribution(),
				getDurationEstimates(),
				getPredictionAccuracy(),
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
			const haiku = liveMetrics.byModel.sonnet;

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
					`{green-fg}HAIKU{/}  ${formatCost(costs.byModel.sonnet).padStart(8)}\n\n` +
					`{dim}Burn Rate:{/}\n` +
					`  {yellow-fg}${formatCost(burnRateHr)}/hr{/}`,
			);
		} else {
			costBox.setContent(`{gray-fg}No cost data{/}`);
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
			const total = modelDistribution.sonnet + modelDistribution.sonnet + modelDistribution.opus;
			if (total > 0) {
				modelBar.setData({
					titles: ["Haiku", "Sonnet", "Opus"],
					data: [
						Math.round((modelDistribution.sonnet / total) * 100),
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

		// DURATION ESTIMATES
		if (durationEstimates?.byComplexity) {
			const levels = ["trivial", "simple", "standard", "complex", "critical"];
			let content = "";

			// Show overall estimate first
			if (durationEstimates.overall.count > 0) {
				const avgMin = (durationEstimates.overall.avgDurationMs / 60000).toFixed(1);
				const p50Min = (durationEstimates.overall.p50 / 60000).toFixed(1);
				const p90Min = (durationEstimates.overall.p90 / 60000).toFixed(1);
				content += `{bold}Overall:{/} {cyan-fg}${avgMin}m{/} {dim}(P50: ${p50Min}m, P90: ${p90Min}m){/}\n\n`;
			}

			// Show by complexity level
			for (const level of levels) {
				const stats = durationEstimates.byComplexity[level];
				if (!stats || stats.count === 0) continue;

				const avgMin = (stats.avgDurationMs / 60000).toFixed(1);
				const p90Min = (stats.p90 / 60000).toFixed(1);

				// Color code by duration: green (<5m), yellow (5-15m), red (>15m)
				const color = stats.avgDurationMs < 300000 ? "green" : stats.avgDurationMs < 900000 ? "yellow" : "red";

				content += `{dim}${level.padEnd(8)}{/} {${color}-fg}${avgMin}m{/} {dim}(P90: ${p90Min}m){/}\n`;
			}

			durationEstimatesBox.setContent(content || "{gray-fg}No duration data{/}");
		} else {
			durationEstimatesBox.setContent("{gray-fg}Insufficient data for estimates{/}\n\n{dim}Need 5+ completed tasks{/}");
		}

		// Update session box to include prediction accuracy if available
		if (liveMetrics && predictionAccuracy) {
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

			const maeMin = (predictionAccuracy.mae / 60000).toFixed(1);
			const accuracyColor =
				predictionAccuracy.withinThreshold >= 70
					? "green"
					: predictionAccuracy.withinThreshold >= 50
						? "yellow"
						: "red";

			sessionBox.setContent(
				`{bold}Session Duration:{/}\n  {green-fg}${sessionStr}{/}\n\n` +
					`{bold}Queries:{/}\n` +
					`  Total:    ${liveMetrics.queries.total}\n` +
					`  Success:  {green-fg}${liveMetrics.queries.successful}{/}\n` +
					`  Failed:   {red-fg}${liveMetrics.queries.failed}{/}\n` +
					`  Limited:  {yellow-fg}${liveMetrics.queries.rateLimited}{/}\n\n` +
					`{bold}Success Rate:{/} {green-fg}${successRate.toFixed(1)}%{/}\n` +
					`{bold}Cache Hit:{/}    {cyan-fg}${cacheRate.toFixed(1)}%{/}\n\n` +
					`{bold}Prediction Accuracy:{/}\n` +
					`  MAE: {dim}${maeMin}m{/}\n` +
					`  Within 20%: {${accuracyColor}-fg}${predictionAccuracy.withinThreshold.toFixed(0)}%{/}`,
			);

			// Update success gauge
			successGauge.setPercent(Math.round(successRate));
		} else if (liveMetrics) {
			// Original session box content when no prediction accuracy
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
