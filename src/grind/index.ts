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

	// Show lessons learned from previous grind
	const { getLessonsLearned } = await import("../commands/analysis-handlers.js");
	const lessons = getLessonsLearned();
	if (lessons) {
		output.info("=== Previous Grind Insights ===");
		const failureInfo =
			lessons.tasksFailed > 0
				? `${lessons.tasksCompleted} completed, ${lessons.tasksFailed} failed`
				: `${lessons.tasksCompleted} completed, no failures`;
		output.info(`Last run: ${failureInfo} (${lessons.successRate} success)`);
		if (lessons.topFailures.length > 0) {
			const failureSummary = lessons.topFailures.map((f) => `${f.reason}: ${f.count}`).join(", ");
			output.warning(`Top issues: ${failureSummary}`);
		}
		output.info(`Tip: ${lessons.topRecommendation}`);
		output.info("================================");
	}

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
		auditBash: config.auditBash,
		useSystemPromptPreset: config.useSystemPromptPreset,
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
	// Phase 4-6: Task Loading, Validation, Decomposition & Execution
	// In continuous mode, this loops: execute -> board empty -> propose -> execute
	// =========================================================================

	try {
		// Pre-flight reconciliation (once, before the loop)
		output.info("Running pre-flight validation...");
		const reconcileResult = await runPreflightReconciliation();
		if (reconcileResult.duplicatesFound > 0) {
			output.success(`Pre-flight: marked ${reconcileResult.duplicatesFound} task(s) as duplicate`);
		}

		// Verify baseline (once, before the loop)
		const baselineResult = await verifyBaseline();
		if (!baselineResult.passed) {
			output.error("Baseline check failed - fix issues before running grind:");
			output.error(baselineResult.feedback);
			process.exit(1);
		}
		output.success(baselineResult.cached ? "Baseline verified (cached)" : "Baseline verified");

		const { startGrindSession, logTaskStarted, logTaskComplete, logTaskFailed, endGrindSession, logContinuousPropose } =
			await import("../grind-events.js");

		const batchId = `grind-${Date.now()}`;
		let totalTasksInSession = tasksProcessed;
		let completedCount = tasksProcessed;
		let totalSuccessful = 0;
		let totalFailed = 0;
		let totalMerged = 0;
		let totalDecomposed = 0;
		let totalDurationMs = 0;
		const taskResults: TaskResultSummary[] = [];
		let sessionStarted = false;
		let continuousCycle = 0;

		// Main grind loop - runs once normally, loops in continuous mode
		while (true) {
			// Load tasks
			const allTasks = getAllTasks();
			let pendingTasks = allTasks
				.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
				.sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));

			// Filter to specific task if requested (only on first cycle)
			if (config.taskId && continuousCycle === 0) {
				const targetTask = pendingTasks.find((t) => t.id === config.taskId);
				if (!targetTask) {
					const allMatch = allTasks.find((t) => t.id === config.taskId);
					if (allMatch) {
						output.error(`Task ${config.taskId} exists but is not pending (status: ${allMatch.status})`);
					} else {
						output.error(`Task not found: ${config.taskId}`);
					}
					break;
				}
				pendingTasks = [targetTask];
				output.info(`Running specific task: ${targetTask.objective.substring(0, 60)}...`);
			} else {
				const remainingCount = config.maxCount > 0 ? config.maxCount - completedCount : 0;
				pendingTasks = config.maxCount > 0 ? pendingTasks.slice(0, remainingCount) : pendingTasks;
			}

			// Check --count limit
			if (config.maxCount > 0 && completedCount >= config.maxCount) {
				output.info("Task count limit reached");
				break;
			}

			// Board empty - handle continuous mode or exit
			if (pendingTasks.length === 0) {
				if (!config.continuous) {
					if (continuousCycle === 0) {
						output.warning("Task board is empty - nothing to grind");
						output.info("Generate tasks with: undercity pm --propose");
					}
					break;
				}

				// Check if orchestrator is draining (duration expired)
				if (orchestrator.isDraining()) {
					output.info("Duration expired - stopping continuous mode");
					break;
				}

				// Auto-propose new tasks
				continuousCycle++;
				output.progress(`Board empty - generating proposals (cycle ${continuousCycle})...`);

				const { pmPropose } = await import("../automated-pm.js");
				const { addProposalsToBoard } = await import("../commands/pm-helpers.js");

				const proposals = await pmPropose(config.continuousFocus);

				if (proposals.length === 0) {
					output.info("PM generated no proposals - stopping continuous mode");
					break;
				}

				const { added } = await addProposalsToBoard(proposals, false);
				output.success(`Added ${added} task(s) to board (cycle ${continuousCycle})`);

				logContinuousPropose({
					batchId,
					cycle: continuousCycle,
					proposalsGenerated: proposals.length,
					added,
					focus: config.continuousFocus,
				});

				if (added === 0) {
					output.info("No proposals accepted - stopping continuous mode");
					break;
				}

				// Loop back to load newly added tasks
				continue;
			}

			// Validate tasks
			const validation = await validateTasks(pendingTasks);
			if (validation.validTasks.length === 0) {
				if (!config.continuous) {
					output.info("No valid tasks to process after validation");
					break;
				}
				// In continuous mode, all current tasks may be invalid but new ones could be proposed
				continue;
			}

			// Decomposition & Model Assignment
			const {
				prioritizedTasks,
				atomicityResults: _atomicityResults,
				decomposedCount,
			} = await processTasksForExecution(validation.validTasks, config);

			if (prioritizedTasks.length === 0) {
				if (!config.continuous) {
					output.info("No tasks ready after decomposition");
					break;
				}
				continue;
			}

			totalDecomposed += decomposedCount;
			totalTasksInSession += prioritizedTasks.length;

			// Start grind session on first execution cycle
			if (!sessionStarted) {
				startGrindSession({ batchId, taskCount: totalTasksInSession, parallelism: config.parallelism });
				startGrindProgress(totalTasksInSession, "fixed");
				sessionStarted = true;
			} else {
				// Update progress total for new tasks
				updateGrindProgress(completedCount, totalTasksInSession);
			}

			// Build objective -> taskId map
			const objectiveToTaskId = new Map<string, string>();
			for (const task of prioritizedTasks) {
				objectiveToTaskId.set(task.objective, task.id);
			}

			// Execute tasks
			try {
				output.info(`Running ${prioritizedTasks.length} task(s) in priority order...`);

				// Log task starts
				for (const task of prioritizedTasks) {
					const model = task.recommendedModel || "sonnet";
					logTaskStarted({
						batchId,
						taskId: task.id,
						objective: task.objective,
						model,
					});
				}

				// Create execution orchestrator
				const execOrchestrator = new Orchestrator({
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
					auditBash: config.auditBash,
					useSystemPromptPreset: config.useSystemPromptPreset,
				});

				const batchStartTime = Date.now();
				const result = await execOrchestrator.runParallel(prioritizedTasks);
				const batchDurationMs = Date.now() - batchStartTime;

				// Process results
				for (const taskResult of result.results) {
					const taskId = objectiveToTaskId.get(taskResult.task);
					if (!taskId) continue;

					const task = prioritizedTasks.find((t) => t.objective === taskResult.task);
					const taskModel = task?.recommendedModel || "sonnet";

					if (taskResult.decomposed) {
						completedCount++;
						updateGrindProgress(completedCount, totalTasksInSession);
						taskResults.push({ task: taskResult.task, taskId, status: "decomposed", modifiedFiles: [] });
						continue;
					}

					if (taskResult.merged) {
						markTaskComplete(taskId);
						output.taskComplete(taskId, `Task merged (${taskModel})`);
						completedCount++;
						updateGrindProgress(completedCount, totalTasksInSession);

						logTaskComplete({
							batchId,
							taskId,
							model: taskResult.result?.model ?? taskModel,
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
						updateGrindProgress(completedCount, totalTasksInSession);

						logTaskFailed({
							batchId,
							taskId,
							error: errorMsg,
							model: taskResult.result?.model ?? taskModel,
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
			} catch (grindError) {
				output.error(`Grind execution failed: ${grindError}`);
				totalFailed += prioritizedTasks.length;
			}

			// In non-continuous mode, exit after one execution cycle
			if (!config.continuous) {
				break;
			}

			// In continuous mode with --task-id, exit after running the specific task
			if (config.taskId) {
				break;
			}

			// Loop back to check for more tasks (including newly decomposed subtasks)
		}

		// =========================================================================
		// Phase 7: Cleanup & Reporting
		// =========================================================================

		clearGrindProgress();

		if (drainTimer) {
			clearTimeout(drainTimer);
		}

		if (sessionStarted) {
			endGrindSession({
				batchId,
				successful: totalSuccessful,
				failed: totalFailed,
				merged: totalMerged,
				durationMs: totalDurationMs,
			});
		}

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
		if (continuousCycle > 0) {
			summaryItems.push({ label: "Propose Cycles", value: continuousCycle, status: "neutral" as const });
		}

		output.summary("Grind Session Complete", summaryItems);

		output.grindComplete({
			batchId,
			totalTasks: totalTasksInSession,
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
