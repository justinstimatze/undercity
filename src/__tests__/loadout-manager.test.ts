/**
 * Tests for the LoadoutManager class
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadoutManager } from "../loadout-manager.js";
import { Persistence } from "../persistence.js";
import type { Quest } from "../quest.js";
import type { EfficiencyMetrics, LoadoutConfiguration, LoadoutPerformanceRecord, LoadoutRecommendation, LoadoutScore, Raid } from "../types.js";

// Mock Persistence
vi.mock("../persistence.js", () => {
	class MockPersistence {
		private loadoutConfigs: LoadoutConfiguration[] = [];
		private performances: LoadoutPerformanceRecord[] = [];
		private scores: LoadoutScore[] = [];
		private recommendations: LoadoutRecommendation[] = [];

		getLoadoutConfigurations() {
			return this.loadoutConfigs;
		}
		saveLoadoutConfiguration(config: LoadoutConfiguration) {
			const existing = this.loadoutConfigs.findIndex((l) => l.id === config.id);
			if (existing >= 0) {
				this.loadoutConfigs[existing] = config;
			} else {
				this.loadoutConfigs.push(config);
			}
		}
		removeLoadoutConfiguration(id: string) {
			this.loadoutConfigs = this.loadoutConfigs.filter((l) => l.id !== id);
		}
		getLoadoutPerformances() {
			return this.performances;
		}
		addLoadoutPerformance(performance: any) {
			this.performances.push(performance);
		}
		getLoadoutPerformancesForConfig(configId: string) {
			return this.performances.filter((p) => p.loadoutConfigId === configId);
		}
		getLoadoutPerformancesForQuestType(questType: string) {
			return this.performances.filter((p) => p.questType === questType);
		}
		getLoadoutScores() {
			return this.scores;
		}
		saveLoadoutScore(score: any) {
			const existing = this.scores.findIndex((s) => s.loadoutConfigId === score.loadoutConfigId);
			if (existing >= 0) {
				this.scores[existing] = score;
			} else {
				this.scores.push(score);
			}
		}
		getLoadoutScore(configId: string) {
			return this.scores.find((s) => s.loadoutConfigId === configId);
		}
		getLoadoutRecommendations() {
			return this.recommendations;
		}
		saveLoadoutRecommendation(rec: any) {
			const existing = this.recommendations.findIndex((r) => r.questType === rec.questType);
			if (existing >= 0) {
				this.recommendations[existing] = rec;
			} else {
				this.recommendations.push(rec);
			}
		}
		getLoadoutRecommendationForQuestType(questType: string) {
			return this.recommendations.find((r) => r.questType === questType);
		}
		cleanupOldPerformanceData() {
			/* mock */
		}
	}

	return { Persistence: MockPersistence };
});

// Mock the logger to prevent console spam during tests
vi.mock("../logger.js", () => ({
	persistenceLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe("LoadoutManager", () => {
	let loadoutManager: LoadoutManager;
	let mockPersistence: Persistence;

	const mockLoadout: LoadoutConfiguration = {
		id: "test-loadout",
		name: "Test Loadout",
		description: "Test configuration",
		maxSquadSize: 4,
		enabledAgentTypes: ["flute", "logistics", "quester", "sheriff"],
		modelChoices: {
			flute: "haiku",
			logistics: "sonnet",
			quester: "sonnet",
			sheriff: "opus",
		},
		contextSize: "medium",
		parallelismLevel: "limited",
		autoApprove: false,
		lastUpdated: new Date(),
	};

	beforeEach(() => {
		mockPersistence = new Persistence();
		loadoutManager = new LoadoutManager(mockPersistence);
	});

	describe("Loadout Configuration Management", () => {
		it("should initialize with default loadouts", () => {
			const loadouts = loadoutManager.getAllLoadouts();
			expect(loadouts.length).toBeGreaterThan(0);

			const loadoutIds = loadouts.map((l) => l.id);
			expect(loadoutIds).toContain("balanced-performer");
			expect(loadoutIds).toContain("speed-demon");
		});

		it("should save and retrieve loadout configurations", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const retrieved = loadoutManager.getLoadout(mockLoadout.id);
			expect(retrieved).toBeDefined();
			expect(retrieved?.name).toBe(mockLoadout.name);
			expect(retrieved?.id).toBe(mockLoadout.id);
		});

		it("should update existing loadout configurations", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const updated = { ...mockLoadout, name: "Updated Test Loadout" };
			loadoutManager.saveLoadout(updated);

			const retrieved = loadoutManager.getLoadout(mockLoadout.id);
			expect(retrieved?.name).toBe("Updated Test Loadout");
		});

		it("should remove loadout configurations", () => {
			loadoutManager.saveLoadout(mockLoadout);
			expect(loadoutManager.getLoadout(mockLoadout.id)).toBeDefined();

			const removed = loadoutManager.removeLoadout(mockLoadout.id);
			expect(removed).toBe(true);
			expect(loadoutManager.getLoadout(mockLoadout.id)).toBeUndefined();
		});

		it("should return false when removing non-existent loadout", () => {
			const removed = loadoutManager.removeLoadout("non-existent");
			expect(removed).toBe(false);
		});

		it("should clone loadout configurations", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const cloned = loadoutManager.cloneLoadout(mockLoadout.id, "Cloned Loadout");
			expect(cloned).toBeDefined();
			expect(cloned?.name).toBe("Cloned Loadout");
			expect(cloned?.id).not.toBe(mockLoadout.id);
			expect(cloned?.maxSquadSize).toBe(mockLoadout.maxSquadSize);
		});

		it("should return null when cloning non-existent loadout", () => {
			const cloned = loadoutManager.cloneLoadout("non-existent", "Clone");
			expect(cloned).toBeNull();
		});
	});

	describe("Performance Tracking", () => {
		const mockQuest: Quest = {
			id: "quest-123",
			objective: "Fix authentication bug",
			status: "complete",
			createdAt: new Date(),
		};

		const mockRaid: Raid = {
			id: "raid-456",
			goal: "Fix authentication bug",
			status: "complete",
			startedAt: new Date(),
			completedAt: new Date(),
			planApproved: true,
		};

		const mockMetrics: EfficiencyMetrics = {
			timeToComplete: 30000,
			totalTokens: 50000,
			costInCents: 25,
			qualityScore: 85,
			retryCount: 0,
			success: true,
		};

		it("should record quest performance", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const performance = loadoutManager.recordQuestPerformance(mockLoadout, mockQuest, mockRaid, mockMetrics);

			expect(performance).toBeDefined();
			expect(performance.loadoutConfigId).toBe(mockLoadout.id);
			expect(performance.questId).toBe(mockQuest.id);
			expect(performance.metrics).toBe(mockMetrics);
		});

		it("should retrieve performance data for loadout", () => {
			loadoutManager.saveLoadout(mockLoadout);
			loadoutManager.recordQuestPerformance(mockLoadout, mockQuest, mockRaid, mockMetrics);

			const performances = loadoutManager.getLoadoutPerformance(mockLoadout.id);
			expect(performances.length).toBe(1);
			expect(performances[0].loadoutConfigId).toBe(mockLoadout.id);
		});

		it("should retrieve performance data by quest type", () => {
			loadoutManager.saveLoadout(mockLoadout);
			loadoutManager.recordQuestPerformance(mockLoadout, mockQuest, mockRaid, mockMetrics);

			const performances = loadoutManager.getQuestTypePerformance("debug");
			expect(performances.length).toBe(1);
			expect(performances[0].questType).toBe("debug");
		});
	});

	describe("Scoring System", () => {
		it("should calculate loadout scores after recording performance", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const mockQuest: Quest = {
				id: "quest-123",
				objective: "Fix bug in system",
				status: "complete",
				createdAt: new Date(),
			};

			const mockRaid: Raid = {
				id: "raid-456",
				goal: "Fix bug",
				status: "complete",
				startedAt: new Date(),
				planApproved: true,
			};

			const mockMetrics: EfficiencyMetrics = {
				timeToComplete: 30000,
				totalTokens: 50000,
				costInCents: 25,
				qualityScore: 85,
				retryCount: 0,
				success: true,
			};

			loadoutManager.recordQuestPerformance(mockLoadout, mockQuest, mockRaid, mockMetrics);

			const score = loadoutManager.getLoadoutScore(mockLoadout.id);
			expect(score).toBeDefined();
			expect(score?.loadoutConfigId).toBe(mockLoadout.id);
			expect(score?.overallScore).toBeGreaterThan(0);
		});

		it("should generate loadout rankings", () => {
			// Add multiple loadouts with performance data
			const fastLoadout = { ...mockLoadout, id: "fast-loadout", name: "Fast Loadout" };
			const slowLoadout = { ...mockLoadout, id: "slow-loadout", name: "Slow Loadout" };

			loadoutManager.saveLoadout(fastLoadout);
			loadoutManager.saveLoadout(slowLoadout);

			// Record better performance for fast loadout
			const quest: Quest = { id: "q1", objective: "Test waypoint", status: "complete", createdAt: new Date() };
			const raid: Raid = { id: "r1", goal: "Test", status: "complete", startedAt: new Date(), planApproved: true };

			loadoutManager.recordQuestPerformance(fastLoadout, quest, raid, {
				timeToComplete: 10000,
				totalTokens: 20000,
				costInCents: 10,
				qualityScore: 95,
				retryCount: 0,
				success: true,
			});

			loadoutManager.recordQuestPerformance(slowLoadout, quest, raid, {
				timeToComplete: 60000,
				totalTokens: 100000,
				costInCents: 50,
				qualityScore: 60,
				retryCount: 2,
				success: true,
			});

			const rankings = loadoutManager.getLoadoutRankings();
			expect(rankings.length).toBeGreaterThan(0);

			// Fast loadout should rank higher
			const fastRank = rankings.find((r) => r.loadout.id === "fast-loadout");
			const slowRank = rankings.find((r) => r.loadout.id === "slow-loadout");

			expect(fastRank?.score.overallScore).toBeGreaterThan(slowRank?.score.overallScore || 0);
		});
	});

	describe("Recommendation System", () => {
		it("should select best loadout for quest based on performance", () => {
			const debugLoadout = { ...mockLoadout, id: "debug-loadout", name: "Debug Loadout" };
			loadoutManager.saveLoadout(debugLoadout);

			// Record good performance for debug waypoints
			const debugQuest: Quest = {
				id: "debug-quest",
				objective: "Fix critical bug",
				status: "complete",
				createdAt: new Date(),
			};

			const raid: Raid = {
				id: "raid-debug",
				goal: "Fix bug",
				status: "complete",
				startedAt: new Date(),
				planApproved: true,
			};

			loadoutManager.recordQuestPerformance(debugLoadout, debugQuest, raid, {
				timeToComplete: 15000,
				totalTokens: 30000,
				costInCents: 15,
				qualityScore: 90,
				retryCount: 0,
				success: true,
			});

			// Test recommendation
			const newDebugQuest: Quest = {
				id: "new-debug-quest",
				objective: "Debug memory leak",
				status: "pending",
				createdAt: new Date(),
			};

			const bestLoadout = loadoutManager.getBestLoadoutForQuest(newDebugQuest);
			expect(bestLoadout).toBeDefined();
			// Should prefer the loadout with good debug performance
		});

		it("should generate quest type recommendations", () => {
			const debugLoadout = { ...mockLoadout, id: "debug-specialist-test" };
			loadoutManager.saveLoadout(debugLoadout);

			// Record multiple debug performances
			for (let i = 0; i < 3; i++) {
				const quest: Quest = {
					id: `debug-quest-${i}`,
					objective: "Fix bug in system",
					status: "complete",
					createdAt: new Date(),
				};

				const raid: Raid = {
					id: `raid-${i}`,
					goal: "Debug waypoint",
					status: "complete",
					startedAt: new Date(),
					planApproved: true,
				};

				loadoutManager.recordQuestPerformance(debugLoadout, quest, raid, {
					timeToComplete: 20000,
					totalTokens: 40000,
					costInCents: 20,
					qualityScore: 85,
					retryCount: 0,
					success: true,
				});
			}

			const recommendation = loadoutManager.getQuestTypeRecommendation("debug");
			expect(recommendation).toBeDefined();
			expect(recommendation?.questType).toBe("debug");
			expect(recommendation?.confidence).toBeGreaterThan(0);
		});

		it("should update all recommendations", () => {
			// This tests the batch update functionality
			loadoutManager.updateAllRecommendations();

			const recommendations = loadoutManager.getAllRecommendations();
			// Should not crash and should return an array
			expect(Array.isArray(recommendations)).toBe(true);
		});
	});

	describe("Analytics", () => {
		it("should provide comprehensive analytics", () => {
			const analytics = loadoutManager.getAnalytics();

			expect(analytics).toBeDefined();
			expect(typeof analytics.totalLoadouts).toBe("number");
			expect(typeof analytics.totalPerformanceRecords).toBe("number");
			expect(typeof analytics.averageSuccessRate).toBe("number");
			expect(typeof analytics.questTypeBreakdown).toBe("object");
		});

		it("should include top performers in analytics", () => {
			const testLoadout = { ...mockLoadout, id: "analytics-test" };
			loadoutManager.saveLoadout(testLoadout);

			const quest: Quest = { id: "q1", objective: "Test", status: "complete", createdAt: new Date() };
			const raid: Raid = { id: "r1", goal: "Test", status: "complete", startedAt: new Date(), planApproved: true };

			loadoutManager.recordQuestPerformance(testLoadout, quest, raid, {
				timeToComplete: 5000,
				totalTokens: 10000,
				costInCents: 5,
				qualityScore: 95,
				retryCount: 0,
				success: true,
			});

			const analytics = loadoutManager.getAnalytics();
			expect(analytics.topPerformer).toBeDefined();
			expect(analytics.speedLeader).toBeDefined();
			expect(analytics.costEfficiencyLeader).toBeDefined();
		});
	});

	describe("Import/Export", () => {
		it("should export loadout configuration", () => {
			loadoutManager.saveLoadout(mockLoadout);

			const exported = loadoutManager.exportLoadout(mockLoadout.id);
			expect(exported).toBeDefined();
			expect(typeof exported).toBe("string");

			const parsed = JSON.parse(exported!);
			expect(parsed.configuration.id).toBe(mockLoadout.id);
			expect(parsed.exportedAt).toBeDefined();
		});

		it("should return null for non-existent loadout export", () => {
			const exported = loadoutManager.exportLoadout("non-existent");
			expect(exported).toBeNull();
		});

		it("should import loadout configuration", () => {
			const exportData = {
				configuration: mockLoadout,
				score: null,
				recentPerformances: [],
				exportedAt: new Date(),
			};

			const imported = loadoutManager.importLoadout(JSON.stringify(exportData));
			expect(imported).toBeDefined();
			expect(imported?.name).toBe(mockLoadout.name);
			expect(imported?.id).not.toBe(mockLoadout.id); // Should get new ID
		});

		it("should handle invalid import data gracefully", () => {
			const imported = loadoutManager.importLoadout("invalid json");
			expect(imported).toBeNull();
		});
	});

	describe("Data Cleanup", () => {
		it("should cleanup old performance data", () => {
			// This is mainly testing that it doesn't crash
			expect(() => {
				loadoutManager.cleanupOldData(30);
			}).not.toThrow();
		});
	});
});
