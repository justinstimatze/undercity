/**
 * Health Monitor Module
 *
 * Centralized health monitoring and self-introspection for undercity.
 * Tracks rolling metrics, detects anomalies, and generates alerts
 * when the system is not operating effectively.
 *
 * Key responsibilities:
 * - Track rolling success rate
 * - Monitor "no_changes" frequency
 * - Detect learning system correlation issues
 * - Track progress toward stated goals
 * - Generate health reports and alerts
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeEffectiveness, type EffectivenessReport } from "./effectiveness-analysis.js";
import { sessionLogger } from "./logger.js";

const DEFAULT_STATE_DIR = ".undercity";
const HEALTH_STATE_FILE = "health-state.json";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for health monitoring thresholds
 */
export interface HealthThresholds {
	/** Minimum acceptable rolling success rate (0-1). Default: 0.9 */
	minSuccessRate: number;
	/** Maximum acceptable "no_changes" rate (0-1). Default: 0.2 */
	maxNoChangesRate: number;
	/** Minimum knowledge injection delta before warning. Default: -0.05 */
	minKnowledgeDelta: number;
	/** Minimum self-tuning delta before warning. Default: -0.1 */
	minSelfTuningDelta: number;
	/** Minimum file prediction precision before warning. Default: 0.4 */
	minFilePredictionPrecision: number;
	/** Hours without progress before goal stall alert. Default: 2 */
	goalStallHours: number;
	/** Number of tasks to consider for rolling metrics. Default: 10 */
	rollingWindowSize: number;
}

/**
 * Default health thresholds
 */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
	minSuccessRate: 0.9,
	maxNoChangesRate: 0.2,
	minKnowledgeDelta: -0.05,
	minSelfTuningDelta: -0.1,
	minFilePredictionPrecision: 0.4,
	goalStallHours: 2,
	rollingWindowSize: 10,
};

/**
 * A single task outcome for rolling metrics
 */
export interface TaskOutcome {
	taskId: string;
	success: boolean;
	noChanges: boolean;
	usedKnowledge: boolean;
	usedFilePrediction: boolean;
	completedAt: string;
	durationMs?: number;
}

/**
 * Rolling health metrics computed from recent tasks
 */
export interface RollingMetrics {
	/** Number of tasks in the window */
	windowSize: number;
	/** Success rate in the window */
	successRate: number;
	/** Rate of "no_changes" outcomes */
	noChangesRate: number;
	/** Number of tasks using knowledge injection */
	tasksWithKnowledge: number;
	/** Number of tasks using file prediction */
	tasksWithFilePrediction: number;
	/** Time of last successful task */
	lastSuccessAt?: string;
	/** Time of last task */
	lastTaskAt?: string;
}

/**
 * Health concern severity levels
 */
export type HealthConcernSeverity = "info" | "warning" | "critical";

/**
 * A detected health concern
 */
export interface HealthConcern {
	/** Severity of the concern */
	severity: HealthConcernSeverity;
	/** Category of the concern */
	category: "success_rate" | "no_changes" | "knowledge" | "file_prediction" | "self_tuning" | "goal_progress";
	/** Human-readable message */
	message: string;
	/** Current value that triggered the concern */
	currentValue: number;
	/** Threshold that was violated */
	threshold: number;
	/** Recommended action */
	recommendation: string;
}

/**
 * Overall health status
 */
export type HealthStatus = "healthy" | "degraded" | "critical";

/**
 * Complete health report
 */
export interface HealthReport {
	/** Overall status */
	status: HealthStatus;
	/** When the report was generated */
	generatedAt: string;
	/** Rolling metrics from recent tasks */
	rollingMetrics: RollingMetrics;
	/** Effectiveness analysis from historical data */
	effectiveness: EffectivenessReport;
	/** List of concerns found */
	concerns: HealthConcern[];
	/** Actions taken automatically */
	actionsTaken: string[];
	/** Goal progress if a goal is set */
	goalProgress?: {
		goal: string;
		percentComplete: number;
		tasksCompleted: number;
		hoursElapsed: number;
		stalled: boolean;
	};
}

/**
 * Persisted health state
 */
export interface HealthState {
	version: string;
	recentOutcomes: TaskOutcome[];
	currentGoal?: string;
	goalStartedAt?: string;
	goalTasksCompleted?: number;
	disabledSystems: string[];
	lastReportAt: string;
}

// =============================================================================
// State Management
// =============================================================================

/**
 * Load health state from disk
 */
export function loadHealthState(stateDir: string = DEFAULT_STATE_DIR): HealthState {
	const path = join(stateDir, HEALTH_STATE_FILE);

	try {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content) as HealthState;
		}
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to load health state, using defaults");
	}

	return {
		version: "1.0",
		recentOutcomes: [],
		disabledSystems: [],
		lastReportAt: new Date().toISOString(),
	};
}

/**
 * Save health state to disk (atomic write)
 */
export function saveHealthState(state: HealthState, stateDir: string = DEFAULT_STATE_DIR): void {
	const path = join(stateDir, HEALTH_STATE_FILE);
	const tempPath = `${path}.tmp`;

	try {
		writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
		renameSync(tempPath, path);
	} catch (error) {
		sessionLogger.warn({ error: String(error) }, "Failed to save health state");
	}
}

// =============================================================================
// Metrics Collection
// =============================================================================

/**
 * Record a task outcome for health tracking
 */
export function recordTaskOutcome(
	outcome: TaskOutcome,
	stateDir: string = DEFAULT_STATE_DIR,
	thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): void {
	const state = loadHealthState(stateDir);

	// Add to recent outcomes, keeping only the rolling window
	state.recentOutcomes.push(outcome);
	if (state.recentOutcomes.length > thresholds.rollingWindowSize * 2) {
		state.recentOutcomes = state.recentOutcomes.slice(-thresholds.rollingWindowSize * 2);
	}

	// Update goal progress if tracking a goal
	if (state.currentGoal && outcome.success) {
		state.goalTasksCompleted = (state.goalTasksCompleted || 0) + 1;
	}

	saveHealthState(state, stateDir);
}

/**
 * Compute rolling metrics from recent outcomes
 */
export function computeRollingMetrics(
	outcomes: TaskOutcome[],
	windowSize: number = DEFAULT_HEALTH_THRESHOLDS.rollingWindowSize,
): RollingMetrics {
	const recent = outcomes.slice(-windowSize);

	if (recent.length === 0) {
		return {
			windowSize: 0,
			successRate: 1, // Assume healthy if no data
			noChangesRate: 0,
			tasksWithKnowledge: 0,
			tasksWithFilePrediction: 0,
		};
	}

	const successCount = recent.filter((o) => o.success).length;
	const noChangesCount = recent.filter((o) => o.noChanges).length;
	const knowledgeCount = recent.filter((o) => o.usedKnowledge).length;
	const filePredCount = recent.filter((o) => o.usedFilePrediction).length;

	// Find last success and last task times
	const successfulTasks = recent.filter((o) => o.success);
	const lastSuccessAt =
		successfulTasks.length > 0 ? successfulTasks[successfulTasks.length - 1].completedAt : undefined;
	const lastTaskAt = recent.length > 0 ? recent[recent.length - 1].completedAt : undefined;

	return {
		windowSize: recent.length,
		successRate: successCount / recent.length,
		noChangesRate: noChangesCount / recent.length,
		tasksWithKnowledge: knowledgeCount,
		tasksWithFilePrediction: filePredCount,
		lastSuccessAt,
		lastTaskAt,
	};
}

// =============================================================================
// Concern Detection
// =============================================================================

/**
 * Detect health concerns based on rolling metrics and effectiveness report
 */
export function detectConcerns(
	rolling: RollingMetrics,
	effectiveness: EffectivenessReport,
	thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthConcern[] {
	const concerns: HealthConcern[] = [];

	// Check success rate
	if (rolling.windowSize >= 5 && rolling.successRate < thresholds.minSuccessRate) {
		const severity: HealthConcernSeverity = rolling.successRate < 0.7 ? "critical" : "warning";
		concerns.push({
			severity,
			category: "success_rate",
			message: `Rolling success rate is ${(rolling.successRate * 100).toFixed(1)}% (threshold: ${(thresholds.minSuccessRate * 100).toFixed(0)}%)`,
			currentValue: rolling.successRate,
			threshold: thresholds.minSuccessRate,
			recommendation: "Consider decomposing tasks into smaller units or improving task specifications",
		});
	}

	// Check no_changes rate
	if (rolling.windowSize >= 5 && rolling.noChangesRate > thresholds.maxNoChangesRate) {
		concerns.push({
			severity: "warning",
			category: "no_changes",
			message: `"no_changes" rate is ${(rolling.noChangesRate * 100).toFixed(1)}% (threshold: ${(thresholds.maxNoChangesRate * 100).toFixed(0)}%)`,
			currentValue: rolling.noChangesRate,
			threshold: thresholds.maxNoChangesRate,
			recommendation: "Tasks may be too vague or exploratory - ensure each task has a clear code deliverable",
		});
	}

	// Check knowledge injection effectiveness
	const ki = effectiveness.knowledgeInjection;
	if (ki.tasksWithKnowledge >= 10 && ki.successRateDelta < thresholds.minKnowledgeDelta) {
		concerns.push({
			severity: ki.successRateDelta < -0.1 ? "critical" : "warning",
			category: "knowledge",
			message: `Knowledge injection is hurting performance: ${(ki.successRateDelta * 100).toFixed(1)}% delta`,
			currentValue: ki.successRateDelta,
			threshold: thresholds.minKnowledgeDelta,
			recommendation: "Consider disabling knowledge injection or increasing confidence thresholds",
		});
	}

	// Check self-tuning effectiveness
	const st = effectiveness.selfTuning;
	if (st.recommendationsFollowed >= 10 && st.successRateDelta < thresholds.minSelfTuningDelta) {
		concerns.push({
			severity: "warning",
			category: "self_tuning",
			message: `Self-tuning recommendations are hurting performance: ${(st.successRateDelta * 100).toFixed(1)}% delta`,
			currentValue: st.successRateDelta,
			threshold: thresholds.minSelfTuningDelta,
			recommendation: "Self-tuning should be disabled (set UNDERCITY_SELF_TUNING_ENABLED=false)",
		});
	}

	// Check file prediction accuracy
	const fp = effectiveness.filePrediction;
	if (fp.tasksWithPredictions >= 10 && fp.avgPrecision < thresholds.minFilePredictionPrecision) {
		concerns.push({
			severity: "info",
			category: "file_prediction",
			message: `File prediction precision is low: ${(fp.avgPrecision * 100).toFixed(1)}% (threshold: ${(thresholds.minFilePredictionPrecision * 100).toFixed(0)}%)`,
			currentValue: fp.avgPrecision,
			threshold: thresholds.minFilePredictionPrecision,
			recommendation: "File predictions are not accurate enough to be helpful - consider disabling",
		});
	}

	return concerns;
}

/**
 * Determine overall health status from concerns
 */
export function determineHealthStatus(concerns: HealthConcern[]): HealthStatus {
	const hasCritical = concerns.some((c) => c.severity === "critical");
	const hasWarning = concerns.some((c) => c.severity === "warning");

	if (hasCritical) return "critical";
	if (hasWarning) return "degraded";
	return "healthy";
}

// =============================================================================
// Health Report Generation
// =============================================================================

/**
 * Generate a comprehensive health report
 */
export function generateHealthReport(
	stateDir: string = DEFAULT_STATE_DIR,
	thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthReport {
	const state = loadHealthState(stateDir);
	const effectiveness = analyzeEffectiveness(stateDir);
	const rolling = computeRollingMetrics(state.recentOutcomes, thresholds.rollingWindowSize);
	const concerns = detectConcerns(rolling, effectiveness, thresholds);
	const status = determineHealthStatus(concerns);

	// Calculate goal progress if tracking
	let goalProgress: HealthReport["goalProgress"];
	if (state.currentGoal && state.goalStartedAt) {
		const hoursElapsed = (Date.now() - new Date(state.goalStartedAt).getTime()) / (1000 * 60 * 60);
		const tasksCompleted = state.goalTasksCompleted || 0;

		// Detect stall: no progress in last N hours
		const lastSuccessTime = rolling.lastSuccessAt ? new Date(rolling.lastSuccessAt).getTime() : 0;
		const hoursSinceSuccess = (Date.now() - lastSuccessTime) / (1000 * 60 * 60);
		const stalled = hoursSinceSuccess > thresholds.goalStallHours;

		if (stalled) {
			concerns.push({
				severity: "warning",
				category: "goal_progress",
				message: `No progress toward goal in ${hoursSinceSuccess.toFixed(1)} hours`,
				currentValue: hoursSinceSuccess,
				threshold: thresholds.goalStallHours,
				recommendation: "Consider refocusing tasks or requesting human guidance",
			});
		}

		goalProgress = {
			goal: state.currentGoal,
			percentComplete: 0, // Would need external input to calculate
			tasksCompleted,
			hoursElapsed,
			stalled,
		};
	}

	const actionsTaken: string[] = [];

	// Update last report time
	state.lastReportAt = new Date().toISOString();
	saveHealthState(state, stateDir);

	return {
		status,
		generatedAt: new Date().toISOString(),
		rollingMetrics: rolling,
		effectiveness,
		concerns,
		actionsTaken,
		goalProgress,
	};
}

/**
 * Format a health report for human-readable output
 */
export function formatHealthReport(report: HealthReport): string {
	const lines: string[] = [];

	// Header with status
	const statusEmoji = {
		healthy: "[OK]",
		degraded: "[WARN]",
		critical: "[CRIT]",
	};
	lines.push(`HEALTH CHECK ${statusEmoji[report.status]} (${report.status.toUpperCase()})`);
	lines.push("=".repeat(50));
	lines.push("");

	// Rolling metrics
	lines.push("ROLLING METRICS (last 10 tasks)");
	lines.push("-".repeat(40));
	const rm = report.rollingMetrics;
	if (rm.windowSize > 0) {
		lines.push(`  Tasks in window: ${rm.windowSize}`);
		lines.push(`  Success rate: ${(rm.successRate * 100).toFixed(1)}%`);
		lines.push(`  No-changes rate: ${(rm.noChangesRate * 100).toFixed(1)}%`);
		lines.push(`  Using knowledge: ${rm.tasksWithKnowledge}`);
		lines.push(`  Using file prediction: ${rm.tasksWithFilePrediction}`);
	} else {
		lines.push("  No recent task data");
	}
	lines.push("");

	// Goal progress
	if (report.goalProgress) {
		lines.push("GOAL PROGRESS");
		lines.push("-".repeat(40));
		lines.push(`  Goal: ${report.goalProgress.goal}`);
		lines.push(`  Tasks completed: ${report.goalProgress.tasksCompleted}`);
		lines.push(`  Hours elapsed: ${report.goalProgress.hoursElapsed.toFixed(1)}`);
		lines.push(`  Stalled: ${report.goalProgress.stalled ? "YES" : "No"}`);
		lines.push("");
	}

	// Concerns
	if (report.concerns.length > 0) {
		lines.push("CONCERNS");
		lines.push("-".repeat(40));
		for (const concern of report.concerns) {
			const severity = concern.severity.toUpperCase().padEnd(8);
			lines.push(`  [${severity}] ${concern.message}`);
			lines.push(`             Recommendation: ${concern.recommendation}`);
		}
		lines.push("");
	}

	// Actions taken
	if (report.actionsTaken.length > 0) {
		lines.push("ACTIONS TAKEN");
		lines.push("-".repeat(40));
		for (const action of report.actionsTaken) {
			lines.push(`  - ${action}`);
		}
		lines.push("");
	}

	// Key effectiveness metrics
	lines.push("LEARNING SYSTEM HEALTH");
	lines.push("-".repeat(40));
	const ki = report.effectiveness.knowledgeInjection;
	const st = report.effectiveness.selfTuning;
	const fp = report.effectiveness.filePrediction;

	if (ki.tasksWithKnowledge > 0) {
		const kiDelta = ki.successRateDelta >= 0 ? "+" : "";
		lines.push(`  Knowledge injection: ${kiDelta}${(ki.successRateDelta * 100).toFixed(1)}% delta`);
	}
	if (st.tasksWithRecommendations > 0) {
		const stDelta = st.successRateDelta >= 0 ? "+" : "";
		lines.push(`  Self-tuning: ${stDelta}${(st.successRateDelta * 100).toFixed(1)}% delta`);
	}
	if (fp.tasksWithPredictions > 0) {
		lines.push(`  File prediction: ${(fp.avgPrecision * 100).toFixed(1)}% precision`);
	}

	return lines.join("\n");
}

// =============================================================================
// Goal Tracking
// =============================================================================

/**
 * Set a goal to track progress toward
 */
export function setGoal(goal: string, stateDir: string = DEFAULT_STATE_DIR): void {
	const state = loadHealthState(stateDir);
	state.currentGoal = goal;
	state.goalStartedAt = new Date().toISOString();
	state.goalTasksCompleted = 0;
	saveHealthState(state, stateDir);
	sessionLogger.info({ goal }, "Health monitor: goal set");
}

/**
 * Clear the current goal
 */
export function clearGoal(stateDir: string = DEFAULT_STATE_DIR): void {
	const state = loadHealthState(stateDir);
	state.currentGoal = undefined;
	state.goalStartedAt = undefined;
	state.goalTasksCompleted = undefined;
	saveHealthState(state, stateDir);
	sessionLogger.info("Health monitor: goal cleared");
}
