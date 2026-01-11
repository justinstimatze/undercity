/**
 * Metrics Collector
 *
 * Tracks task-level metrics in a JSONL file for detailed analysis
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sessionLogger } from "./logger.js";

export interface TaskMetrics {
	/** Unique identifier for the task */
	taskId: string;
	/** Timestamp when task started */
	startTime: Date;
	/** Timestamp when task completed */
	endTime?: Date;
	/** Whether the task was successful */
	success: boolean;
	/** Total tokens used */
	tokens: number;
	/** Model used for task execution */
	model: "haiku" | "sonnet" | "opus";
	/** Number of escalations/user interventions */
	escalations: number;
	/** Specific reasons for escalations */
	escalationReasons?: string[];
	/** Total time taken for task completion (in milliseconds) */
	timeTakenMs?: number;
}

export class MetricsCollector {
	private baseDir: string;
	private metricsFilePath: string;

	constructor(baseDir: string = process.cwd()) {
		this.baseDir = path.join(baseDir, ".undercity");
		this.metricsFilePath = path.join(this.baseDir, "metrics.jsonl");
		this.ensureMetricsDir();
	}

	private ensureMetricsDir(): void {
		try {
			fs.mkdirSync(this.baseDir, { recursive: true });
		} catch (error) {
			sessionLogger.warn({ error: String(error) }, "Failed to create metrics directory");
		}
	}

	/**
	 * Record a completed task's metrics
	 */
	recordTaskMetrics(metrics: TaskMetrics): void {
		try {
			const jsonlEntry = `${JSON.stringify(metrics)}\n`;
			fs.appendFileSync(this.metricsFilePath, jsonlEntry);
		} catch (error) {
			sessionLogger.error({ error: String(error), metrics }, "Failed to record task metrics");
		}
	}

	/**
	 * Read metrics within a specific time range
	 */
	getMetricsInRange(fromDate: Date, toDate: Date): TaskMetrics[] {
		try {
			const content = fs.readFileSync(this.metricsFilePath, "utf-8");
			return content
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as TaskMetrics)
				.filter((metrics) => !metrics.startTime || (metrics.startTime >= fromDate && metrics.startTime <= toDate));
		} catch (error) {
			sessionLogger.warn({ error: String(error) }, "Failed to read metrics");
			return [];
		}
	}

	/**
	 * Get metrics for a specific task by its ID
	 */
	getMetricsByTaskId(taskId: string): TaskMetrics[] {
		try {
			const content = fs.readFileSync(this.metricsFilePath, "utf-8");
			return content
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as TaskMetrics)
				.filter((metrics) => metrics.taskId === taskId);
		} catch (error) {
			sessionLogger.warn({ error: String(error), taskId }, "Failed to read metrics for task");
			return [];
		}
	}

	/**
	 * Analyze overall metrics
	 */
	getMetricsSummary(
		fromDate?: Date,
		toDate?: Date,
	): {
		totalTasks: number;
		successRate: number;
		avgTokens: number;
		avgTimeTakenMs: number;
		modelDistribution: Record<string, number>;
		escalationRate: number;
	} {
		const metrics = fromDate && toDate ? this.getMetricsInRange(fromDate, toDate) : this.getAllMetrics();

		const summary = {
			totalTasks: metrics.length,
			successRate: metrics.filter((m) => m.success).length / metrics.length,
			avgTokens: metrics.reduce((sum, m) => sum + m.tokens, 0) / metrics.length,
			avgTimeTakenMs: metrics.reduce((sum, m) => sum + (m.timeTakenMs || 0), 0) / metrics.length,
			modelDistribution: metrics.reduce(
				(dist, m) => {
					dist[m.model] = (dist[m.model] || 0) + 1;
					return dist;
				},
				{} as Record<string, number>,
			),
			escalationRate: metrics.filter((m) => (m.escalations || 0) > 0).length / metrics.length,
		};

		return summary;
	}

	/**
	 * Get all metrics
	 */
	private getAllMetrics(): TaskMetrics[] {
		try {
			const content = fs.readFileSync(this.metricsFilePath, "utf-8");
			return content
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as TaskMetrics);
		} catch (error) {
			sessionLogger.warn({ error: String(error) }, "Failed to read metrics");
			return [];
		}
	}
}

// Singleton instance for global access
let metricsCollector: MetricsCollector | null = null;

export function getMetricsCollector(baseDir?: string): MetricsCollector {
	if (!metricsCollector) {
		metricsCollector = new MetricsCollector(baseDir);
	}
	return metricsCollector;
}
