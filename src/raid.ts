/**
 * Raid Lifecycle Module
 *
 * Orchestrates the full raid lifecycle:
 * 1. PLAN PHASE (BMAD-style)
 *    - Scout analyzes the codebase
 *    - Planner creates detailed spec
 *    - Human approves the plan
 *
 * 2. EXECUTE PHASE (Gas Town-style)
 *    - Fabricators implement the approved plan
 *    - Auditor reviews the work
 *    - Serial merge queue handles integration
 *
 * 3. EXTRACT
 *    - All work merged
 *    - Raid complete
 *
 * Implements GUPP: if there's work in progress, continue it.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { createAndCheckout, MergeQueue } from "./git.js";
import { raidLogger, squadLogger } from "./logger.js";
import { Persistence } from "./persistence.js";
import { createSquadMember, SQUAD_AGENTS } from "./squad.js";
import type { AgentType, Raid, SquadMember, Task } from "./types.js";

/**
 * Generate a unique raid ID
 */
function generateRaidId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `raid-${timestamp}-${random}`;
}

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `task-${timestamp}-${random}`;
}

/**
 * Raid orchestrator
 *
 * Manages the full raid lifecycle from start to extraction.
 */
export class RaidOrchestrator {
	private persistence: Persistence;
	private mergeQueue: MergeQueue;
	private maxSquadSize: number;
	private autoApprove: boolean;
	private verbose: boolean;
	private streamOutput: boolean;

	constructor(
		options: {
			stateDir?: string;
			maxSquadSize?: number;
			autoApprove?: boolean;
			verbose?: boolean;
			streamOutput?: boolean;
		} = {},
	) {
		this.persistence = new Persistence(options.stateDir);
		this.mergeQueue = new MergeQueue();
		this.maxSquadSize = options.maxSquadSize || 5;
		this.autoApprove = options.autoApprove || false;
		this.verbose = options.verbose || false;
		this.streamOutput = options.streamOutput ?? options.verbose ?? false;
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			raidLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Stream agent activity to console for visibility
	 */
	private streamAgentActivity(member: SquadMember, message: unknown): void {
		if (!this.streamOutput) return;

		const msg = message as Record<string, unknown>;
		const prefix = chalk.dim(`[${member.type}]`);

		// Show tool usage (SDK format: type=assistant, tool uses in content)
		if (msg.type === "assistant") {
			const content = msg.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_use" && block.name) {
						const input = block.input || {};
						let inputSummary = "";

						if ("file_path" in input) {
							inputSummary = chalk.cyan(String(input.file_path));
						} else if ("pattern" in input) {
							inputSummary = chalk.cyan(String(input.pattern));
						} else if ("command" in input) {
							inputSummary = chalk.cyan(String(input.command).substring(0, 60));
						} else if ("content" in input) {
							inputSummary = chalk.gray("(writing content)");
						}

						console.log(`${prefix} ${chalk.yellow(block.name)} ${inputSummary}`);
					} else if (block.type === "text") {
						const text = (block as { text?: string }).text;
						if (text) {
							const firstLine = text.split("\n")[0].substring(0, 80);
							if (firstLine.trim()) {
								console.log(`${prefix} ${chalk.gray(firstLine)}${text.length > 80 ? "..." : ""}`);
							}
						}
					}
				}
			}
		}

		// Also show tool results briefly
		if (msg.type === "tool_result") {
			const toolName = (msg as { tool_name?: string }).tool_name;
			if (toolName) {
				console.log(`${prefix} ${chalk.green("✓")} ${toolName}`);
			}
		}
	}

	/**
	 * Check if there's an active raid (GUPP principle)
	 */
	hasActiveRaid(): boolean {
		return this.persistence.hasActiveRaid();
	}

	/**
	 * Get the current raid
	 */
	getCurrentRaid(): Raid | undefined {
		return this.persistence.getRaid();
	}

	/**
	 * Start a new raid with a goal
	 *
	 * Phase 1: PLAN
	 * - Scout the codebase
	 * - Create a plan
	 * - Wait for approval
	 */
	async start(goal: string): Promise<Raid> {
		// Check for existing raid (GUPP)
		if (this.hasActiveRaid()) {
			const existing = this.getCurrentRaid();
			if (existing) {
				this.log("Resuming existing raid", { raidId: existing.id });
				return existing;
			}
		}

		// Create new raid
		const raid: Raid = {
			id: generateRaidId(),
			goal,
			status: "planning",
			startedAt: new Date(),
			planApproved: false,
		};

		this.persistence.saveRaid(raid);
		this.log("Started raid", { raidId: raid.id, goal });

		// Start planning phase
		await this.startPlanningPhase(raid);

		return raid;
	}

	/**
	 * Planning Phase (BMAD-style)
	 *
	 * 1. Scout analyzes the codebase
	 * 2. Planner creates detailed spec
	 */
	private async startPlanningPhase(raid: Raid): Promise<void> {
		this.log("Starting planning phase...");

		// Create scout task
		const scoutTask: Task = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "scout",
			description: `Scout the codebase to understand: ${raid.goal}`,
			status: "pending",
			createdAt: new Date(),
		};
		this.persistence.addTask(scoutTask);

		// Create planner task (depends on scout)
		const plannerTask: Task = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "planner",
			description: `Create implementation plan for: ${raid.goal}`,
			status: "pending",
			createdAt: new Date(),
		};
		this.persistence.addTask(plannerTask);

		// Spawn scout
		await this.spawnAgent("scout", scoutTask);
	}

	/**
	 * Spawn an agent to work on a task
	 */
	private async spawnAgent(type: AgentType, task: Task): Promise<SquadMember> {
		const member = createSquadMember(type, task);
		this.persistence.addSquadMember(member);

		// Update task status
		this.persistence.updateTask(task.id, {
			status: "assigned",
			agentId: member.id,
		});

		squadLogger.info({ agentType: type, agentId: member.id }, "Spawned agent");

		// Run the agent
		await this.runAgent(member, task);

		return member;
	}

	/**
	 * Run an agent using the Claude SDK
	 */
	private async runAgent(member: SquadMember, task: Task): Promise<void> {
		const agentDef = SQUAD_AGENTS[member.type];

		this.persistence.updateTask(task.id, { status: "in_progress" });
		this.persistence.updateSquadMember(member.id, {
			status: "working",
			lastActivityAt: new Date(),
		});

		try {
			let result = "";
			let sessionId: string | undefined;

			// Check for existing session to resume
			const existingSession = this.persistence.getSquadMemberSession(member.id);

			// Use bypassPermissions for agents that need to write/execute
			// Scout and Planner are read-only, Fabricator and Auditor need full access
			const needsFullAccess = member.type === "fabricator" || member.type === "auditor";

			const queryOptions = {
				system_prompt: agentDef.prompt,
				allowed_tools: agentDef.tools,
				model: this.getModelName(agentDef.model),
				permission_mode: needsFullAccess ? ("bypassPermissions" as const) : ("acceptEdits" as const),
				...(needsFullAccess
					? {
							allowDangerouslySkipPermissions: true,
							extraArgs: { "dangerously-skip-permissions": null },
						}
					: {}),
				cwd: process.cwd(),
				...(existingSession ? { resume: existingSession } : {}),
			};

			for await (const message of query({
				prompt: task.description,
				options: queryOptions,
			})) {
				// Stream activity to console
				this.streamAgentActivity(member, message);

				// Capture session ID for resumption
				if (message.type === "system" && message.subtype === "init") {
					sessionId = message.session_id;
					if (sessionId) {
						this.persistence.saveSquadMemberSession(member.id, sessionId);
					}
				}

				// Capture result
				if (message.type === "result" && message.subtype === "success") {
					result = message.result;
				}
			}

			// Task completed successfully
			this.persistence.updateTask(task.id, {
				status: "complete",
				result,
				completedAt: new Date(),
			});

			this.persistence.updateSquadMember(member.id, {
				status: "done",
				lastActivityAt: new Date(),
			});

			squadLogger.info({ agentId: member.id, taskId: task.id }, "Agent completed task");

			// Handle next steps based on task type
			await this.handleTaskCompletion(task, result);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			this.persistence.updateTask(task.id, {
				status: "failed",
				error: errorMessage,
				completedAt: new Date(),
			});

			this.persistence.updateSquadMember(member.id, {
				status: "error",
				lastActivityAt: new Date(),
			});

			squadLogger.error({ agentId: member.id, error: errorMessage }, "Agent failed");
		}
	}

	/**
	 * Get the full model name from short name
	 */
	private getModelName(model: "haiku" | "sonnet" | "opus"): string {
		switch (model) {
			case "haiku":
				return "claude-3-5-haiku-20241022";
			case "sonnet":
				return "claude-sonnet-4-20250514";
			case "opus":
				return "claude-opus-4-5-20251101";
		}
	}

	/**
	 * Handle task completion and trigger next steps
	 */
	private async handleTaskCompletion(task: Task, result: string): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid) return;

		switch (task.type) {
			case "scout": {
				// Scout done - spawn planner
				const plannerTask = this.persistence
					.getTasks()
					.find((t) => t.raidId === raid.id && t.type === "planner" && t.status === "pending");
				if (plannerTask) {
					// Update planner task with scout intel
					plannerTask.description = `${plannerTask.description}\n\nScout Intel:\n${result}`;
					this.persistence.updateTask(plannerTask.id, {
						description: plannerTask.description,
					});
					await this.spawnAgent("planner", plannerTask);
				}
				break;
			}

			case "planner": {
				// Planner done - update raid with plan summary
				raid.planSummary = result;
				raid.status = "awaiting_approval";
				this.persistence.saveRaid(raid);

				this.log("Planning complete. Awaiting approval...");

				// If auto-approve is enabled, proceed
				if (this.autoApprove) {
					await this.approvePlan();
				}
				break;
			}

			case "fabricator": {
				// Fabricator done - queue for audit
				const auditTask: Task = {
					id: generateTaskId(),
					raidId: raid.id,
					type: "auditor",
					description: `Review implementation for: ${raid.goal}\n\nFabricator output:\n${result}`,
					status: "pending",
					createdAt: new Date(),
					branch: task.branch,
				};
				this.persistence.addTask(auditTask);
				await this.spawnAgent("auditor", auditTask);
				break;
			}

			case "auditor": {
				// Auditor done - check if approved
				const approved = result.toLowerCase().includes("approve");

				if (approved && task.branch) {
					// Add to merge queue
					this.mergeQueue.add(task.branch, task.id, task.agentId || "unknown");
					this.log("Branch added to merge queue", { branch: task.branch });

					// Process merge queue
					await this.processMergeQueue();
				} else {
					this.log("Audit found issues", { result });
					// Could spawn another fabricator to fix, for now just log
				}
				break;
			}
		}
	}

	/**
	 * Approve the plan and start execution phase
	 */
	async approvePlan(): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid || raid.status !== "awaiting_approval") {
			throw new Error("No raid awaiting approval");
		}

		raid.planApproved = true;
		raid.status = "executing";
		this.persistence.saveRaid(raid);

		this.log("Plan approved. Starting execution phase...");

		// Create fabricator task
		const fabricatorTask: Task = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "fabricator",
			description: `Implement: ${raid.goal}\n\nApproved Plan:\n${raid.planSummary}`,
			status: "pending",
			createdAt: new Date(),
		};

		// Create a branch for this work
		const branchName = `undercity/${raid.id}/implement`;
		try {
			createAndCheckout(branchName);
			fabricatorTask.branch = branchName;
		} catch (error) {
			this.log("Could not create branch", { error: String(error) });
		}

		this.persistence.addTask(fabricatorTask);
		await this.spawnAgent("fabricator", fabricatorTask);
	}

	/**
	 * Process the merge queue
	 */
	private async processMergeQueue(): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid) return;

		raid.status = "merging";
		this.persistence.saveRaid(raid);

		const results = await this.mergeQueue.processAll();

		for (const result of results) {
			if (result.status === "complete") {
				this.log("Merged branch", { branch: result.branch });
			} else {
				this.log("Merge failed", { branch: result.branch, error: result.error });
			}
		}

		// Check if all work is done
		const pendingTasks = this.persistence
			.getTasks()
			.filter((t) => t.raidId === raid.id && t.status !== "complete" && t.status !== "failed");

		if (pendingTasks.length === 0) {
			await this.extract();
		}
	}

	/**
	 * Extract - complete the raid
	 */
	async extract(): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid) {
			throw new Error("No active raid to extract");
		}

		raid.status = "complete";
		raid.completedAt = new Date();
		this.persistence.saveRaid(raid);

		// Add to stash history
		this.persistence.addCompletedRaid(raid, true);

		// Clear pocket for next raid
		this.persistence.clearPocket();

		this.log("Raid extracted successfully", { raidId: raid.id });
	}

	/**
	 * Get raid status summary
	 */
	getStatus(): {
		raid?: Raid;
		tasks: Task[];
		squad: SquadMember[];
		mergeQueue: ReturnType<MergeQueue["getQueue"]>;
	} {
		return {
			raid: this.getCurrentRaid(),
			tasks: this.persistence.getTasks(),
			squad: this.persistence.getSquad(),
			mergeQueue: this.mergeQueue.getQueue(),
		};
	}

	/**
	 * Surrender the current raid
	 */
	surrender(): void {
		const raid = this.getCurrentRaid();
		if (raid) {
			raid.status = "failed";
			raid.completedAt = new Date();
			this.persistence.saveRaid(raid);
			this.persistence.addCompletedRaid(raid, false);
			this.persistence.clearPocket();
			this.log("Raid surrendered", { raidId: raid.id });
		}
	}
}
