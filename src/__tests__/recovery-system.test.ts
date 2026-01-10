/**
 * Recovery System Tests
 *
 * Tests for the error recovery, checkpoint, and escalation systems.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../checkpoint-manager.js";
import { ErrorEscalationManager } from "../error-escalation.js";
import { RecoveryManager } from "../recovery-manager.js";
import { RecoveryOrchestrator } from "../recovery-orchestrator.js";
import type { AgentType, Waypoint } from "../types.js";

describe("Recovery System", () => {
	let checkpointManager: CheckpointManager;
	let recoveryOrchestrator: RecoveryOrchestrator;
	let escalationManager: ErrorEscalationManager;
	let recoveryManager: RecoveryManager;

	beforeEach(() => {
		checkpointManager = new CheckpointManager();
		escalationManager = new ErrorEscalationManager();
		recoveryOrchestrator = new RecoveryOrchestrator(
			checkpointManager,
			undefined, // No initial state
			undefined, // No rate limit tracker for tests
		);
		recoveryManager = new RecoveryManager(checkpointManager, recoveryOrchestrator, escalationManager);
	});

	describe("CheckpointManager", () => {
		it("should support checkpoints for quester agents", () => {
			expect(checkpointManager.supportsCheckpoints("quester")).toBe(true);
		});

		it("should not support checkpoints for flute agents", () => {
			expect(checkpointManager.supportsCheckpoints("flute")).toBe(false);
		});

		it("should create manual checkpoint for supported agents", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Test implementation",
				status: "in_progress",
				createdAt: new Date(),
			};

			const checkpoint = checkpointManager.createManualCheckpoint(waypoint, {
				progressDescription: "Test checkpoint",
				modifiedFiles: ["test.ts"],
				completionPercent: 50,
			});

			expect(checkpoint).toBeTruthy();
			expect(checkpoint?.progressDescription).toBe("[Manual] Test checkpoint");
			expect(checkpoint?.modifiedFiles).toEqual(["test.ts"]);
			expect(checkpoint?.completionPercent).toBe(50);
		});

		it("should get recovery configurations for different agent types", () => {
			const fluteConfig = checkpointManager.getRecoveryConfig("flute");
			const questerConfig = checkpointManager.getRecoveryConfig("quester");

			expect(fluteConfig.maxRetries).toBe(2);
			expect(fluteConfig.checkpointsEnabled).toBe(false);

			expect(questerConfig.maxRetries).toBe(5);
			expect(questerConfig.checkpointsEnabled).toBe(true);
			expect(questerConfig.checkpointIntervalMinutes).toBe(2);
		});
	});

	describe("ErrorEscalationManager", () => {
		it("should determine auto-retry escalation for low-severity errors", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Test implementation",
				status: "failed",
				createdAt: new Date(),
			};

			const escalationContext = {
				waypoint,
				error: new Error("Connection timeout"),
				classification: {
					type: "timeout" as const,
					severity: "low" as const,
					isTransient: true,
					affectsOthers: false,
					recommendedStrategy: "retry" as const,
				},
				attemptCount: 1,
				timeSinceFirstFailure: 30000, // 30 seconds
				affectsOtherWaypoints: false,
				raidProgressPercent: 50,
			};

			const decision = escalationManager.determineEscalation(escalationContext);

			expect(decision.level).toBe("auto_retry");
			expect(decision.urgent).toBe(false);
		});

		it("should escalate to human intervention for critical errors", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Test implementation",
				status: "failed",
				createdAt: new Date(),
			};

			const escalationContext = {
				waypoint,
				error: new Error("Critical system error - data corruption detected"),
				classification: {
					type: "crash" as const,
					severity: "critical" as const,
					isTransient: false,
					affectsOthers: true,
					recommendedStrategy: "escalate" as const,
				},
				attemptCount: 1,
				timeSinceFirstFailure: 30000,
				affectsOtherWaypoints: true,
				raidProgressPercent: 50,
			};

			const decision = escalationManager.determineEscalation(escalationContext);

			expect(decision.level).toBe("human_intervention");
			expect(decision.urgent).toBe(true);
			expect(decision.impact).toBe("critical");
		});

		it("should determine waypoint status from escalation level", () => {
			expect(escalationManager.determineWaypointStatus("auto_retry")).toBe("recovering");
			expect(escalationManager.determineWaypointStatus("human_intervention")).toBe("escalated");
			expect(escalationManager.determineWaypointStatus("abort_raid")).toBe("escalated");
		});
	});

	describe("RecoveryOrchestrator", () => {
		it("should classify rate limit errors correctly", () => {
			const classification = recoveryOrchestrator.classifyError(
				new Error("Rate limit exceeded - 429 Too Many Requests"),
				"quester",
			);

			expect(classification.type).toBe("rate_limit");
			expect(classification.isTransient).toBe(true);
			expect(classification.affectsOthers).toBe(true);
		});

		it("should classify timeout errors correctly", () => {
			const classification = recoveryOrchestrator.classifyError("Agent timeout - inactive for 15 minutes", "logistics");

			expect(classification.type).toBe("timeout");
			expect(classification.severity).toBe("medium");
			expect(classification.isTransient).toBe(false);
		});

		it("should determine if waypoint can be recovered", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Test implementation",
				status: "failed",
				createdAt: new Date(),
				recoveryAttempts: 1, // Not exceeded max retries
			};

			const canRecover = recoveryOrchestrator.canRecover(waypoint, new Error("Temporary network error"));

			expect(canRecover).toBe(true);
		});

		it("should not recover waypoint that exceeded max retries", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "flute", // Flute has only 2 max retries
				description: "Test recon",
				status: "failed",
				createdAt: new Date(),
				recoveryAttempts: 3, // Exceeded max retries
			};

			const canRecover = recoveryOrchestrator.canRecover(waypoint, new Error("Connection failed"));

			expect(canRecover).toBe(false);
		});
	});

	describe("RecoveryManager", () => {
		it("should start and stop managing waypoint recovery", () => {
			const waypoint: Waypoint = {
				id: "test-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Test implementation",
				status: "in_progress",
				createdAt: new Date(),
			};

			// Start managing
			recoveryManager.startManaging(waypoint);

			// Should have started checkpoint monitoring
			const stats = recoveryManager.getSystemStats();
			expect(stats.activeMonitoring).toBe(1);

			// Stop managing
			recoveryManager.stopManaging(waypoint.id);

			// Should have stopped monitoring
			const statsAfter = recoveryManager.getSystemStats();
			expect(statsAfter.activeMonitoring).toBe(0);
		});

		it("should provide system statistics", () => {
			const stats = recoveryManager.getSystemStats();

			expect(stats).toHaveProperty("successRate");
			expect(stats).toHaveProperty("totalAttempts");
			expect(stats).toHaveProperty("activeMonitoring");
			expect(stats).toHaveProperty("urgentEscalations");
			expect(stats).toHaveProperty("byAgentType");

			expect(stats.byAgentType).toHaveProperty("flute");
			expect(stats.byAgentType).toHaveProperty("logistics");
			expect(stats.byAgentType).toHaveProperty("quester");
			expect(stats.byAgentType).toHaveProperty("sheriff");
		});

		it("should detect waypoints requiring immediate attention", () => {
			const waypoint: Waypoint = {
				id: "critical-waypoint",
				raidId: "test-raid",
				type: "quester",
				description: "Critical task",
				status: "escalated",
				createdAt: new Date(),
			};

			// Force escalation
			recoveryManager.forceEscalation(waypoint.id, "Critical system failure");

			const requiresAttention = recoveryManager.requiresImmediateAttention(waypoint.id);
			expect(requiresAttention).toBe(true);

			const waypointsNeedingAttention = recoveryManager.getWaypointsRequiringAttention();
			expect(waypointsNeedingAttention).toContain(waypoint.id);
		});
	});

	describe("Agent-Specific Recovery Strategies", () => {
		it("should have different recovery configs for different agents", () => {
			const configs = {
				flute: checkpointManager.getRecoveryConfig("flute"),
				logistics: checkpointManager.getRecoveryConfig("logistics"),
				quester: checkpointManager.getRecoveryConfig("quester"),
				sheriff: checkpointManager.getRecoveryConfig("sheriff"),
			};

			// Flute: Fail fast (2 retries), no checkpoints
			expect(configs.flute.maxRetries).toBe(2);
			expect(configs.flute.checkpointsEnabled).toBe(false);

			// Logistics: Moderate recovery (3 retries), checkpoint planning
			expect(configs.logistics.maxRetries).toBe(3);
			expect(configs.logistics.checkpointsEnabled).toBe(true);
			expect(configs.logistics.checkpointIntervalMinutes).toBe(5);

			// Quester: Aggressive recovery (5 retries), full checkpoints
			expect(configs.quester.maxRetries).toBe(5);
			expect(configs.quester.checkpointsEnabled).toBe(true);
			expect(configs.quester.checkpointIntervalMinutes).toBe(2);

			// Sheriff: Standard recovery (3 retries), no checkpoints
			expect(configs.sheriff.maxRetries).toBe(3);
			expect(configs.sheriff.checkpointsEnabled).toBe(false);
		});

		it("should classify errors differently based on patterns", () => {
			const testCases = [
				{
					error: "429 Rate limit exceeded",
					expectedType: "rate_limit",
					expectedSeverity: "medium",
					expectedTransient: true,
				},
				{
					error: "Agent timeout - stuck for 20 minutes",
					expectedType: "timeout",
					expectedSeverity: "medium",
					expectedTransient: false,
				},
				{
					error: "TypeScript compilation failed",
					expectedType: "validation_error",
					expectedSeverity: "medium",
					expectedTransient: false,
				},
				{
					error: "Segmentation fault in process",
					expectedType: "crash",
					expectedSeverity: "critical",
					expectedTransient: false,
				},
			];

			for (const testCase of testCases) {
				const classification = recoveryOrchestrator.classifyError(testCase.error, "quester");

				expect(classification.type).toBe(testCase.expectedType);
				expect(classification.severity).toBe(testCase.expectedSeverity);
				expect(classification.isTransient).toBe(testCase.expectedTransient);
			}
		});
	});
});
