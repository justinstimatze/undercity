/**
 * Grind Module
 *
 * Main entry point for the grind command.
 * Coordinates setup, validation, decomposition, and execution phases.
 */

import * as output from "../output.js";
import { processTasksForExecution } from "./decomposition.js";
import {
	checkUsageLimits,
	prepareASTIndex,
	primePatterns,
	runPreflightReconciliation,
	verifyBaseline,
} from "./preflight.js";
import {
	acquireGrindLock,
	checkDiskSpace,
	cleanupStaleWorkers,
	formatDuration,
	generateEmbeddings,
	parseDuration,
	parseGrindOptions,
	releaseGrindLock,
	runMigrationIfNeeded,
	setupSignalHandlers,
} from "./setup.js";
import type { GrindConfig, GrindOptions, GrindSessionState, TaskResultSummary } from "./types.js";
import { validateTasks } from "./validation.js";

// Re-export types
export type { GrindConfig, GrindOptions, GrindSessionState, TaskResultSummary };

/**
 * Main grind handler - orchestrates the entire grind workflow
 */
export async function handleGrind(options: GrindOptions): Promise<void> {
	// =========================================================================
	// Phase 1: Setup
	// =========================================================================

	// Acquire lock to prevent concurrent execution
	const lockResult = acquireGrindLock();
	if (!lockResult.acquired) {
		output.error(
			`Another grind process is already running (PID ${lockResult.existingPid}, started ${lockResult.startedAt})`,
		);
		output.info("Use 'pkill -f undercity' to kill existing processes, or wait for completion");
		process.exit(1);
	}

	// Set up cleanup on exit
	const cleanup = () => releaseGrindLock();
	setupSignalHandlers(cleanup);

	// Parse options
	const config = parseGrindOptions(options);

	// Clean up stale workers
	const staleCleanup = cleanupStaleWorkers();
	if (staleCleanup.cleaned > 0) {
		output.warning(`Cleaned up ${staleCleanup.cleaned} stale worker(s) from previous runs`);
	}

	// Run migration if needed
	const migration = await runMigrationIfNeeded();
	if (migration.migrated) {
		output.info(
			`Migrated to SQLite: ${migration.learnings} learnings, ${migration.errorPatterns} error patterns, ${migration.decisions} decisions`,
		);
	}

	// Generate embeddings
	const embeddedCount = await generateEmbeddings();
	if (embeddedCount > 0) {
		output.debug(`Generated embeddings for ${embeddedCount} learnings`);
	}

	// Check disk space
	const diskCheck = checkDiskSpace();
	if (!diskCheck.ok) {
		cleanup();
		output.error(`Insufficient disk space: ${diskCheck.availableGB}GB available, need at least 2GB`);
		process.exit(1);
	}

	// =========================================================================
	// Phase 2: Pre-flight Checks
	// =========================================================================

	output.header("Undercity Grind Mode", "Autonomous operation • Rate limit handling • Infinite processing");

	// Check usage limits
	const usageResult = await checkUsageLimits();
	if (usageResult.percent !== undefined) {
		if (usageResult.percent >= 95) {
			output.warning(`Claude Max usage at ${usageResult.percent.toFixed(0)}% - consider waiting for reset`);
		} else if (usageResult.percent >= 80) {
			output.info(`Claude Max usage: ${usageResult.percent.toFixed(0)}% of limit`);
		}
	}

	// Prime patterns from git history
	const patternsResult = await primePatterns();
	if (patternsResult.primed && patternsResult.patternsAdded) {
		output.info(`Primed ${patternsResult.patternsAdded} patterns from ${patternsResult.commitsProcessed} commits`);
	}

	// Build/load AST index
	const astResult = await prepareASTIndex();
	if (astResult.rebuilt) {
		output.info(`AST index built: ${astResult.fileCount} files, ${astResult.symbolCount} symbols`);
	}

	// =========================================================================
	// Phase 3: Task Loading & Recovery
	// =========================================================================

	const { Orchestrator } = await import("../orchestrator.js");
	const { startGrindProgress, updateGrindProgress, clearGrindProgress } = await import("../live-metrics.js");
	const { getAllTasks, markTaskComplete, markTaskFailed } = await import("../task.js");

	// Create orchestrator
	const orchestrator = new Orchestrator({
		maxConcurrent: config.parallelism,
		autoCommit: config.autoCommit,
		stream: config.stream,
		verbose: config.verbose,
		startingModel: config.startingModel,
		reviewPasses: config.reviewPasses,
		pushOnSuccess: config.pushOnSuccess,
		maxAttempts: config.maxAttempts,
		maxRetriesPerTier: config.maxRetriesPerTier,
		maxReviewPassesPerTier: config.maxReviewPassesPerTier,
		maxOpusReviewPasses: config.maxOpusReviewPasses,
		maxTier: config.maxTier,
	});

	// Set up auto-drain timer if duration specified
	let drainTimer: NodeJS.Timeout | null = null;
	if (config.duration) {
		const durationMs = parseDuration(config.duration);
		if (durationMs === null) {
			output.error(`Invalid duration format: ${config.duration}. Use format like "6h" or "30m"`);
			process.exit(1);
		}

		drainTimer = setTimeout(() => {
			output.progress(`Duration ${config.duration} elapsed - initiating drain`);
			orchestrator.drain(() => {
				output.success("Auto-drain complete");
			});
		}, durationMs);

		output.info(`Auto-drain scheduled in ${config.duration} (${formatDuration(durationMs)})`);
	}

	// Check for recovery
	let tasksProcessed = 0;
	if (!config.dryRun) {
		const hasRecovery = await orchestrator.hasActiveRecovery();
		if (hasRecovery) {
			const recoveryInfo = await orchestrator.getRecoveryInfo();
			output.warning("Interrupted batch detected", recoveryInfo as Record<string, unknown>);
			output.progress("Resuming interrupted batch...");

			const recoveryTasks = await orchestrator.resumeRecovery();
			if (recoveryTasks.length > 0) {
				const tasksToResume = config.maxCount > 0 ? recoveryTasks.slice(0, config.maxCount) : recoveryTasks;
				const result = await orchestrator.runParallel(tasksToResume);
				tasksProcessed += result.results.length;

				output.summary("Recovery Complete", [
					{ label: "Resumed", value: result.results.length },
					{ label: "Successful", value: result.successful, status: "good" },
					{ label: "Failed", value: result.failed, status: result.failed > 0 ? "bad" : "neutral" },
					{ label: "Merged", value: result.merged },
				]);

				if (config.maxCount > 0 && tasksProcessed >= config.maxCount) {
					return;
				}
			}
		}
	}

	// =========================================================================
	// Phase 4: Task Validation & Preparation
	// =========================================================================

	try {
		// Pre-flight reconciliation
		output.info("Running pre-flight validation...");
		const reconcileResult = await runPreflightReconciliation();
		if (reconcileResult.duplicatesFound > 0) {
			output.success(`Pre-flight: marked ${reconcileResult.duplicatesFound} task(s) as duplicate`);
		}

		// Verify baseline
		const baselineResult = await verifyBaseline();
		if (!baselineResult.passed) {
			output.error("Baseline check failed - fix issues before running grind:");
			output.error(baselineResult.feedback);
			process.exit(1);
		}
		output.success(baselineResult.cached ? "Baseline verified (cached)" : "Baseline verified");

		// Load tasks
		const allTasks = getAllTasks();
		let pendingTasks = allTasks
			.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		// Filter to specific task if requested
		if (config.taskId) {
			const targetTask = pendingTasks.find((t) => t.id === config.taskId);
			if (!targetTask) {
				const allMatch = allTasks.find((t) => t.id === config.taskId);
				if (allMatch) {
					output.error(`Task ${config.taskId} exists but is not pending (status: ${allMatch.status})`);
				} else {
					output.error(`Task not found: ${config.taskId}`);
				}
				return;
			}
			pendingTasks = [targetTask];
			output.info(`Running specific task: ${targetTask.objective.substring(0, 60)}...`);
		} else {
			const remainingCount = config.maxCount > 0 ? config.maxCount - tasksProcessed : 0;
			pendingTasks = config.maxCount > 0 ? pendingTasks.slice(0, remainingCount) : pendingTasks;
		}

		if (pendingTasks.length === 0) {
			if (allTasks.filter((t) => t.status === "pending").length === 0) {
				output.warning("Task board is empty - nothing to grind");
				output.info("Generate tasks with: undercity pm --propose");
			}
			return;
		}

		// Validate tasks
		const validation = await validateTasks(pendingTasks);
		if (validation.validTasks.length === 0) {
			output.info("No valid tasks to process after validation");
			return;
		}

		// =========================================================================
		// Phase 5: Decomposition & Model Assignment
		// =========================================================================

		const { tasksByModel, atomicityResults: _atomicityResults, decomposedCount } = await processTasksForExecution(
			validation.validTasks,
			config,
		);

		const totalTasks = tasksByModel.haiku.length + tasksByModel.sonnet.length + tasksByModel.opus.length;

		if (totalTasks === 0) {
			output.info("No tasks ready after decomposition");
			return;
		}

		// =========================================================================
		// Phase 6: Execution
		// =========================================================================

		const { startGrindSession, logTaskStarted, logTaskComplete, logTaskFailed, endGrindSession } = await import(
			"../grind-events.js"
		);

		const batchId = `grind-${Date.now()}`;
		startGrindSession({ batchId, taskCount: totalTasks + tasksProcessed, parallelism: config.parallelism });
		startGrindProgress(totalTasks + tasksProcessed, "fixed");

		// Build objective -> taskId map
		const objectiveToTaskId = new Map<string, string>();
		for (const tasks of [tasksByModel.haiku, tasksByModel.sonnet, tasksByModel.opus]) {
			for (const task of tasks) {
				objectiveToTaskId.set(task.objective, task.id);
			}
		}

		// Run tasks by model tier (cheapest first)
		const modelOrder: Array<"haiku" | "sonnet" | "opus"> = ["haiku", "sonnet", "opus"];
		let completedCount = tasksProcessed;
		let totalSuccessful = 0;
		let totalFailed = 0;
		let totalMerged = 0;
		let totalDecomposed = decomposedCount;
		let totalDurationMs = 0;
		const taskResults: TaskResultSummary[] = [];

		for (const modelTier of modelOrder) {
			const tierTasks = tasksByModel[modelTier];
			if (tierTasks.length === 0) continue;

			try {
				output.info(`Running ${tierTasks.length} task(s) with ${modelTier}...`);

				// Log task starts
				for (const task of tierTasks) {
					logTaskStarted({
						batchId,
						taskId: task.id,
						objective: task.objective,
						model: modelTier,
					});
				}

				// Create orchestrator for this tier
				const tierOrchestrator = new Orchestrator({
					maxConcurrent: config.parallelism,
					autoCommit: config.autoCommit,
					stream: config.stream,
					verbose: config.verbose,
					startingModel: modelTier,
					reviewPasses: config.reviewPasses,
					pushOnSuccess: config.pushOnSuccess,
					maxAttempts: config.maxAttempts,
					maxRetriesPerTier: config.maxRetriesPerTier,
					maxReviewPassesPerTier: config.maxReviewPassesPerTier,
					maxOpusReviewPasses: config.maxOpusReviewPasses,
					maxTier: config.maxTier,
				});

				const batchStartTime = Date.now();
				const result = await tierOrchestrator.runParallel(tierTasks);
				const batchDurationMs = Date.now() - batchStartTime;

				// Process results
				for (const taskResult of result.results) {
					const taskId = objectiveToTaskId.get(taskResult.task);
					if (!taskId) continue;

					if (taskResult.decomposed) {
						completedCount++;
						updateGrindProgress(completedCount, totalTasks + tasksProcessed);
						taskResults.push({ task: taskResult.task, taskId, status: "decomposed", modifiedFiles: [] });
						continue;
					}

					if (taskResult.merged) {
						markTaskComplete(taskId);
						output.taskComplete(taskId, `Task merged (${modelTier})`);
						completedCount++;
						updateGrindProgress(completedCount, totalTasks + tasksProcessed);

						logTaskComplete({
							batchId,
							taskId,
							model: taskResult.result?.model ?? modelTier,
							attempts: taskResult.result?.attempts ?? 1,
							fileCount: taskResult.modifiedFiles?.length ?? 0,
							tokens: taskResult.result?.tokenUsage?.total ?? 0,
							durationMs: batchDurationMs,
							commitSha: taskResult.result?.commitSha,
						});

						taskResults.push({
							task: taskResult.task,
							taskId,
							status: "merged",
							modifiedFiles: taskResult.modifiedFiles,
						});
					} else {
						const errorMsg = taskResult.mergeError || taskResult.result?.error || "Unknown error";
						markTaskFailed({ id: taskId, error: errorMsg });
						completedCount++;
						updateGrindProgress(completedCount, totalTasks + tasksProcessed);

						logTaskFailed({
							batchId,
							taskId,
							error: errorMsg,
							model: taskResult.result?.model ?? modelTier,
							attempts: taskResult.result?.attempts ?? 1,
							tokens: taskResult.result?.tokenUsage?.total ?? 0,
							durationMs: batchDurationMs,
						});

						taskResults.push({ task: taskResult.task, taskId, status: "failed", error: errorMsg });
					}
				}

				totalSuccessful += result.successful;
				totalFailed += result.failed;
				totalMerged += result.merged;
				totalDecomposed += result.decomposed;
				totalDurationMs += result.durationMs;
			} catch (tierError) {
				output.error(`Model tier ${modelTier} failed: ${tierError}`);
				totalFailed += tierTasks.length;
			}
		}

		// =========================================================================
		// Phase 7: Cleanup & Reporting
		// =========================================================================

		clearGrindProgress();

		if (drainTimer) {
			clearTimeout(drainTimer);
		}

		endGrindSession({
			batchId,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			durationMs: totalDurationMs,
		});

		// Summary
		const summaryItems = [
			{
				label: "Executed",
				value: totalSuccessful,
				status: totalSuccessful > 0 ? ("good" as const) : ("neutral" as const),
			},
			{ label: "Failed", value: totalFailed, status: totalFailed > 0 ? ("bad" as const) : ("neutral" as const) },
			{ label: "Merged", value: totalMerged },
		];
		if (totalDecomposed > 0) {
			summaryItems.push({ label: "Decomposed", value: totalDecomposed, status: "neutral" as const });
		}

		output.summary("Grind Session Complete", summaryItems);

		output.grindComplete({
			batchId,
			totalTasks: totalTasks + tasksProcessed,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			decomposed: totalDecomposed,
			durationMs: totalDurationMs,
			tasks: taskResults,
		});

		// Post-mortem if requested
		if (config.postmortem) {
			const { handlePostmortem } = await import("../commands/analysis-handlers.js");
			await handlePostmortem({});
		}
	} catch (error) {
		clearGrindProgress();
		output.error(`Grind error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
