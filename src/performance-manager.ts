/**
 * Performance Management Agent
 *
 * Responsible for weekly review of metrics, identifying worst-performing task types,
 * and generating improvement hypotheses.
 */

import { raidLogger } from "./logger.js";
import { getMetricsCollector, type TaskMetrics } from "./metrics-collector.js";

interface PerformanceHypothesis {
	category: string;
	issue: string;
	potentialImprovement: string;
	metrics: {
		successRate: number;
		avgTokens: number;
		avgTime: number;
		escalationRate: number;
	};
}

export class PerformanceManager {
	private metricsCollector = getMetricsCollector();

	/**
	 * Generate weekly performance review
	 * @param fromDate Starting date for metrics analysis (defaults to 7 days ago)
	 * @param toDate Ending date for metrics analysis (defaults to current date)
	 */
	generateWeeklyReview(
		fromDate: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
		toDate: Date = new Date(),
	): PerformanceHypothesis[] {
		const metrics = this.metricsCollector.getMetricsInRange(fromDate, toDate);

		// Group metrics by task type (extracting from taskId)
		const taskTypeMetrics = this.groupMetricsByTaskType(metrics);

		// Generate hypotheses
		const hypotheses: PerformanceHypothesis[] = [];

		Object.entries(taskTypeMetrics).forEach(([taskType, groupMetrics]) => {
			const successRate = groupMetrics.filter((m) => m.success).length / groupMetrics.length;
			const avgTokens = groupMetrics.reduce((sum, m) => sum + m.tokens, 0) / groupMetrics.length;
			const avgTime = groupMetrics.reduce((sum, m) => sum + (m.timeTakenMs || 0), 0) / groupMetrics.length;
			const escalationRate = groupMetrics.filter((m) => (m.escalations || 0) > 0).length / groupMetrics.length;

			// Define hypothesis generation rules
			const hypothesis = this.generateTaskTypeHypothesis(taskType, { successRate, avgTokens, avgTime, escalationRate });

			if (hypothesis) {
				hypotheses.push(hypothesis);
			}
		});

		// Log the review
		raidLogger.info(
			{
				hypothesesGenerated: hypotheses.length,
				fromDate,
				toDate,
			},
			"Weekly Performance Review Generated",
		);

		return hypotheses;
	}

	/**
	 * Group metrics by task type (assumes task type is first part of taskId)
	 */
	private groupMetricsByTaskType(metrics: TaskMetrics[]): Record<string, TaskMetrics[]> {
		return metrics.reduce(
			(groups, metric) => {
				const taskType = metric.taskId.split("-")[0] || "unknown";
				groups[taskType] = groups[taskType] || [];
				groups[taskType].push(metric);
				return groups;
			},
			{} as Record<string, TaskMetrics[]>,
		);
	}

	/**
	 * Generate a performance hypothesis for a specific task type
	 */
	private generateTaskTypeHypothesis(
		taskType: string,
		metrics: {
			successRate: number;
			avgTokens: number;
			avgTime: number;
			escalationRate: number;
		},
	): PerformanceHypothesis | null {
		// Performance hypothesis rules
		if (metrics.successRate < 0.7 || metrics.escalationRate > 0.3) {
			return {
				category: taskType,
				issue: metrics.successRate < 0.7 ? "Low success rate" : "High intervention rate",
				potentialImprovement:
					metrics.successRate < 0.7
						? "Investigate task complexity and agent capabilities"
						: "Refine task routing and intervention protocols",
				metrics,
			};
		}

		// Token/time inefficiency check
		if (metrics.avgTokens > 2000 || metrics.avgTime > 3600000) {
			// 2000 tokens or 1 hour
			return {
				category: taskType,
				issue: metrics.avgTokens > 2000 ? "High token consumption" : "Long task duration",
				potentialImprovement:
					metrics.avgTokens > 2000
						? "Optimize model selection or task decomposition"
						: "Break down complex tasks, improve agent efficiency",
				metrics,
			};
		}

		return null; // No significant performance issues
	}
}

// Singleton instance for global access
let performanceManager: PerformanceManager | null = null;

export function getPerformanceManager(): PerformanceManager {
	if (!performanceManager) {
		performanceManager = new PerformanceManager();
	}
	return performanceManager;
}
