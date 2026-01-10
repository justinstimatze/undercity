/**
 * Raid Phase Tracker
 *
 * Provides comprehensive timing tracking for the Undercity raid lifecycle:
 * - Phase timing: Track major raid phases (planning, executing, reviewing, merging, extracting)
 * - Agent timing: Track individual agent performance (flute, logistics, quester, sheriff)
 *
 * Features:
 * - Real-time timing logs during raid execution
 * - Performance insights for bottleneck identification
 * - Crash recovery with state persistence (GUPP compliance)
 * - Summary reports on completion
 */

import { raidLogger } from "./logger.js";
import type { AgentType, RaidStatus } from "./types.js";

/**
 * Timing data for a specific phase or agent
 */
export interface PhaseTimingData {
	/** When the phase/agent started */
	startedAt: Date;
	/** When the phase/agent completed (undefined if still active) */
	completedAt?: Date;
	/** Duration in milliseconds (calculated when completed) */
	durationMs?: number;
}

/**
 * Complete timing data for a raid phase
 */
export interface RaidPhaseTimings {
	/** Phase-level timings */
	phases: {
		planning?: PhaseTimingData;
		executing?: PhaseTimingData;
		reviewing?: PhaseTimingData;
		merging?: PhaseTimingData;
		extracting?: PhaseTimingData;
	};
	/** Agent-level timings (can have multiple entries per agent type) */
	agents: {
		flute: PhaseTimingData[];
		logistics: PhaseTimingData[];
		quester: PhaseTimingData[];
		sheriff: PhaseTimingData[];
	};
	/** Overall raid timing */
	overall?: PhaseTimingData;
}

/**
 * Performance summary for analysis
 */
export interface RaidTimingSummary {
	/** Total raid duration */
	totalDurationMs: number;
	/** Phase breakdown */
	phaseBreakdown: Array<{
		phase: string;
		durationMs: number;
		percentage: number;
	}>;
	/** Agent performance */
	agentPerformance: Array<{
		agentType: AgentType;
		totalDurationMs: number;
		averageDurationMs: number;
		executionCount: number;
	}>;
	/** Plan to execution ratio */
	planToExecutionRatio?: number;
	/** Bottleneck identification */
	slowestPhase: string;
	slowestAgent: AgentType;
}

/**
 * Raid Phase Tracker implementation
 */
export class RaidPhaseTracker {
	private timings: RaidPhaseTimings;
	private raidId: string;
	private currentPhase: keyof RaidPhaseTimings["phases"] | null = null;
	private activeAgents: Map<string, { agentType: AgentType; startedAt: Date }> = new Map();

	constructor(raidId: string, existingTimings?: RaidPhaseTimings) {
		this.raidId = raidId;
		this.timings = existingTimings || {
			phases: {},
			agents: {
				flute: [],
				logistics: [],
				quester: [],
				sheriff: [],
			},
		};
	}

	/**
	 * Start tracking the overall raid
	 */
	startRaid(): void {
		if (!this.timings.overall) {
			this.timings.overall = {
				startedAt: new Date(),
			};
			raidLogger.info({ raidId: this.raidId }, "Started raid timing tracking");
		}
	}

	/**
	 * Start tracking a raid phase
	 */
	startPhase(phase: keyof RaidPhaseTimings["phases"]): void {
		// Complete the previous phase if active
		if (this.currentPhase && !this.timings.phases[this.currentPhase]?.completedAt) {
			this.completePhase(this.currentPhase);
		}

		this.currentPhase = phase;
		this.timings.phases[phase] = {
			startedAt: new Date(),
		};

		raidLogger.info(
			{
				raidId: this.raidId,
				phase,
				startedAt: this.timings.phases[phase]?.startedAt,
			},
			`Started ${phase} phase`,
		);
	}

	/**
	 * Complete tracking a raid phase
	 */
	completePhase(phase: keyof RaidPhaseTimings["phases"]): void {
		const phaseData = this.timings.phases[phase];
		if (phaseData && !phaseData.completedAt) {
			const completedAt = new Date();
			phaseData.completedAt = completedAt;
			phaseData.durationMs = completedAt.getTime() - phaseData.startedAt.getTime();

			raidLogger.info(
				{
					raidId: this.raidId,
					phase,
					durationMs: phaseData.durationMs,
					durationMinutes: Math.round((phaseData.durationMs / 60000) * 10) / 10,
				},
				`Completed ${phase} phase`,
			);

			// Clear current phase if this was the active one
			if (this.currentPhase === phase) {
				this.currentPhase = null;
			}
		}
	}

	/**
	 * Start tracking an agent
	 */
	startAgent(agentId: string, agentType: AgentType): void {
		const startedAt = new Date();
		this.activeAgents.set(agentId, { agentType, startedAt });

		raidLogger.info(
			{
				raidId: this.raidId,
				agentId,
				agentType,
				startedAt,
			},
			`Started ${agentType} agent`,
		);
	}

	/**
	 * Complete tracking an agent
	 */
	completeAgent(agentId: string): void {
		const agentData = this.activeAgents.get(agentId);
		if (agentData) {
			const completedAt = new Date();
			const durationMs = completedAt.getTime() - agentData.startedAt.getTime();

			// Add to agent timings
			this.timings.agents[agentData.agentType].push({
				startedAt: agentData.startedAt,
				completedAt,
				durationMs,
			});

			raidLogger.info(
				{
					raidId: this.raidId,
					agentId,
					agentType: agentData.agentType,
					durationMs,
					durationMinutes: Math.round((durationMs / 60000) * 10) / 10,
				},
				`Completed ${agentData.agentType} agent`,
			);

			// Remove from active tracking
			this.activeAgents.delete(agentId);
		}
	}

	/**
	 * Complete the overall raid tracking
	 */
	completeRaid(): void {
		if (this.timings.overall && !this.timings.overall.completedAt) {
			const completedAt = new Date();
			this.timings.overall.completedAt = completedAt;
			this.timings.overall.durationMs = completedAt.getTime() - this.timings.overall.startedAt.getTime();

			// Complete any active phase
			if (this.currentPhase && !this.timings.phases[this.currentPhase]?.completedAt) {
				this.completePhase(this.currentPhase);
			}

			// Complete any remaining active agents
			for (const agentId of this.activeAgents.keys()) {
				this.completeAgent(agentId);
			}

			const summary = this.generateSummary();
			raidLogger.info(
				{
					raidId: this.raidId,
					summary,
				},
				"Completed raid timing tracking",
			);
		}
	}

	/**
	 * Handle raid resumption after crashes (GUPP compliance)
	 */
	handleResumption(currentStatus: RaidStatus): void {
		// Map raid status to phase
		const statusToPhase: Record<RaidStatus, keyof RaidPhaseTimings["phases"] | null> = {
			planning: "planning",
			awaiting_approval: "planning", // Still in planning
			executing: "executing",
			reviewing: "reviewing",
			merging: "merging",
			extracting: "extracting",
			merge_failed: null, // No specific phase
			complete: null, // Completed
			failed: null, // Failed
		};

		const phase = statusToPhase[currentStatus];

		// If we're in an active phase but don't have timing data, start tracking
		if (phase && !this.timings.phases[phase]) {
			this.startPhase(phase);
			raidLogger.info({ raidId: this.raidId, phase, currentStatus }, "Resumed timing tracking after crash recovery");
		}
	}

	/**
	 * Generate a performance summary
	 */
	generateSummary(): RaidTimingSummary | null {
		if (!this.timings.overall?.durationMs) {
			return null;
		}

		const totalDurationMs = this.timings.overall.durationMs;

		// Phase breakdown
		const phaseBreakdown = Object.entries(this.timings.phases)
			.filter(([_, data]) => data.durationMs)
			.map(([phase, data]) => ({
				phase,
				durationMs: data.durationMs!,
				percentage: Math.round((data.durationMs! / totalDurationMs) * 100),
			}))
			.sort((a, b) => b.durationMs - a.durationMs);

		// Agent performance
		const agentPerformance: RaidTimingSummary["agentPerformance"] = [];
		for (const [agentType, timings] of Object.entries(this.timings.agents) as Array<[AgentType, PhaseTimingData[]]>) {
			const completedTimings = timings.filter((t) => t.durationMs);
			if (completedTimings.length > 0) {
				const totalDurationMs = completedTimings.reduce((sum, t) => sum + t.durationMs!, 0);
				const averageDurationMs = totalDurationMs / completedTimings.length;
				agentPerformance.push({
					agentType,
					totalDurationMs,
					averageDurationMs,
					executionCount: completedTimings.length,
				});
			}
		}

		// Plan to execution ratio
		let planToExecutionRatio: number | undefined;
		const planningDuration = this.timings.phases.planning?.durationMs;
		const executingDuration = this.timings.phases.executing?.durationMs;
		if (planningDuration && executingDuration && executingDuration > 0) {
			planToExecutionRatio = Math.round((planningDuration / executingDuration) * 100) / 100;
		}

		// Bottleneck identification
		const slowestPhase = phaseBreakdown.length > 0 ? phaseBreakdown[0].phase : "unknown";
		const slowestAgent =
			agentPerformance.length > 0
				? agentPerformance.reduce((a, b) => (a.averageDurationMs > b.averageDurationMs ? a : b)).agentType
				: ("flute" as AgentType);

		return {
			totalDurationMs,
			phaseBreakdown,
			agentPerformance,
			planToExecutionRatio,
			slowestPhase,
			slowestAgent,
		};
	}

	/**
	 * Get current timing state for persistence
	 */
	getState(): RaidPhaseTimings {
		return this.timings;
	}

	/**
	 * Log current timing status for debugging
	 */
	logCurrentStatus(): void {
		const activePhase = this.currentPhase;
		const activeAgentCount = this.activeAgents.size;
		const completedPhases = Object.keys(this.timings.phases).filter(
			(phase) => this.timings.phases[phase as keyof RaidPhaseTimings["phases"]]?.completedAt,
		);

		raidLogger.info(
			{
				raidId: this.raidId,
				activePhase,
				activeAgentCount,
				completedPhases,
			},
			"Current timing status",
		);
	}
}
