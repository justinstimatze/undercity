/**
 * Command handlers for mixed commands
 * Extracted from mixed.ts to reduce complexity
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { recordAtomicityOutcome } from "../ax-programs.js";
import { getConfigSource, loadConfig } from "../config.js";
import { type OracleCard, UndercityOracle } from "../oracle.js";
import type { TaskResultSummary } from "../output.js";
import * as output from "../output.js";
import { Persistence } from "../persistence.js";
import { RateLimitTracker } from "../rate-limit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Type definitions for command options
export interface GrindOptions {
	count?: string;
	parallel?: string;
	stream?: boolean;
	verbose?: boolean;
	supervised?: boolean;
	model?: string;
	worker?: string;
	commit?: boolean;
	typecheck?: boolean;
	review?: boolean;
	decompose?: boolean;
	taskId?: string;
	dryRun?: boolean;
	push?: boolean;
	// Verification retry options
	maxAttempts?: string;
	maxRetriesPerTier?: string;
	maxReviewPasses?: string;
	maxOpusReviewPasses?: string;
}

export interface InitOptions {
	directory?: string;
	force?: boolean;
}

export interface OracleOptions {
	count?: string;
	category?: string;
	allCategories?: boolean;
}

export interface ConfigOptions {
	init?: boolean;
}

export interface ServeOptions {
	port?: string;
	grind?: boolean;
}

export interface StatusOptions {
	count?: string;
	human?: boolean;
	events?: boolean;
}

export interface TuningOptions {
	rebuild?: boolean;
	clear?: boolean;
}

/**
 * Handle the grind command
 *
 * All tasks run in isolated git worktrees for safety.
 * Use `undercity add "task"` to queue tasks, then `grind` to process them.
 */
export async function handleGrind(options: GrindOptions): Promise<void> {
	const { Orchestrator } = await import("../orchestrator.js");
	const { startGrindProgress, updateGrindProgress, clearGrindProgress } = await import("../live-metrics.js");

	const maxCount = Number.parseInt(options.count || "0", 10);
	const parallelism = Math.min(5, Math.max(1, Number.parseInt(options.parallel || "1", 10)));

	// Parse verification retry options (use undefined to let Orchestrator use defaults)
	const maxAttempts = options.maxAttempts ? Number.parseInt(options.maxAttempts, 10) : undefined;
	const maxRetriesPerTier = options.maxRetriesPerTier ? Number.parseInt(options.maxRetriesPerTier, 10) : undefined;
	const maxReviewPassesPerTier = options.maxReviewPasses ? Number.parseInt(options.maxReviewPasses, 10) : undefined;
	const maxOpusReviewPasses = options.maxOpusReviewPasses
		? Number.parseInt(options.maxOpusReviewPasses, 10)
		: undefined;

	const orchestrator = new Orchestrator({
		maxConcurrent: parallelism,
		autoCommit: options.commit !== false,
		stream: options.stream || false,
		verbose: options.verbose || false,
		startingModel: (options.model || "sonnet") as "haiku" | "sonnet" | "opus",
		reviewPasses: options.review === true,
		pushOnSuccess: options.push === true,
		maxAttempts,
		maxRetriesPerTier,
		maxReviewPassesPerTier,
		maxOpusReviewPasses,
	});

	// Process from task board (all tasks run in worktrees)
	output.header("Undercity Grind Mode", "Autonomous operation • Rate limit handling • Infinite processing");

	// Auto-prime patterns from git history if store is empty/small
	try {
		const { getTaskFileStats, primeFromGitHistory } = await import("../task-file-patterns.js");
		const stats = getTaskFileStats();
		if (stats.uniqueKeywords < 10) {
			output.progress("Auto-priming patterns from git history...");
			const primeResult = await primeFromGitHistory(100);
			if (primeResult.patternsAdded > 0) {
				output.info(`Primed ${primeResult.patternsAdded} patterns from ${primeResult.commitsProcessed} commits`);
			}
		}
	} catch {
		// Non-critical - continue without priming
	}

	// Track how many tasks we've processed (for -n flag)
	let tasksProcessed = 0;

	// Dry-run mode skips recovery (just shows what would run from current board)
	if (options.dryRun && orchestrator.hasActiveRecovery()) {
		output.info("Skipping recovery in dry-run mode (use without --dry-run to resume)");
	}

	// Check for interrupted batch and offer to resume
	if (!options.dryRun && orchestrator.hasActiveRecovery()) {
		const recoveryInfo = orchestrator.getRecoveryInfo();
		if (recoveryInfo) {
			output.warning("Interrupted batch detected", {
				batchId: recoveryInfo.batchId,
				startedAt: recoveryInfo.startedAt.toISOString(),
				tasksComplete: recoveryInfo.tasksComplete,
				tasksFailed: recoveryInfo.tasksFailed,
				tasksPending: recoveryInfo.tasksPending,
			});

			// Auto-resume the pending tasks
			output.progress("Resuming interrupted batch...");
			const recoveryTasks = await orchestrator.resumeRecovery();

			if (recoveryTasks.length > 0) {
				// Apply -n limit to recovery tasks if specified
				const tasksToResume = maxCount > 0 ? recoveryTasks.slice(0, maxCount) : recoveryTasks;

				const result = await orchestrator.runParallel(tasksToResume);
				tasksProcessed += result.results.length;

				output.summary("Recovery Complete", [
					{ label: "Resumed", value: result.results.length },
					{ label: "Successful", value: result.successful, status: "good" },
					{ label: "Failed", value: result.failed, status: result.failed > 0 ? "bad" : "neutral" },
					{ label: "Merged", value: result.merged },
				]);

				// If -n limit reached, stop here
				if (maxCount > 0 && tasksProcessed >= maxCount) {
					return;
				}
			} else {
				output.info("No pending tasks to resume");
			}
		}
	}

	try {
		// Get tasks from task board
		// Pre-flight validation: check for duplicate work BEFORE loading tasks
		const { reconcileTasks } = await import("../task.js");
		output.info("Running pre-flight validation...");
		const preflightResult = await reconcileTasks({ lookbackCommits: 50, dryRun: false });
		if (preflightResult.duplicatesFound > 0) {
			output.success(`Pre-flight: marked ${preflightResult.duplicatesFound} task(s) as duplicate`, {
				tasks: preflightResult.tasksMarked.map((t) => t.taskId),
			});
		}

		// Baseline check: verify main branch is green before starting tasks
		// This prevents agents from being blamed for pre-existing failures
		const { verifyBaseline } = await import("../verification.js");
		const baselineResult = await verifyBaseline();
		if (!baselineResult.passed) {
			output.error("Baseline check failed - fix issues before running grind:");
			output.error(baselineResult.feedback);
			process.exit(1);
		}
		if (baselineResult.cached) {
			output.info("Baseline verified (cached)");
		} else {
			output.success("Baseline verified");
		}

		const {
			getAllItems,
			markTaskComplete,
			markTaskFailed,
			decomposeTaskIntoSubtasks,
			completeParentIfAllSubtasksDone,
			getTaskById,
		} = await import("../task.js");
		const allTasks = getAllItems();
		// Include both "pending" and "in_progress" tasks
		// in_progress tasks may be stale from a previous crashed session
		// Also filter out decomposed tasks (their subtasks will be picked up instead)
		const pendingTasks = allTasks
			.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher priority first

		// If task-id specified, filter to just that task
		let tasksToProcess: typeof pendingTasks;
		if (options.taskId) {
			const targetTask = pendingTasks.find((t) => t.id === options.taskId);
			if (!targetTask) {
				// Check if task exists but isn't pending
				const allMatch = allTasks.find((t) => t.id === options.taskId);
				if (allMatch) {
					output.error(`Task ${options.taskId} exists but is not pending (status: ${allMatch.status})`);
				} else {
					output.error(`Task not found: ${options.taskId}`);
				}
				return;
			}
			tasksToProcess = [targetTask];
			output.info(`Running specific task: ${targetTask.objective.substring(0, 60)}...`);
		} else {
			// Account for tasks already processed during recovery
			const remainingCount = maxCount > 0 ? maxCount - tasksProcessed : 0;
			tasksToProcess = maxCount > 0 ? pendingTasks.slice(0, remainingCount) : pendingTasks;
		}

		// Skip if no tasks to process (either none pending or -n limit reached)
		if (tasksToProcess.length === 0) {
			if (pendingTasks.length === 0) {
				output.info("No pending or in-progress tasks on the task board");
			}
			// If tasksProcessed > 0, we already showed recovery summary
			return;
		}

		/// Lazy decomposition check: assess atomicity and decompose complex tasks
		// Also collects recommended model for each task
		type TaskWithModel = (typeof tasksToProcess)[0] & { recommendedModel?: "haiku" | "sonnet" | "opus" };
		let tasksWithModels: TaskWithModel[] = [];

		// Store atomicity check results for outcome recording (Ax training data)
		const atomicityResults = new Map<
			string,
			{
				isAtomic: boolean;
				confidence: number;
				estimatedFiles: number;
				recommendedModel: string;
				reasoning: string;
			}
		>();

		if (options.decompose !== false) {
			const { checkAndDecompose } = await import("../task-decomposer.js");

			output.progress("Checking task atomicity and complexity...");

			for (const task of tasksToProcess) {
				const result = await checkAndDecompose(task.objective);

				if (result.action === "decomposed" && result.subtasks && result.subtasks.length > 0) {
					// Task was decomposed - add subtasks to board
					output.info(`Decomposed "${task.objective.substring(0, 50)}..." into ${result.subtasks.length} subtasks`);

					decomposeTaskIntoSubtasks(
						task.id,
						result.subtasks.map((st) => ({
							objective: st.objective,
							estimatedFiles: st.estimatedFiles,
							order: st.order,
						})),
					);

					// Log subtask creation
					for (let i = 0; i < result.subtasks.length; i++) {
						output.debug(`  Subtask ${i + 1}: ${result.subtasks[i].objective.substring(0, 60)}`);
					}
				} else {
					// Task is atomic - include with recommended model
					const taskWithModel: TaskWithModel = {
						...task,
						recommendedModel: result.recommendedModel || "sonnet",
					};
					tasksWithModels.push(taskWithModel);
					output.debug(`Task "${task.objective.substring(0, 40)}..." → ${result.recommendedModel || "sonnet"}`);

					// Store atomicity result for outcome recording
					atomicityResults.set(task.objective, {
						isAtomic: true,
						confidence: 0.8, // checkAndDecompose doesn't expose confidence directly
						estimatedFiles: 1,
						recommendedModel: result.recommendedModel || "sonnet",
						reasoning: result.reasoning,
					});
				}
			}

			// If all tasks were decomposed, refetch to get subtasks
			if (tasksWithModels.length === 0) {
				output.info("All tasks were decomposed. Fetching subtasks...");
				const refreshedTasks = getAllItems();
				const newPendingTasks = refreshedTasks
					.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
					.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher priority first
				const newRemainingCount = maxCount > 0 ? maxCount - tasksProcessed : newPendingTasks.length;
				const newTasks = maxCount > 0 ? newPendingTasks.slice(0, newRemainingCount) : newPendingTasks;

				if (newTasks.length === 0) {
					output.info("No tasks ready after decomposition");
					return;
				}

				// Re-assess the new subtasks
				for (const task of newTasks) {
					const result = await checkAndDecompose(task.objective);
					tasksWithModels.push({
						...task,
						recommendedModel: result.recommendedModel || "sonnet",
					});

					// Store atomicity result for outcome recording
					atomicityResults.set(task.objective, {
						isAtomic: true,
						confidence: 0.8,
						estimatedFiles: 1,
						recommendedModel: result.recommendedModel || "sonnet",
						reasoning: result.reasoning,
					});
				}
			}
		} else {
			// No decomposition - use default model for all tasks
			tasksWithModels = tasksToProcess.map((t) => ({
				...t,
				recommendedModel: (options.model || "sonnet") as "haiku" | "sonnet" | "opus",
			}));
		}

		// Adjust models based on historical metrics (unless model explicitly set)
		if (!options.model) {
			const { adjustModelFromMetrics } = await import("../complexity.js");
			for (const task of tasksWithModels) {
				// Get complexity level from decomposer result if available, default to 'standard'
				const complexityLevel = (task as { complexity?: string }).complexity || "standard";
				const adjustedModel = await adjustModelFromMetrics(
					task.recommendedModel || "sonnet",
					complexityLevel as "trivial" | "simple" | "standard" | "complex" | "critical",
				);
				if (adjustedModel !== task.recommendedModel) {
					output.debug(
						`Metrics adjustment: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${adjustedModel}`,
					);
					task.recommendedModel = adjustedModel;
				}
			}

			// Check capability ledger for pattern-specific model recommendations
			// This can downgrade models when historical data shows simpler models work
			const { getRecommendedModel: getLedgerRecommendation } = await import("../capability-ledger.js");
			for (const task of tasksWithModels) {
				const ledgerRec = getLedgerRecommendation(task.objective);
				// Only apply ledger recommendation if high confidence and it suggests a CHEAPER model
				// (escalation handles upgrading, ledger helps identify when we can save tokens)
				const modelOrder = ["haiku", "sonnet", "opus"] as const;
				const currentIdx = modelOrder.indexOf(task.recommendedModel || "sonnet");
				const ledgerIdx = modelOrder.indexOf(ledgerRec.model);
				if (ledgerRec.confidence >= 0.7 && ledgerIdx < currentIdx) {
					output.debug(
						`Ledger adjustment: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${ledgerRec.model} (${ledgerRec.reason})`,
					);
					task.recommendedModel = ledgerRec.model;
				}
			}
		}

		// Group tasks by recommended model for efficient execution
		const tasksByModel = {
			haiku: tasksWithModels.filter((t) => t.recommendedModel === "haiku"),
			sonnet: tasksWithModels.filter((t) => t.recommendedModel === "sonnet"),
			opus: tasksWithModels.filter((t) => t.recommendedModel === "opus"),
		};

		// Log model distribution
		const modelCounts = Object.entries(tasksByModel)
			.filter(([, tasks]) => tasks.length > 0)
			.map(([model, tasks]) => `${model}: ${tasks.length}`)
			.join(", ");
		output.info(`Task model distribution: ${modelCounts}`);

		// Dry-run mode: show what would execute without running
		if (options.dryRun) {
			output.header("Dry Run", "Showing what would execute");

			output.summary("Tasks to Execute", [
				{ label: "Total tasks", value: tasksWithModels.length },
				{ label: "Haiku", value: tasksByModel.haiku.length },
				{ label: "Sonnet", value: tasksByModel.sonnet.length },
				{ label: "Opus", value: tasksByModel.opus.length },
				{ label: "Parallelism", value: parallelism },
			]);

			// List tasks by model tier
			for (const tier of ["haiku", "sonnet", "opus"] as const) {
				const tierTasks = tasksByModel[tier];
				if (tierTasks.length > 0) {
					console.log(`\n${tier.toUpperCase()} tier (${tierTasks.length} tasks):`);
					for (const task of tierTasks) {
						console.log(`  - ${task.objective.substring(0, 70)}${task.objective.length > 70 ? "..." : ""}`);
					}
				}
			}

			console.log("\nNo tasks were executed (dry-run mode)");
			return;
		}

		// Update tasksToProcess for the loop below
		tasksToProcess = tasksWithModels;

		// Build a map of objective -> task ID for status updates
		const objectiveToQuestId = new Map<string, string>();
		for (const q of tasksToProcess) {
			objectiveToQuestId.set(q.objective, q.id);
		}

		// Start grind progress tracking
		const totalToProcess = tasksWithModels.length + tasksProcessed;
		const mode = maxCount > 0 ? "fixed" : "board";
		startGrindProgress(totalToProcess, mode);
		updateGrindProgress(tasksProcessed, totalToProcess);

		// Start grind event logging
		const { startGrindSession, endGrindSession, logTaskQueued, logTaskStarted, logTaskComplete, logTaskFailed } =
			await import("../grind-events.js");
		const { getExperimentManager } = await import("../experiment.js");
		const experimentManager = getExperimentManager();
		const activeExperiment = experimentManager.getActiveExperiment();

		// Track variant assignments for experiment
		const taskVariantMap = new Map<string, string>();

		if (activeExperiment) {
			output.info(`Experiment active: "${activeExperiment.name}" (${activeExperiment.variants.length} variants)`);
		}

		const batchId = `grind-${Date.now().toString(36)}`;
		startGrindSession({
			batchId,
			taskCount: tasksWithModels.length,
			maxCount: maxCount > 0 ? maxCount : undefined,
			parallelism,
			modelDistribution: {
				haiku: tasksByModel.haiku.length,
				sonnet: tasksByModel.sonnet.length,
				opus: tasksByModel.opus.length,
			},
		});

		// Log all tasks as queued
		for (const task of tasksWithModels) {
			logTaskQueued({
				batchId,
				taskId: task.id,
				objective: task.objective,
				recommendedModel: task.recommendedModel || "sonnet",
			});
		}

		// If experiment is active, reassign models based on variant selection
		if (activeExperiment) {
			// Clear default model groupings
			tasksByModel.haiku = [];
			tasksByModel.sonnet = [];
			tasksByModel.opus = [];

			// Reassign each task based on experiment variant
			for (const task of tasksWithModels) {
				const variant = experimentManager.selectVariant();
				if (variant) {
					taskVariantMap.set(task.id, variant.id);
					// Override model based on variant
					task.recommendedModel = variant.model;
					tasksByModel[variant.model].push(task);
					output.debug(`Task ${task.id} assigned to variant "${variant.name}" (${variant.model})`);
				} else {
					// No variant selected, use original recommendation
					tasksByModel[task.recommendedModel || "sonnet"].push(task);
				}
			}

			// Log updated model distribution
			const experimentModelCounts = Object.entries(tasksByModel)
				.filter(([, tasks]) => tasks.length > 0)
				.map(([model, tasks]) => `${model}: ${tasks.length}`)
				.join(", ");
			output.info(`Experiment model distribution: ${experimentModelCounts}`);
		}

		// Run tasks grouped by model tier (haiku first = cheapest, then sonnet, then opus)
		const modelOrder: Array<"haiku" | "sonnet" | "opus"> = ["haiku", "sonnet", "opus"];
		let completedCount = tasksProcessed;
		let totalSuccessful = 0;
		let totalFailed = 0;
		let totalMerged = 0;
		let totalDurationMs = 0;

		// Track task results for structured output
		const taskResults: TaskResultSummary[] = [];

		for (const modelTier of modelOrder) {
			const tierTasks = tasksByModel[modelTier];
			if (tierTasks.length === 0) continue;

			// Error boundary around each tier - one tier failing shouldn't stop others
			try {
				output.info(`Running ${tierTasks.length} task(s) with ${modelTier}...`);

				// Analyze task compatibility to detect conflicts before parallel execution
				// This uses regex-based analysis (no LLM cost) to predict file conflicts
				const { TaskBoardAnalyzer } = await import("../task-board-analyzer.js");
				const boardAnalyzer = new TaskBoardAnalyzer();
				const compatMatrix = await boardAnalyzer.generateCompatibilityMatrix(tierTasks);

				// Group tasks into compatible batches to avoid parallel conflicts
				const taskBatches: Array<typeof tierTasks> = [];
				const assignedTasks = new Set<string>();

				// Build batches by greedily adding compatible tasks
				for (const task of tierTasks) {
					if (assignedTasks.has(task.id)) continue;

					// Start a new batch with this task
					const batch: typeof tierTasks = [task];
					assignedTasks.add(task.id);

					// Try to add other tasks that are compatible with all batch members
					for (const candidate of tierTasks) {
						if (assignedTasks.has(candidate.id)) continue;

						// Check if candidate is compatible with all tasks in current batch
						const taskIdx = compatMatrix.tasks.findIndex((t) => t.id === candidate.id);
						let compatible = true;

						for (const batchMember of batch) {
							const memberIdx = compatMatrix.tasks.findIndex((t) => t.id === batchMember.id);
							if (taskIdx >= 0 && memberIdx >= 0) {
								const result = compatMatrix.matrix[taskIdx][memberIdx];
								if (!result.compatible) {
									compatible = false;
									break;
								}
							}
						}

						if (compatible) {
							batch.push(candidate);
							assignedTasks.add(candidate.id);
						}
					}

					taskBatches.push(batch);
				}

				// Log if we split into multiple batches due to conflicts
				if (taskBatches.length > 1) {
					output.info(
						`Split ${tierTasks.length} tasks into ${taskBatches.length} sequential batches to avoid conflicts`,
					);
					for (let i = 0; i < taskBatches.length; i++) {
						output.debug(`  Batch ${i + 1}: ${taskBatches[i].length} task(s)`);
					}
				}

				// Log task starts (but don't mark in_progress yet - orchestrator will do that
				// after similarity check passes to avoid false positive duplicate detection)
				for (const task of tierTasks) {
					logTaskStarted({
						batchId,
						taskId: task.id,
						objective: task.objective,
						model: modelTier,
					});
				}

				// Check if experiment wants review enabled for this tier
				const experimentReviewEnabled =
					activeExperiment &&
					tierTasks.some((t) => {
						const variantId = taskVariantMap.get(t.id);
						const variant = activeExperiment.variants.find((v) => v.id === variantId);
						return variant?.reviewEnabled;
					});

				// Execute each batch sequentially (compatible tasks within batch run in parallel)
				for (let batchIdx = 0; batchIdx < taskBatches.length; batchIdx++) {
					const batchTasks = taskBatches[batchIdx];

					if (taskBatches.length > 1) {
						output.info(`Running batch ${batchIdx + 1}/${taskBatches.length} (${batchTasks.length} task(s))...`);
					}

					// Create orchestrator for this batch
					const batchOrchestrator = new Orchestrator({
						maxConcurrent: parallelism,
						autoCommit: options.commit !== false,
						stream: options.stream || false,
						verbose: options.verbose || false,
						startingModel: modelTier,
						reviewPasses: options.review === true || experimentReviewEnabled === true,
						pushOnSuccess: options.push === true,
						maxAttempts,
						maxRetriesPerTier,
						maxReviewPassesPerTier,
						maxOpusReviewPasses,
					});

					const batchObjectives = batchTasks.map((t) => t.objective);
					const batchStartTime = Date.now();
					const result = await batchOrchestrator.runParallel(batchObjectives);
					const batchDurationMs = Date.now() - batchStartTime;

					// Update task status based on results
					for (const taskResult of result.results) {
						const taskId = objectiveToQuestId.get(taskResult.task);
						if (taskId) {
							if (taskResult.merged) {
								markTaskComplete(taskId);
								output.taskComplete(taskId, `Task merged (${modelTier})`);
								completedCount++;
								updateGrindProgress(completedCount, totalToProcess);

								// Log completion event
								logTaskComplete({
									batchId,
									taskId,
									objective: taskResult.task,
									durationMs: batchDurationMs,
									commitSha: taskResult.result?.commitSha,
								});

								// Record experiment result if variant was assigned
								const variantId = taskVariantMap.get(taskId);
								if (variantId && activeExperiment) {
									experimentManager.recordResult({
										taskId,
										variantId,
										success: true,
										durationMs: taskResult.result?.durationMs ?? batchDurationMs,
										tokensUsed: taskResult.result?.tokenUsage?.total ?? 0,
										attempts: taskResult.result?.attempts ?? 1,
									});
								}

								// Track result for structured output
								taskResults.push({
									task: taskResult.task,
									taskId,
									status: "merged",
									modifiedFiles: taskResult.modifiedFiles,
								});

								// Check if this was a subtask and auto-complete parent if all siblings done
								const task = getTaskById(taskId);
								if (task?.parentId) {
									const parentCompleted = completeParentIfAllSubtasksDone(task.parentId);
									if (parentCompleted) {
										output.info(`Parent task ${task.parentId} auto-completed (all subtasks done)`);
									}
								}

								// Record atomicity outcome for Ax training data
								const atomicityResult = atomicityResults.get(taskResult.task);
								if (atomicityResult) {
									recordAtomicityOutcome(taskResult.task, atomicityResult, true);
								}
							} else if (taskResult.mergeError || taskResult.result?.status === "failed") {
								const errorMsg = taskResult.mergeError || "Task failed";
								markTaskFailed(taskId, errorMsg);
								output.taskFailed(taskId, `Task failed (${modelTier})`, errorMsg);
								completedCount++;
								updateGrindProgress(completedCount, totalToProcess);

								// Log failure event
								logTaskFailed({
									batchId,
									taskId,
									objective: taskResult.task,
									error: errorMsg,
									durationMs: batchDurationMs,
								});

								// Record experiment result if variant was assigned
								const variantId = taskVariantMap.get(taskId);
								if (variantId && activeExperiment) {
									experimentManager.recordResult({
										taskId,
										variantId,
										success: false,
										durationMs: taskResult.result?.durationMs ?? batchDurationMs,
										tokensUsed: taskResult.result?.tokenUsage?.total ?? 0,
										attempts: taskResult.result?.attempts ?? 1,
										errorCategories: [errorMsg.substring(0, 50)],
									});
								}

								// Track result for structured output
								taskResults.push({
									task: taskResult.task,
									taskId,
									status: "failed",
									error: errorMsg,
								});

								// Record atomicity outcome for Ax training data (failure)
								const atomicityResult = atomicityResults.get(taskResult.task);
								if (atomicityResult) {
									recordAtomicityOutcome(taskResult.task, atomicityResult, false);
								}
							}
						}
					}

					totalSuccessful += result.successful;
					totalFailed += result.failed;
					totalMerged += result.merged;
					totalDurationMs += result.durationMs;
				}
			} catch (tierError) {
				// Tier-level error - log and continue to next tier
				output.error(`Model tier ${modelTier} failed: ${tierError}`);

				// Mark all tasks in this tier as failed
				for (const task of tierTasks) {
					const taskId = objectiveToQuestId.get(task.objective);
					if (taskId) {
						markTaskFailed(taskId, `Tier error: ${tierError}`);
						completedCount++;
						updateGrindProgress(completedCount, totalToProcess);

						logTaskFailed({
							batchId,
							taskId,
							objective: task.objective,
							error: `Tier error: ${tierError}`,
							durationMs: 0,
						});

						// Record experiment result if variant was assigned
						const variantId = taskVariantMap.get(taskId);
						if (variantId && activeExperiment) {
							experimentManager.recordResult({
								taskId,
								variantId,
								success: false,
								durationMs: 0,
								tokensUsed: 0,
								attempts: 1,
								errorCategories: [`Tier error: ${String(tierError).substring(0, 50)}`],
							});
						}

						// Track result for structured output
						taskResults.push({
							task: task.objective,
							taskId,
							status: "failed",
							error: `Tier error: ${tierError}`,
						});
					}
				}
				totalFailed += tierTasks.length;
			}
		}

		clearGrindProgress();

		// End grind session logging
		endGrindSession({
			batchId,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			durationMs: totalDurationMs,
		});

		output.summary("Grind Session Complete", [
			{ label: "Total processed", value: tasksWithModels.length + tasksProcessed },
			{ label: "Successful", value: totalSuccessful, status: totalSuccessful > 0 ? "good" : "neutral" },
			{ label: "Failed", value: totalFailed, status: totalFailed > 0 ? "bad" : "neutral" },
			{ label: "Merged", value: totalMerged },
			{ label: "Model distribution", value: modelCounts },
			{ label: "Duration", value: `${Math.round(totalDurationMs / 60000)} minutes` },
		]);

		// Output structured results for calling session to parse
		output.grindComplete({
			batchId,
			totalTasks: tasksWithModels.length + tasksProcessed,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			durationMs: totalDurationMs,
			tasks: taskResults,
		});

		// Show experiment metrics if active
		if (activeExperiment && taskVariantMap.size > 0) {
			const variantMetrics = experimentManager.getVariantMetrics();
			output.info(`Experiment "${activeExperiment.name}" results:`);
			for (const metrics of variantMetrics) {
				const variant = activeExperiment.variants.find((v) => v.id === metrics.variantId);
				if (variant && metrics.totalTasks > 0) {
					output.metrics(`  ${variant.name}`, {
						tasks: metrics.totalTasks,
						successRate: `${(metrics.successRate * 100).toFixed(0)}%`,
						avgDuration: `${Math.round(metrics.avgDurationMs / 1000)}s`,
						avgTokens: Math.round(metrics.avgTokensPerTask),
					});
				}
			}
		}
	} catch (error) {
		clearGrindProgress();
		output.error(`Grind error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}

/**
 * Handle the limits command
 */
export async function handleLimits(): Promise<void> {
	const { loadLiveMetrics } = await import("../live-metrics.js");

	const metricsData = loadLiveMetrics();
	const persistence = new Persistence();
	const savedState = persistence.getRateLimitState();
	const tracker = new RateLimitTracker(savedState ?? undefined);

	// Calculate totals from byModel (more reliable than top-level tokens)
	const models = metricsData.byModel;
	const totalInput = models.opus.input + models.sonnet.input + models.haiku.input;
	const totalOutput = models.opus.output + models.sonnet.output + models.haiku.output;
	const totalTokens = totalInput + totalOutput;

	// Check if there's any data
	if (totalTokens === 0 && metricsData.queries.total === 0) {
		output.info("No usage data yet. Run 'undercity grind' to start processing tasks.");
		return;
	}

	// When was this data from?
	const ageMs = Date.now() - metricsData.updatedAt;
	const ageMinutes = Math.floor(ageMs / 60000);

	output.header("Undercity Usage", ageMinutes > 5 ? `Last updated ${ageMinutes}m ago` : undefined);

	// Check rate limit pause status
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		output.warning("Rate limit pause active", {
			reason: pauseState.reason || "Rate limit hit",
			remaining: tracker.formatRemainingTime(),
			resumeAt: pauseState.resumeAt?.toISOString() || "unknown",
		});
	}

	// Metrics output
	output.metrics("Usage summary", {
		queries: {
			successful: metricsData.queries.successful,
			total: metricsData.queries.total,
			rateLimited: metricsData.queries.rateLimited,
		},
		tokens: {
			input: totalInput,
			output: totalOutput,
			total: totalTokens,
		},
		byModel: {
			opus: { tokens: models.opus.input + models.opus.output, cost: models.opus.cost },
			sonnet: { tokens: models.sonnet.input + models.sonnet.output, cost: models.sonnet.cost },
			haiku: { tokens: models.haiku.input + models.haiku.output, cost: models.haiku.cost },
		},
		totalCost: metricsData.cost.total,
	});

	output.info("For live monitoring, run: undercity watch");
}

/**
 * Detect project tooling from package.json and config files
 */
function detectProjectTooling(): {
	packageManager: "npm" | "yarn" | "pnpm" | "bun";
	hasTypescript: boolean;
	testRunner: "vitest" | "jest" | "mocha" | "none";
	linter: "biome" | "eslint" | "none";
	buildTool: "tsc" | "vite" | "webpack" | "esbuild" | "none";
} {
	const result = {
		packageManager: "npm" as "npm" | "yarn" | "pnpm" | "bun",
		hasTypescript: false,
		testRunner: "none" as "vitest" | "jest" | "mocha" | "none",
		linter: "none" as "biome" | "eslint" | "none",
		buildTool: "none" as "tsc" | "vite" | "webpack" | "esbuild" | "none",
	};

	// Detect package manager from lock files
	if (existsSync("pnpm-lock.yaml")) {
		result.packageManager = "pnpm";
	} else if (existsSync("yarn.lock")) {
		result.packageManager = "yarn";
	} else if (existsSync("bun.lockb")) {
		result.packageManager = "bun";
	}

	// Read package.json if it exists
	if (existsSync("package.json")) {
		try {
			const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };

			// TypeScript
			result.hasTypescript = "typescript" in deps || existsSync("tsconfig.json");

			// Test runner
			if ("vitest" in deps) {
				result.testRunner = "vitest";
			} else if ("jest" in deps) {
				result.testRunner = "jest";
			} else if ("mocha" in deps) {
				result.testRunner = "mocha";
			}

			// Linter
			if ("@biomejs/biome" in deps || existsSync("biome.json")) {
				result.linter = "biome";
			} else if ("eslint" in deps || existsSync(".eslintrc.js") || existsSync(".eslintrc.json")) {
				result.linter = "eslint";
			}

			// Build tool
			if ("vite" in deps) {
				result.buildTool = "vite";
			} else if ("webpack" in deps) {
				result.buildTool = "webpack";
			} else if ("esbuild" in deps) {
				result.buildTool = "esbuild";
			} else if (result.hasTypescript) {
				result.buildTool = "tsc";
			}
		} catch {
			// Ignore parsing errors
		}
	}

	return result;
}

/**
 * Generate verification commands based on detected tooling
 */
function generateCommands(
	pm: "npm" | "yarn" | "pnpm" | "bun",
	tooling: ReturnType<typeof detectProjectTooling>,
): { typecheck: string; test: string; lint: string; build: string } {
	const run = pm === "npm" ? "npm run" : pm;

	const typecheck = tooling.hasTypescript ? `${run} typecheck` : "echo 'No TypeScript'";

	let test = "echo 'No tests configured'";
	if (tooling.testRunner !== "none") {
		test = `${run} test`;
	}

	let lint = "echo 'No linter configured'";
	if (tooling.linter === "biome") {
		lint = `${run} check`;
	} else if (tooling.linter === "eslint") {
		lint = `${run} lint`;
	}

	let build = "echo 'No build configured'";
	if (tooling.buildTool !== "none") {
		build = `${run} build`;
	}

	return { typecheck, test, lint, build };
}

/**
 * Handle the init command
 */
export function handleInit(options: InitOptions): void {
	console.log(chalk.bold("Initializing Undercity"));

	// Initialize .undercity directory
	const persistence = new Persistence(options.directory);
	const undercityDir = options.directory || ".undercity";
	persistence.initializeUndercity(options.directory);
	console.log(chalk.green(`  Created ${undercityDir}/`));

	// Detect project tooling
	console.log(chalk.dim("  Detecting project tooling..."));
	const detected = detectProjectTooling();
	const commands = generateCommands(detected.packageManager, detected);

	// Create and save project profile
	const profile = {
		packageManager: detected.packageManager,
		commands,
		detected: {
			hasTypescript: detected.hasTypescript,
			testRunner: detected.testRunner,
			linter: detected.linter,
			buildTool: detected.buildTool,
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	if (persistence.hasProfile() && !options.force) {
		console.log(chalk.yellow("  Profile already exists (use --force to overwrite)"));
	} else {
		persistence.saveProfile(profile);
		console.log(chalk.green("  Created project profile"));
	}

	// Show detected tooling
	console.log(chalk.dim(`    Package manager: ${detected.packageManager}`));
	console.log(chalk.dim(`    TypeScript: ${detected.hasTypescript ? "yes" : "no"}`));
	console.log(chalk.dim(`    Test runner: ${detected.testRunner}`));
	console.log(chalk.dim(`    Linter: ${detected.linter}`));
	console.log(chalk.dim(`    Build tool: ${detected.buildTool}`));

	// Find the templates directory (relative to compiled output)
	const templatesDir = join(__dirname, "..", "..", "templates");
	const skillTemplatePath = join(templatesDir, "undercity-skill.md");

	// Install skill file if template exists
	if (existsSync(skillTemplatePath)) {
		// Create .claude/skills directory
		const skillsDir = ".claude/skills";
		if (!existsSync(skillsDir)) {
			mkdirSync(skillsDir, { recursive: true });
			console.log(chalk.green(`  Created ${skillsDir}/`));
		}

		// Copy skill file
		const skillPath = join(skillsDir, "undercity.md");
		if (existsSync(skillPath) && !options.force) {
			console.log(chalk.yellow(`  ${skillPath} already exists (use --force to overwrite)`));
		} else {
			copyFileSync(skillTemplatePath, skillPath);
			console.log(chalk.green(`  Installed ${skillPath}`));
		}
	} else {
		console.log(chalk.dim("  Skill template not found, skipping skill installation"));
	}

	// Add .undercity to .gitignore if not already present
	const gitignorePath = ".gitignore";
	if (existsSync(gitignorePath)) {
		const gitignore = readFileSync(gitignorePath, "utf-8");
		if (!gitignore.includes(".undercity")) {
			appendFileSync(gitignorePath, "\n# Undercity runtime state\n.undercity/\n");
			console.log(chalk.green("  Added .undercity/ to .gitignore"));
		}
	}

	// Check efficiency tools for fast-path optimization
	console.log(chalk.dim("  Checking efficiency tools..."));
	// Dynamic import for ESM compatibility
	import("../efficiency-tools.js")
		.then(({ getToolAvailability, getAvailableTools }) => {
			const availability = getToolAvailability();
			const available = getAvailableTools();
			const missing: string[] = [];

			// Check key tools and suggest installation
			const toolInstallHints: Record<string, string> = {
				"ast-grep": "cargo install ast-grep (or brew install ast-grep)",
				jq: "apt install jq (or brew install jq)",
				comby: "bash <(curl -sL get.comby.dev)",
				sd: "cargo install sd",
			};

			for (const [tool, hint] of Object.entries(toolInstallHints)) {
				if (!availability.get(tool)) {
					missing.push(`${tool}: ${hint}`);
				}
			}

			if (available.length > 0) {
				console.log(
					chalk.green(
						`  ${available.length} efficiency tools available: ${available.map((t: { name: string }) => t.name).join(", ")}`,
					),
				);
			}

			if (missing.length > 0) {
				console.log(chalk.yellow("  Optional tools for faster task execution:"));
				for (const m of missing) {
					console.log(chalk.dim(`    ${m}`));
				}
			}

			console.log();
			console.log(chalk.green.bold("Undercity initialized!"));
			console.log(chalk.dim("Run 'undercity tasks' to view the task board"));
			console.log(chalk.dim("Run 'undercity add <task>' to add tasks"));
			console.log(chalk.dim("Run 'undercity grind' to process tasks"));
		})
		.catch(() => {
			// If tools check fails, just continue without it
			console.log();
			console.log(chalk.green.bold("Undercity initialized!"));
			console.log(chalk.dim("Run 'undercity tasks' to view the task board"));
			console.log(chalk.dim("Run 'undercity add <task>' to add tasks"));
			console.log(chalk.dim("Run 'undercity grind' to process tasks"));
		});
}

/**
 * Handle the setup command
 */
export function handleSetup(): void {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (apiKey) {
		console.log(chalk.green("✓ ANTHROPIC_API_KEY is set"));
	} else {
		console.log(chalk.red("✗ ANTHROPIC_API_KEY not found"));
		console.log("Set it with: export ANTHROPIC_API_KEY=your_api_key");
	}

	const config = loadConfig();
	if (config) {
		console.log(chalk.green("✓ Configuration loaded"));
		const configSource = getConfigSource();
		if (configSource) {
			console.log(chalk.dim(`  Source: ${configSource}`));
		}
	} else {
		console.log(chalk.gray("○ No configuration file found (using defaults)"));
		console.log(chalk.dim("  Create .undercityrc to customize settings"));
	}
}

/**
 * Handle the oracle command
 */
export function handleOracle(situation: string | undefined, options: OracleOptions): void {
	const oracle = new UndercityOracle();

	if (options.allCategories) {
		console.log(chalk.bold("Oracle Categories"));
		console.log("Available categories for filtering:");
		console.log("  • questioning   - Cards that ask probing questions");
		console.log("  • action        - Cards that suggest specific actions");
		console.log("  • perspective   - Cards that shift viewpoint");
		console.log("  • disruption    - Cards that challenge assumptions");
		console.log("  • exploration   - Cards that encourage investigation");
		return;
	}

	const count = Math.min(5, Math.max(1, Number.parseInt(options.count || "1", 10)));

	if (situation) {
		console.log(chalk.bold(`Oracle Consultation: ${situation}`));
	} else {
		console.log(chalk.bold("Oracle Draw"));
	}
	console.log();

	try {
		const cards = oracle.drawSpread(count, options.category as OracleCard["category"]);

		for (let i = 0; i < cards.length; i++) {
			const card = cards[i];
			console.log(chalk.cyan(`Card ${i + 1}:`));
			console.log(`  ${card.text}`);
			console.log(chalk.dim(`  Category: ${card.category}`));
			if (i < cards.length - 1) console.log();
		}

		if (situation) {
			console.log();
			console.log(chalk.dim("Reflect on how these insights apply to your situation."));
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
	}
}

/**
 * Handle the dspy-readiness command
 */
export function handleDspyReadiness(): void {
	console.log(chalk.bold("DSPy Integration Readiness Assessment"));
	console.log();
	console.log(chalk.yellow("⚠️ This feature requires enhanced metrics collection"));
	console.log(chalk.dim("Future implementation will analyze:"));
	console.log(chalk.dim("  • Prompt consistency across tasks"));
	console.log(chalk.dim("  • Model switching patterns"));
	console.log(chalk.dim("  • Output quality variance"));
	console.log(chalk.dim("  • Optimization opportunities"));
}

/**
 * Handle the config command
 */
export async function handleConfig(options: ConfigOptions): Promise<void> {
	if (options.init) {
		const sampleConfig = {
			stream: true,
			verbose: false,
			model: "sonnet",
			worker: "sonnet",
			autoCommit: false,
			typecheck: true,
			parallel: 3,
			maxRetries: 3,
		};

		const fs = await import("node:fs/promises");
		try {
			await fs.writeFile(".undercityrc", JSON.stringify(sampleConfig, null, 2));
			console.log(chalk.green("✓ Created .undercityrc with default settings"));
			console.log(chalk.dim("  Edit this file to customize your preferences"));
		} catch (error) {
			console.error(chalk.red("Failed to create .undercityrc:"), error);
		}
		return;
	}

	const config = loadConfig();
	const configSource = getConfigSource();

	console.log(chalk.bold("Current Configuration"));

	if (configSource) {
		console.log(chalk.green(`✓ Loaded from: ${configSource}`));
	} else {
		console.log(chalk.gray("○ Using built-in defaults"));
	}

	console.log();
	console.log("Settings:");
	if (config) {
		for (const [key, value] of Object.entries(config)) {
			console.log(`  ${key}: ${value}`);
		}
	} else {
		console.log(chalk.dim("  No custom configuration"));
	}

	console.log();
	console.log(chalk.dim("Create .undercityrc to override defaults"));
	console.log(chalk.dim("Use --init to create a sample configuration file"));
}

/**
 * Handle the watch command
 */
export async function handleWatch(): Promise<void> {
	try {
		const { launchDashboard } = await import("../dashboard.js");
		launchDashboard();
	} catch (error) {
		console.error(chalk.red("Dashboard failed to start:"), error);
		console.error(chalk.dim("Make sure blessed and blessed-contrib are installed"));
		process.exit(1);
	}
}

/**
 * Handle the serve command
 */
export async function handleServe(options: ServeOptions): Promise<void> {
	const { UndercityServer, isDaemonRunning, getDaemonState } = await import("../server.js");

	const port = Number.parseInt(options.port || "7331", 10);

	// Check if already running
	if (isDaemonRunning()) {
		const state = getDaemonState();
		console.log(chalk.yellow(`Daemon already running on port ${state?.port} (PID ${state?.pid})`));
		console.log(chalk.dim("Use 'undercity daemon stop' to stop it first"));
		process.exit(1);
	}

	const server = new UndercityServer({
		port,
		onStop: () => {
			console.log(chalk.dim("\nShutdown requested via API"));
		},
	});

	try {
		await server.start();
		console.log(chalk.cyan.bold("\n🌐 Undercity Daemon"));
		console.log(chalk.dim(`  Port: ${port}`));
		console.log(chalk.dim(`  PID: ${process.pid}`));
		console.log();
		console.log("Endpoints:");
		console.log(chalk.dim("  GET  /status   - Session, agents, tasks summary"));
		console.log(chalk.dim("  GET  /tasks    - Full task board"));
		console.log(chalk.dim("  POST /tasks    - Add task { objective, priority? }"));
		console.log(chalk.dim("  GET  /metrics  - Metrics summary"));
		console.log(chalk.dim("  POST /pause    - Pause grind"));
		console.log(chalk.dim("  POST /resume   - Resume grind"));
		console.log(chalk.dim("  POST /stop     - Stop daemon"));
		console.log();
		console.log("Examples:");
		console.log(chalk.dim(`  curl localhost:${port}/status`));
		console.log(chalk.dim(`  curl -X POST localhost:${port}/tasks -d '{"objective":"Fix bug"}'`));
		console.log();
		console.log(chalk.green("Daemon running. Press Ctrl+C to stop."));

		// If --grind flag, also start grind loop
		if (options.grind) {
			console.log(chalk.cyan("\nStarting grind loop..."));
			// TODO: Wire up grind loop with daemon pause/resume
		}

		// Handle graceful shutdown
		process.on("SIGINT", async () => {
			console.log(chalk.dim("\nShutting down..."));
			await server.stop();
			process.exit(0);
		});

		process.on("SIGTERM", async () => {
			await server.stop();
			process.exit(0);
		});
	} catch (error) {
		console.error(chalk.red(`Failed to start daemon: ${error}`));
		process.exit(1);
	}
}

/**
 * Handle the daemon command
 */
export async function handleDaemon(action?: string): Promise<void> {
	const { isDaemonRunning, queryDaemon } = await import("../server.js");

	if (!action || action === "status") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			console.log(chalk.dim("Start with: undercity serve"));
			return;
		}

		try {
			const status = (await queryDaemon("/status")) as Record<string, unknown>;
			const daemon = status.daemon as Record<string, unknown>;
			const session = status.session as Record<string, unknown> | null;
			const agents = status.agents as Array<Record<string, unknown>>;
			const tasks = status.tasks as Record<string, number>;

			console.log(chalk.green.bold("✓ Daemon Running"));
			console.log(chalk.dim(`  Port: ${daemon.port} | PID: ${daemon.pid}`));
			console.log(chalk.dim(`  Uptime: ${Math.round(daemon.uptime as number)}s`));
			console.log(chalk.dim(`  State: ${daemon.paused ? chalk.yellow("PAUSED") : chalk.green("active")}`));

			if (session) {
				console.log();
				console.log(chalk.bold("Session:"));
				console.log(chalk.dim(`  ${session.id}: ${session.goal}`));
			}

			if (agents && agents.length > 0) {
				console.log();
				console.log(chalk.bold(`Agents (${agents.length}):`));
				for (const a of agents) {
					console.log(chalk.dim(`  ${a.type}: ${a.status}`));
				}
			}

			console.log();
			console.log(chalk.bold("Tasks:"));
			console.log(chalk.dim(`  ${tasks.pending} pending, ${tasks.inProgress} in progress, ${tasks.complete} complete`));
		} catch (error) {
			console.error(chalk.red(`Failed to query daemon: ${error}`));
		}
	} else if (action === "stop") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		try {
			await queryDaemon("/stop", "POST");
			console.log(chalk.green("Daemon stopping..."));
		} catch {
			// Expected - daemon shuts down
			console.log(chalk.green("Daemon stopped"));
		}
	} else if (action === "pause") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		await queryDaemon("/pause", "POST");
		console.log(chalk.yellow("Grind paused"));
	} else if (action === "resume") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		await queryDaemon("/resume", "POST");
		console.log(chalk.green("Grind resumed"));
	} else {
		console.log(chalk.red(`Unknown action: ${action}`));
		console.log(chalk.dim("Available: status, stop, pause, resume"));
	}
}

/**
 * Handle the status command
 */
export async function handleStatus(options: StatusOptions): Promise<void> {
	const { getCurrentGrindStatus, readRecentEvents } = await import("../grind-events.js");

	if (options.events) {
		const count = Number.parseInt(options.count || "20", 10);
		const events = readRecentEvents(count);

		if (options.human) {
			for (const event of events) {
				const time = new Date(event.timestamp).toLocaleTimeString();
				const taskPart = event.taskId ? ` [${event.taskId}]` : "";
				console.log(`${chalk.dim(time)}${taskPart} ${chalk.bold(event.type)} ${event.message}`);
			}
		} else {
			console.log(JSON.stringify(events, null, 2));
		}
		return;
	}

	const status = getCurrentGrindStatus();

	if (!options.human) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}

	if (!status.isRunning && status.tasksQueued === 0) {
		console.log(chalk.gray("No active or recent grind session"));
		return;
	}

	console.log(status.isRunning ? chalk.green.bold("⚡ Grind Running") : chalk.yellow.bold("○ Grind Complete"));
	console.log(chalk.dim(`  Batch: ${status.batchId || "unknown"}`));
	console.log();
	console.log(chalk.bold("Progress:"));
	console.log(
		`  Queued: ${status.tasksQueued} | Started: ${status.tasksStarted} | Complete: ${status.tasksComplete} | Failed: ${status.tasksFailed}`,
	);
}

/**
 * Index command options
 */
export interface IndexOptions {
	full?: boolean;
	stats?: boolean;
	summaries?: boolean;
}

/**
 * Handle the index command - build/update AST index
 */
export async function handleIndex(options: IndexOptions): Promise<void> {
	const { getASTIndex } = await import("../ast-index.js");

	const index = getASTIndex();
	await index.load();

	if (options.stats) {
		const stats = index.getStats();
		console.log(chalk.bold("AST Index Statistics"));
		console.log(`  Files indexed: ${stats.fileCount}`);
		console.log(`  Symbols tracked: ${stats.symbolCount}`);
		console.log(`  Last updated: ${stats.lastUpdated}`);
		return;
	}

	if (options.summaries) {
		const summaries = index.getAllSummaries();
		if (summaries.length === 0) {
			console.log(chalk.yellow("No summaries available. Run 'undercity index --full' first."));
			return;
		}
		console.log(chalk.bold(`File Summaries (${summaries.length} files)\n`));
		for (const { path, summary } of summaries) {
			console.log(chalk.cyan(path));
			console.log(`  ${summary}\n`);
		}
		return;
	}

	const startTime = Date.now();

	if (options.full) {
		console.log(chalk.blue("Rebuilding full AST index..."));
		await index.rebuildFull();
	} else {
		console.log(chalk.blue("Updating AST index incrementally..."));
		const updated = await index.updateIncremental();
		console.log(chalk.green(`Updated ${updated} files`));
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(chalk.dim(`Completed in ${elapsed}s`));
}

/**
 * Introspect command options
 */
export interface IntrospectOptions {
	json?: boolean;
	limit?: string;
	since?: string;
	patterns?: boolean;
}

/**
 * Handle the introspect command - analyze own metrics and performance
 */
export async function handleIntrospect(options: IntrospectOptions): Promise<void> {
	const { getMetricsAnalysis, formatAnalysisSummary, analyzeTaskPatterns, formatPatternSummary } = await import(
		"../feedback-metrics.js"
	);

	const loadOptions: { limit?: number; since?: Date } = {};

	if (options.limit) {
		loadOptions.limit = Number.parseInt(options.limit, 10);
	}

	if (options.since) {
		const date = new Date(options.since);
		if (!Number.isNaN(date.getTime())) {
			loadOptions.since = date;
		}
	}

	// Pattern analysis mode
	if (options.patterns) {
		const patterns = analyzeTaskPatterns(loadOptions);

		if (options.json) {
			console.log(JSON.stringify(patterns, null, 2));
			return;
		}

		console.log(chalk.bold.cyan("\n🧠 Task Pattern Analysis\n"));
		console.log(formatPatternSummary(patterns));
		return;
	}

	const analysis = getMetricsAnalysis(loadOptions);

	if (options.json) {
		console.log(JSON.stringify(analysis, null, 2));
		return;
	}

	// Human-readable output
	console.log(chalk.bold.cyan("\n🔍 Undercity Self-Analysis\n"));
	console.log(formatAnalysisSummary(analysis));

	// Add routing accuracy section if there's data
	if (analysis.totalTasks > 0) {
		console.log("");
		console.log(chalk.bold("Routing Accuracy:"));
		const { correctTier, needsEscalation } = analysis.routingAccuracy;
		const total = correctTier + needsEscalation;
		if (total > 0) {
			const accuracy = ((correctTier / total) * 100).toFixed(0);
			console.log(`  Correct tier on first try: ${accuracy}% (${correctTier}/${total})`);
		}
	}

	// Show escalation paths if any
	if (Object.keys(analysis.escalation.byPath).length > 0) {
		console.log("");
		console.log(chalk.bold("Escalation Paths:"));
		for (const [path, stats] of Object.entries(analysis.escalation.byPath)) {
			const successRate = stats.count > 0 ? ((stats.successCount / stats.count) * 100).toFixed(0) : "0";
			console.log(`  ${path}: ${stats.count} times (${successRate}% success)`);
		}
	}
}

/**
 * Handle the tuning command
 * View and manage the learned model routing profile
 */
export async function handleTuning(options: TuningOptions): Promise<void> {
	const { loadRoutingProfile, saveRoutingProfile, computeOptimalThresholds, formatProfileSummary } = await import(
		"../self-tuning.js"
	);
	const { unlinkSync } = await import("node:fs");

	const profilePath = join(process.cwd(), ".undercity/routing-profile.json");

	// Clear profile if requested
	if (options.clear) {
		try {
			unlinkSync(profilePath);
			console.log(chalk.green("Routing profile cleared. Defaults will be used."));
		} catch {
			console.log(chalk.yellow("No routing profile to clear."));
		}
		return;
	}

	// Rebuild profile if requested
	if (options.rebuild) {
		console.log(chalk.blue("Rebuilding routing profile from metrics..."));
		const profile = computeOptimalThresholds();

		if (profile.taskCount === 0) {
			console.log(chalk.yellow("No metrics found. Run some tasks first."));
			return;
		}

		saveRoutingProfile(profile);
		console.log(chalk.green(`Profile rebuilt from ${profile.taskCount} tasks.`));
		console.log("");
		console.log(formatProfileSummary(profile));
		return;
	}

	// Default: show current profile
	const profile = loadRoutingProfile();

	if (!profile) {
		console.log(chalk.yellow("No routing profile found."));
		console.log("");
		console.log("The routing profile is automatically created after completing tasks.");
		console.log("It learns optimal model thresholds from your task history.");
		console.log("");
		console.log("Use --rebuild to create from existing metrics, or run more tasks.");
		return;
	}

	console.log(formatProfileSummary(profile));
}
