/**
 * Quest Batch Orchestrator Module
 *
 * Manages multiple quests running in parallel by coordinating multiple RaidOrchestrators.
 * Handles conflict detection, resource allocation, and cross-quest coordination.
 */

import { FileTracker } from "./file-tracker.js";
import { raidLogger } from "./logger.js";
import type { Quest } from "./quest.js";
import {
	getReadyQuestsForBatch,
	markQuestComplete,
	markQuestFailed,
	markQuestSetInProgress,
	updateQuestAnalysis,
} from "./quest.js";
import { QuestAnalyzer } from "./quest-analyzer.js";
import { QuestScheduler, type QuestSet } from "./quest-scheduler.js";
import { RaidOrchestrator } from "./raid.js";
import type { CrossQuestConflict, QuestBatchResult, QuestSetMetadata } from "./types.js";

export interface QuestBatchOrchestratorOptions {
	maxParallelQuests?: number;
	stateDir?: string;
	autoApprove?: boolean;
	autoCommit?: boolean;
	verbose?: boolean;
	streamOutput?: boolean;
	riskThreshold?: number;
	packageBoundaryStrict?: boolean;
	conflictResolution?: "conservative" | "aggressive" | "balanced";
}

export class QuestBatchOrchestrator {
	private analyzer: QuestAnalyzer;
	private scheduler: QuestScheduler;
	private fileTracker: FileTracker;
	private activeRaids: Map<string, RaidOrchestrator>;
	private activeQuestSets: Map<string, QuestSetMetadata>;
	private maxParallelQuests: number;
	private options: Required<QuestBatchOrchestratorOptions>;

	constructor(options: QuestBatchOrchestratorOptions = {}) {
		this.options = {
			maxParallelQuests: options.maxParallelQuests ?? 3,
			stateDir: options.stateDir ?? ".undercity",
			autoApprove: options.autoApprove ?? false,
			autoCommit: options.autoCommit ?? false,
			verbose: options.verbose ?? false,
			streamOutput: options.streamOutput ?? false,
			riskThreshold: options.riskThreshold ?? 0.7,
			packageBoundaryStrict: options.packageBoundaryStrict ?? true,
			conflictResolution: options.conflictResolution ?? "balanced",
		};

		this.maxParallelQuests = this.options.maxParallelQuests;

		this.analyzer = new QuestAnalyzer();
		this.fileTracker = new FileTracker();
		this.scheduler = new QuestScheduler(this.analyzer, this.fileTracker, this.maxParallelQuests);

		this.activeRaids = new Map();
		this.activeQuestSets = new Map();

		this.log("QuestBatchOrchestrator initialized", {
			maxParallelQuests: this.maxParallelQuests,
			conflictResolution: this.options.conflictResolution,
		});
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.options.verbose) {
			raidLogger.info(data ?? {}, `[QuestBatch] ${message}`);
		}
	}

	/**
	 * Find and execute the optimal batch of parallel quests
	 */
	async processBatch(requestedQuestCount?: number): Promise<QuestBatchResult> {
		const maxQuests = requestedQuestCount ?? this.maxParallelQuests;
		this.log("Starting quest batch processing", { maxQuests });

		// Get available quests
		const availableQuests = getReadyQuestsForBatch(maxQuests * 2); // Get more to have options

		if (availableQuests.length === 0) {
			this.log("No quests available for processing");
			return {
				completedQuests: [],
				failedQuests: [],
				totalDuration: 0,
				conflicts: [],
			};
		}

		this.log(`Found ${availableQuests.length} available quests`);

		// Find optimal quest sets using the scheduler
		const questSets = await this.scheduler.findParallelizableSets(availableQuests);

		if (questSets.length === 0) {
			this.log("No compatible quest sets found, falling back to single quest");
			// Fall back to single quest execution
			return await this.processSingleQuest(availableQuests[0]);
		}

		// Select the best quest set
		const optimalSet = this.scheduler.selectOptimalQuestSet(questSets, maxQuests);

		if (optimalSet === null) {
			this.log("No optimal quest set selected");
			return await this.processSingleQuest(availableQuests[0]);
		}

		this.log(`Selected optimal quest set with ${optimalSet.quests.length} quests`, {
			questIds: optimalSet.quests.map((q) => q.id),
			parallelismScore: optimalSet.parallelismScore,
			riskLevel: optimalSet.riskLevel,
		});

		// Execute the quest set
		return await this.executeQuestSet(optimalSet);
	}

	/**
	 * Execute a single quest (fallback when no parallel opportunities exist)
	 */
	private async processSingleQuest(quest: Quest): Promise<QuestBatchResult> {
		this.log("Executing single quest", { questId: quest.id });

		const startTime = Date.now();

		try {
			const _raid = await this.createAndRunRaid(quest);
			const duration = Date.now() - startTime;

			return {
				completedQuests: [quest.id],
				failedQuests: [],
				totalDuration: duration,
				conflicts: [],
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			this.log("Single quest failed", { questId: quest.id, error: String(error) });

			markQuestFailed(quest.id, String(error));

			return {
				completedQuests: [],
				failedQuests: [quest.id],
				totalDuration: duration,
				conflicts: [],
			};
		}
	}

	/**
	 * Execute a set of quests in parallel
	 */
	private async executeQuestSet(questSet: QuestSet): Promise<QuestBatchResult> {
		const startTime = Date.now();
		const setId = this.generateSetId();

		this.log("Executing quest set", {
			setId,
			questCount: questSet.quests.length,
			questIds: questSet.quests.map((q) => q.id),
		});

		// Start parallel quest execution
		const raidPromises = new Map<string, Promise<void>>();
		const questResults = new Map<string, { success: boolean; error?: string }>();
		const raidIds: string[] = [];

		try {
			// Initialize file tracking for cross-quest conflict detection
			for (const quest of questSet.quests) {
				this.fileTracker.startQuestTracking(quest.id, setId);
			}

			// Start all raids in parallel
			for (const quest of questSet.quests) {
				const questPromise = this.executeQuestWithMonitoring(quest, setId, questResults);
				raidPromises.set(quest.id, questPromise);
			}

			// Mark quests as in progress
			const questIds = questSet.quests.map((q) => q.id);
			markQuestSetInProgress(questIds, raidIds);

			// Record active quest set
			const metadata: QuestSetMetadata = {
				questIds,
				raidIds,
				startedAt: new Date(),
				estimatedDuration: questSet.estimatedDuration,
				riskLevel: questSet.riskLevel,
			};
			this.activeQuestSets.set(setId, metadata);

			// Monitor for conflicts while quests run
			const conflictMonitor = this.startConflictMonitoring(setId);

			// Wait for all quests to complete
			await Promise.allSettled(Array.from(raidPromises.values()));

			// Stop conflict monitoring
			clearInterval(conflictMonitor);

			// Clean up file tracking
			for (const quest of questSet.quests) {
				this.fileTracker.stopQuestTracking(quest.id);
			}
		} catch (error) {
			this.log("Quest set execution failed", { setId, error: String(error) });

			// Mark all quests as failed
			for (const quest of questSet.quests) {
				if (!questResults.has(quest.id)) {
					questResults.set(quest.id, { success: false, error: String(error) });
					markQuestFailed(quest.id, String(error));
				}
			}
		} finally {
			// Clean up
			this.activeQuestSets.delete(setId);

			// Clean up any remaining raid orchestrators
			for (const quest of questSet.quests) {
				this.activeRaids.delete(quest.id);
			}
		}

		// Collect results
		const completedQuests: string[] = [];
		const failedQuests: string[] = [];

		for (const quest of questSet.quests) {
			const result = questResults.get(quest.id);
			if (result?.success) {
				completedQuests.push(quest.id);
			} else {
				failedQuests.push(quest.id);
			}
		}

		const totalDuration = Date.now() - startTime;
		const conflicts = this.fileTracker.detectCrossQuestConflicts();

		this.log("Quest set execution completed", {
			setId,
			completed: completedQuests.length,
			failed: failedQuests.length,
			conflicts: conflicts.length,
			duration: totalDuration,
		});

		return {
			completedQuests,
			failedQuests,
			totalDuration,
			conflicts,
		};
	}

	/**
	 * Execute a single quest with monitoring and error handling
	 */
	private async executeQuestWithMonitoring(
		quest: Quest,
		setId: string,
		results: Map<string, { success: boolean; error?: string }>,
	): Promise<void> {
		try {
			this.log(`Starting quest ${quest.id}`, { setId });

			const _raid = await this.createAndRunRaid(quest);

			results.set(quest.id, { success: true });
			markQuestComplete(quest.id);

			this.log(`Quest ${quest.id} completed successfully`, { setId });
		} catch (error) {
			const errorMessage = String(error);
			this.log(`Quest ${quest.id} failed`, { setId, error: errorMessage });

			results.set(quest.id, { success: false, error: errorMessage });
			markQuestFailed(quest.id, errorMessage);
		}
	}

	/**
	 * Create and run a raid for a quest
	 */
	private async createAndRunRaid(quest: Quest): Promise<any> {
		// Ensure quest has been analyzed
		const analysis = await this.analyzer.analyzeQuest(quest);
		updateQuestAnalysis(quest.id, {
			computedPackages: analysis.packages,
			riskScore: analysis.riskScore,
			estimatedFiles: analysis.estimatedFiles,
			tags: analysis.tags,
		});

		// Create raid orchestrator
		const raidOrchestrator = new RaidOrchestrator({
			stateDir: `${this.options.stateDir}/raids/${quest.id}`,
			maxParallel: 1, // Each quest uses single-threaded execution internally
			autoApprove: this.options.autoApprove,
			autoCommit: this.options.autoCommit,
			verbose: this.options.verbose,
			streamOutput: this.options.streamOutput,
		});

		this.activeRaids.set(quest.id, raidOrchestrator);

		// Start the raid
		const raid = await raidOrchestrator.start(quest.objective);

		// Wait for completion
		while (raid.status !== "complete" && raid.status !== "failed") {
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Get current status
			const status = raidOrchestrator.getStatus();
			if (status.raid) {
				raid.status = status.raid.status;
			}

			// Check for conflicts during execution
			const conflicts = this.fileTracker.detectCrossQuestConflicts();
			if (conflicts.length > 0 && this.options.conflictResolution === "conservative") {
				this.log(`Conflicts detected for quest ${quest.id}, aborting`, {
					conflicts: conflicts.length,
				});
				raidOrchestrator.surrender();
				throw new Error(`Quest aborted due to file conflicts: ${conflicts.map((c) => c.conflictingFiles).join(", ")}`);
			}
		}

		if (raid.status === "failed") {
			throw new Error("Raid execution failed");
		}

		return raid;
	}

	/**
	 * Start monitoring for cross-quest conflicts
	 */
	private startConflictMonitoring(setId: string): NodeJS.Timeout {
		return setInterval(() => {
			const conflicts = this.fileTracker.detectCrossQuestConflicts();

			if (conflicts.length > 0) {
				this.log(`Cross-quest conflicts detected`, {
					setId,
					conflicts: conflicts.length,
					files: conflicts.flatMap((c) => c.conflictingFiles),
				});

				// Handle conflicts based on resolution strategy
				this.handleConflicts(setId, conflicts);
			}
		}, 5000); // Check every 5 seconds
	}

	/**
	 * Handle detected conflicts based on resolution strategy
	 */
	private handleConflicts(setId: string, conflicts: CrossQuestConflict[]): void {
		const strategy = this.options.conflictResolution;

		for (const conflict of conflicts) {
			switch (strategy) {
				case "conservative":
					// Abort all conflicting quests except the first one
					for (let i = 1; i < conflict.questIds.length; i++) {
						const questId = conflict.questIds[i];
						const raid = this.activeRaids.get(questId);
						if (raid) {
							this.log(`Aborting quest ${questId} due to conflict (conservative)`, { setId });
							raid.surrender();
							markQuestFailed(questId, `Aborted due to file conflict: ${conflict.conflictingFiles.join(", ")}`);
						}
					}
					break;

				case "aggressive":
					// Log warning but continue execution
					this.log(`Allowing conflict to continue (aggressive strategy)`, {
						setId,
						questIds: conflict.questIds,
						files: conflict.conflictingFiles,
					});
					break;

				case "balanced":
					// Abort only if severity is critical
					if (conflict.severity === "critical") {
						// Abort the quest with higher risk score
						const questsWithRisk = conflict.questIds.map((id) => {
							// Find quest and get risk score
							const _metadata = this.activeQuestSets.get(setId);
							return { id, risk: 0.5 }; // Default risk if not found
						});

						questsWithRisk.sort((a, b) => b.risk - a.risk);
						const questToAbort = questsWithRisk[0].id;

						const raid = this.activeRaids.get(questToAbort);
						if (raid) {
							this.log(`Aborting highest-risk quest ${questToAbort} (balanced)`, { setId });
							raid.surrender();
							markQuestFailed(
								questToAbort,
								`Aborted due to critical file conflict: ${conflict.conflictingFiles.join(", ")}`,
							);
						}
					}
					break;
			}
		}
	}

	/**
	 * Get status of all active quest batches
	 */
	getStatus(): {
		activeQuestSets: number;
		activeQuests: number;
		totalConflicts: number;
		questSets: Array<{
			setId: string;
			questIds: string[];
			startedAt: Date;
			estimatedDuration: number;
			riskLevel: string;
		}>;
	} {
		const conflicts = this.fileTracker.detectCrossQuestConflicts();

		return {
			activeQuestSets: this.activeQuestSets.size,
			activeQuests: this.activeRaids.size,
			totalConflicts: conflicts.length,
			questSets: Array.from(this.activeQuestSets.entries()).map(([setId, metadata]) => ({
				setId,
				questIds: metadata.questIds,
				startedAt: metadata.startedAt,
				estimatedDuration: metadata.estimatedDuration,
				riskLevel: metadata.riskLevel,
			})),
		};
	}

	/**
	 * Perform a dry run analysis without executing quests
	 */
	async analyzeBatch(requestedQuestCount?: number): Promise<{
		availableQuests: Quest[];
		questSets: QuestSet[];
		optimalSet?: QuestSet;
		recommendedAction: string;
	}> {
		const maxQuests = requestedQuestCount ?? this.maxParallelQuests;

		const availableQuests = getReadyQuestsForBatch(maxQuests * 2);

		if (availableQuests.length === 0) {
			return {
				availableQuests: [],
				questSets: [],
				recommendedAction: "No quests available for processing",
			};
		}

		const questSets = await this.scheduler.findParallelizableSets(availableQuests);
		const optimalSet = questSets.length > 0 ? this.scheduler.selectOptimalQuestSet(questSets, maxQuests) : undefined;

		let recommendedAction = "";
		if (!optimalSet) {
			recommendedAction = "Execute single quest (no parallel opportunities found)";
		} else if (optimalSet.quests.length === 1) {
			recommendedAction = "Execute single quest (no compatible quests for parallelization)";
		} else {
			recommendedAction = `Execute ${optimalSet.quests.length} quests in parallel (parallelism score: ${optimalSet.parallelismScore.toFixed(2)})`;
		}

		return {
			availableQuests,
			questSets,
			optimalSet: optimalSet || undefined,
			recommendedAction,
		};
	}

	/**
	 * Generate a unique set ID for quest batch tracking
	 */
	private generateSetId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 6);
		return `questset-${timestamp}-${random}`;
	}

	/**
	 * Shutdown all active quest processing
	 */
	async shutdown(): Promise<void> {
		this.log("Shutting down quest batch orchestrator");

		// Surrender all active raids
		for (const [questId, raid] of this.activeRaids) {
			try {
				raid.surrender();
			} catch (error) {
				this.log(`Error surrendering raid for quest ${questId}`, { error: String(error) });
			}
		}

		// Clear tracking
		this.activeRaids.clear();
		this.activeQuestSets.clear();

		this.log("Quest batch orchestrator shutdown complete");
	}
}
