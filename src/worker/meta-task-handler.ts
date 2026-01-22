/**
 * Meta-Task Handler
 *
 * Handles execution of meta-tasks ([meta:triage], [meta:prune]) and research tasks.
 * Extracted from TaskWorker to enable focused testing and clearer dependencies.
 *
 * Dependencies are injected rather than accessed via `this`, making the handler
 * stateless and easier to test.
 */

import { type PMResearchResult, pmResearch } from "../automated-pm.js";
import { sessionLogger } from "../logger.js";
import { parseMetaTaskResult } from "../meta-tasks.js";
import * as output from "../output.js";
import { addTask } from "../task.js";
import { parseResearchResult } from "../task-schema.js";
import type { MetaTaskResult, MetaTaskType } from "../types.js";
import type { TaskResult } from "../worker.js";
import {
	recordAttempt,
	selectTokenUsageSummary,
	type TaskExecutionState,
	type TaskIdentity,
	type WorkerConfig,
} from "./state.js";
import { commitResearchOutput, writePMResearchOutput } from "./task-helpers.js";

/**
 * Dependencies that must be provided by the caller (enables testing)
 */
export interface MetaTaskDependencies {
	/** Commit work to git - async because it may need to stage files */
	commitWork: (task: string) => Promise<string | undefined>;
	/** Record attempts to metrics tracker */
	recordMetricsAttempts: (records: TaskExecutionState["attemptRecords"]) => void;
	/** Mark task complete in metrics tracker */
	completeMetricsTask: (success: boolean) => void;
}

/**
 * Result of handling a meta-task attempt
 */
export type MetaTaskHandleResult = { done: true; result: TaskResult } | { done: false; feedback: string };

/**
 * Handle meta-task result parsing ([meta:triage], [meta:prune], etc.)
 */
export function handleMetaTaskResult(
	identity: TaskIdentity,
	state: TaskExecutionState,
	agentOutput: string,
	metaType: MetaTaskType,
	attemptStart: number,
	deps: MetaTaskDependencies,
): MetaTaskHandleResult {
	output.workerPhase(identity.taskId, "parsing");
	const metaResult = parseMetaTaskResult(agentOutput, metaType);

	if (metaResult) {
		return handleMetaTaskSuccess(identity, state, metaResult, attemptStart, deps);
	}

	output.warning("Failed to parse meta-task result, retrying...", { taskId: identity.taskId });
	return {
		done: false,
		feedback:
			"Your response could not be parsed as valid recommendations. Please return a JSON object with a 'recommendations' array.",
	};
}

function handleMetaTaskSuccess(
	identity: TaskIdentity,
	state: TaskExecutionState,
	metaResult: MetaTaskResult,
	attemptStart: number,
	deps: MetaTaskDependencies,
): MetaTaskHandleResult {
	output.workerVerification(identity.taskId, true);
	output.info(`Meta-task produced ${metaResult.recommendations.length} recommendations`, {
		taskId: identity.taskId,
	});

	// Record attempt
	recordAttempt(state, true, Date.now() - attemptStart);

	// Update metrics
	deps.recordMetricsAttempts(state.attemptRecords);
	deps.completeMetricsTask(true);

	return {
		done: true,
		result: {
			task: identity.task,
			status: "complete",
			model: state.currentModel,
			attempts: state.attempts,
			durationMs: Date.now() - (state.phase.phase === "executing" ? state.phase.startedAt : Date.now()),
			tokenUsage: selectTokenUsageSummary(state),
			metaTaskResult: metaResult,
		},
	};
}

/**
 * Handle research task result (agent-based research that writes findings)
 */
export async function handleResearchTaskResult(
	identity: TaskIdentity,
	state: TaskExecutionState,
	config: WorkerConfig,
	agentOutput: string,
	attemptStart: number,
	deps: MetaTaskDependencies,
): Promise<MetaTaskHandleResult> {
	const hasWrittenFile = state.writeCountThisExecution > 0;

	if (hasWrittenFile) {
		output.workerVerification(identity.taskId, true);
		output.info("Research findings written to .undercity/research/", { taskId: identity.taskId });

		// Record attempt
		recordAttempt(state, true, Date.now() - attemptStart);

		// Commit if enabled
		let commitSha: string | undefined;
		if (config.autoCommit) {
			output.workerPhase(identity.taskId, "committing");
			commitSha = await deps.commitWork(identity.task);
		}

		// Update metrics
		deps.recordMetricsAttempts(state.attemptRecords);
		deps.completeMetricsTask(true);

		const researchResult = parseResearchResult(agentOutput) ?? undefined;

		return {
			done: true,
			result: {
				task: identity.task,
				status: "complete",
				model: state.currentModel,
				attempts: state.attempts,
				durationMs: Date.now() - (state.phase.phase === "executing" ? state.phase.startedAt : Date.now()),
				commitSha,
				tokenUsage: selectTokenUsageSummary(state),
				researchResult,
			},
		};
	}

	output.warning("Research task did not write findings file, retrying...", { taskId: identity.taskId });
	return {
		done: false,
		feedback:
			"You must write your research findings to the specified markdown file. Please create the file with your findings.",
	};
}

/**
 * Run PM-based research for research tasks.
 * Uses automated PM to research topic, write design doc, and generate follow-up tasks.
 * This is a complete execution path - no agent loop needed.
 */
export async function runPMResearchTask(
	identity: TaskIdentity,
	config: WorkerConfig,
	startTime: number,
): Promise<TaskResult> {
	output.workerPhase(identity.taskId, "pm-research");
	sessionLogger.info({ taskId: identity.taskId, task: identity.task }, "Running PM-based research");

	const topic = identity.task.replace(/^\[research\]\s*/i, "").trim();

	try {
		const result = await pmResearch(topic, config.workingDirectory);

		// Write design doc
		const designDoc = formatPMResearchAsDesignDoc(topic, result);
		const outputPath = writePMResearchOutput(topic, designDoc, {
			taskId: identity.taskId,
			task: identity.task,
			workingDirectory: config.workingDirectory,
			autoCommit: config.autoCommit,
		});

		// Add generated task proposals to board
		const addedTasks = addResearchTaskProposals(result.taskProposals, identity.taskId);

		output.info(`PM research complete: ${result.findings.length} findings, ${addedTasks.length} tasks added`, {
			taskId: identity.taskId,
		});

		// Commit if enabled
		const commitSha = config.autoCommit ? commitResearchOutput(outputPath, topic, config.workingDirectory) : undefined;

		return {
			task: identity.task,
			status: "complete",
			model: "sonnet",
			attempts: 1,
			durationMs: Date.now() - startTime,
			commitSha,
			researchResult: {
				summary: `Research on: ${topic}`,
				findings: result.findings.map((f) => ({
					finding: f,
					confidence: 0.8,
					category: "fact" as const,
				})),
				nextSteps: [...result.recommendations, ...addedTasks.map((id) => `Task ${id} added to board`)],
				sources: result.sources,
			},
		};
	} catch (error) {
		sessionLogger.error({ error: String(error), taskId: identity.taskId }, "PM research failed");
		return {
			task: identity.task,
			status: "failed",
			model: "sonnet",
			attempts: 1,
			error: `PM research failed: ${String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Add task proposals from PM research to the board
 */
function addResearchTaskProposals(proposals: PMResearchResult["taskProposals"], sourceTaskId: string): string[] {
	const addedTasks: string[] = [];
	for (const proposal of proposals) {
		try {
			const newTask = addTask(proposal.objective, {
				priority: proposal.suggestedPriority || 5,
				tags: proposal.tags,
			});
			addedTasks.push(newTask.id);
			sessionLogger.info(
				{ taskId: newTask.id, objective: proposal.objective, sourceTask: sourceTaskId },
				"Added follow-up task from PM research",
			);
		} catch (error) {
			sessionLogger.warn({ error: String(error), proposal }, "Failed to add task proposal");
		}
	}
	return addedTasks;
}

/**
 * Format PM research result as a structured design document
 */
function formatPMResearchAsDesignDoc(topic: string, result: PMResearchResult): string {
	const lines: string[] = [
		`# Research: ${topic}`,
		"",
		`_Generated by automated PM on ${new Date().toISOString()}_`,
		"",
		"## Summary",
		"",
	];

	if (result.findings.length > 0) {
		lines.push("### Key Findings");
		lines.push("");
		for (const finding of result.findings) {
			lines.push(`- ${finding}`);
		}
		lines.push("");
	}

	if (result.recommendations.length > 0) {
		lines.push("### Recommendations");
		lines.push("");
		for (const rec of result.recommendations) {
			lines.push(`- ${rec}`);
		}
		lines.push("");
	}

	if (result.sources.length > 0) {
		lines.push("### Sources");
		lines.push("");
		for (const source of result.sources) {
			lines.push(`- ${source}`);
		}
		lines.push("");
	}

	if (result.taskProposals.length > 0) {
		lines.push("## Generated Tasks");
		lines.push("");
		for (const proposal of result.taskProposals) {
			lines.push(`### ${proposal.objective}`);
			lines.push("");
			lines.push(`**Rationale:** ${proposal.rationale}`);
			lines.push(`**Priority:** ${proposal.suggestedPriority}`);
			if (proposal.tags && proposal.tags.length > 0) {
				lines.push(`**Tags:** ${proposal.tags.join(", ")}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}
