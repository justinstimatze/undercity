/**
 * Metrics Reader for parsing metrics.jsonl and computing success rates
 */
import { EnhancedMetricsQuery } from "./enhanced-metrics.js";
import type { TaskMetrics } from "./types.js";
import type { ComplexityLevel } from "./complexity.js";

export interface MetricsSummary {
  totalTasks: number;
  successRate: number;
  avgTokens: number;
  modelDistribution: Record<string, number>;
  avgTimeTakenMs: number;
  escalationRate: number;
}

export async function readMetrics(options?: {
  days?: number;
  complexityFilter?: ComplexityLevel[];
}): Promise<MetricsSummary> {
  const { days = 30, complexityFilter } = options || {};

  // Load all metrics
  const { taskMetrics } = await EnhancedMetricsQuery.loadAllMetrics();

  // Filter by date and complexity if specified
  const filteredMetrics = taskMetrics.filter((metric) => {
    const withinDateRange = metric.startedAt &&
      new Date(metric.startedAt) >= new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const matchesComplexity = !complexityFilter || (
      metric.complexityLevel &&
      complexityFilter.includes(metric.complexityLevel)
    );
    return withinDateRange && matchesComplexity;
  });

  // Compute key metrics
  const totalTasks = filteredMetrics.length;
  const successfulTasks = filteredMetrics.filter((m) => m.success).length;
  const successRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

  // Average tokens
  const totalTokens = filteredMetrics.reduce((sum, m) => sum + m.totalTokens, 0);
  const avgTokens = totalTasks > 0 ? totalTokens / totalTasks : 0;

  // Model distribution
  const modelDistribution = filteredMetrics.reduce((dist, m) => {
    const model = m.finalModel || "unknown";
    dist[model] = (dist[model] || 0) + 1;
    return dist;
  }, {} as Record<string, number>);

  // Timing
  const totalTime = filteredMetrics.reduce((sum, m) => sum + m.durationMs, 0);
  const avgTimeTakenMs = totalTasks > 0 ? totalTime / totalTasks : 0;

  // Escalation rate
  const escalatedTasks = filteredMetrics.filter((m) => m.wasEscalated).length;
  const escalationRate = totalTasks > 0 ? escalatedTasks / totalTasks : 0;

  return {
    totalTasks,
    successRate,
    avgTokens,
    modelDistribution,
    avgTimeTakenMs,
    escalationRate,
  };
}

export async function computeDetailedSuccessRates() {
  const { taskMetrics } = await EnhancedMetricsQuery.loadAllMetrics();

  const complexityLevels: ComplexityLevel[] = ["trivial", "simple", "standard", "complex", "critical"];

  const successRateByComplexity = complexityLevels.reduce((acc, complexity) => {
    acc[complexity] = {
      rate: 0,
      totalTasks: 0,
      escalatedCount: 0,
      escalationSuccessRate: 0,
      avgTokensPerTask: 0,
    };
    return acc;
  }, {} as Record<ComplexityLevel, {
    rate: number;
    totalTasks: number;
    escalatedCount: number;
    escalationSuccessRate: number;
    avgTokensPerTask: number;
  }>);

  // Compute success rates by complexity
  for (const metric of taskMetrics) {
    const complexity = metric.complexityLevel || "trivial";

    if (!complexityLevels.includes(complexity)) {
      continue;
    }

    const complexityGroup = successRateByComplexity[complexity as ComplexityLevel];
    complexityGroup.totalTasks++;
    complexityGroup.avgTokensPerTask += metric.totalTokens;

    // Check task success
    if (metric.success) {
      complexityGroup.rate += 1;
    }

    // Compute escalation details
    if (metric.wasEscalated) {
      complexityGroup.escalatedCount++;
    }
  }

  // Finalize calculations
  for (const complexity of Object.keys(successRateByComplexity) as ComplexityLevel[]) {
    const group = successRateByComplexity[complexity];

    // Compute success rate
    group.rate = group.totalTasks > 0 ? (group.rate / group.totalTasks) * 100 : 0;

    // Compute average tokens
    group.avgTokensPerTask = group.totalTasks > 0
      ? group.avgTokensPerTask / group.totalTasks
      : 0;
  }

  return successRateByComplexity;
}