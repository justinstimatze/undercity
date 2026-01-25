/**
 * Worker Stop Hooks
 *
 * Logic for determining when an agent should stop execution.
 * Extracted from TaskWorker for better maintainability.
 */

import { sessionLogger } from "../logger.js";

/**
 * State required for stop hook evaluation
 */
export interface StopHookState {
	taskAlreadyCompleteReason: string | null;
	noOpEditCount: number;
	writeCountThisExecution: number;
	consecutiveNoWriteAttempts: number;
	currentModel: string;
}

/**
 * Result from a stop hook evaluation
 */
export interface StopHookResult {
	continue: boolean;
	reason?: string;
}

/**
 * Create stop hooks for standard implementation tasks
 *
 * These hooks prevent the agent from finishing without making changes,
 * while allowing legitimate completion scenarios (task already done, no-op edits).
 */
export function createStandardStopHooks(
	getState: () => StopHookState,
	onNoWriteAttempt: () => void,
	onFailFast: (message: string) => never,
): Array<{ hooks: Array<() => Promise<StopHookResult>> }> {
	return [
		{
			hooks: [
				async () => {
					const state = getState();

					// Allow stopping if agent reported task is already complete
					if (state.taskAlreadyCompleteReason) {
						sessionLogger.info(
							{ reason: state.taskAlreadyCompleteReason },
							"Stop hook accepted: task already complete",
						);
						return { continue: true };
					}

					// Allow stopping if we detected no-op edits (content was already correct)
					if (state.noOpEditCount > 0 && state.writeCountThisExecution === 0) {
						sessionLogger.info(
							{ noOpEdits: state.noOpEditCount },
							"Stop hook accepted: no-op edits detected (content already correct)",
						);
						return { continue: true };
					}

					// No writes made - reject and provide feedback
					if (state.writeCountThisExecution === 0) {
						onNoWriteAttempt();

						// FAIL FAST: After 3 no-write attempts, terminate immediately
						// Data shows escalating vague tasks wastes tokens - 68% of failures are task quality issues
						if (state.consecutiveNoWriteAttempts >= 3) {
							sessionLogger.warn(
								{
									consecutiveNoWrites: state.consecutiveNoWriteAttempts,
									model: state.currentModel,
								},
								"FAIL FAST: 3+ consecutive no-write attempts - terminating to save tokens",
							);
							onFailFast(
								`VAGUE_TASK: Agent attempted to finish ${state.consecutiveNoWriteAttempts} times without making changes. ` +
									"Task likely needs decomposition into more specific subtasks.",
							);
						}

						// Provide escalating feedback based on consecutive no-write attempts
						let reason: string;
						if (state.consecutiveNoWriteAttempts === 2) {
							// Second attempt: mention task might be unclear
							reason =
								"You still haven't made any code changes. If you're unsure what to modify:\n" +
								"- Re-read the task to identify the specific file and change needed\n" +
								"- If the task is unclear, output: NEEDS_DECOMPOSITION: <what clarification or subtasks are needed>\n" +
								"- If already complete: TASK_ALREADY_COMPLETE: <reason>";
						} else {
							// First attempt: standard message
							reason =
								"You haven't made any code changes yet. If the task is already complete, output: TASK_ALREADY_COMPLETE: <reason>. Otherwise, implement the required changes.";
						}

						sessionLogger.info(
							{
								model: state.currentModel,
								writes: 0,
								consecutiveNoWrites: state.consecutiveNoWriteAttempts,
							},
							"Stop hook rejected: agent tried to finish with 0 writes",
						);

						return { continue: false, reason };
					}

					return { continue: true };
				},
			],
		},
	];
}

/**
 * Get max turns based on model tier
 *
 * Prevents runaway exploration - simple tasks don't need 20+ turns.
 * - Simple tasks (haiku): 10 turns
 * - Standard (sonnet): 15 turns
 * - Complex (opus): 25 turns
 */
export function getMaxTurnsForModel(model: "haiku" | "sonnet" | "opus"): number {
	const maxTurnsPerModel: Record<string, number> = {
		sonnet: 15,
		opus: 25,
	};
	return maxTurnsPerModel[model] ?? 15;
}
