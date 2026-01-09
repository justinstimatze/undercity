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
import {
	extractImplementationContext,
	extractReviewContext,
	summarizeContextForAgent,
} from "./context.js";
import { FileTracker, parseFileOperation } from "./file-tracker.js";
import { calculateCodebaseFingerprint, createAndCheckout, hashFingerprint, hashGoal, isCacheableState, MergeQueue } from "./git.js";
import { raidLogger, squadLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import { Persistence } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import { createSquadMember, SQUAD_AGENTS } from "./squad.js";
import type { AgentType, FileConflict, MergeQueueRetryConfig, Raid, SquadMember, Task } from "./types.js";

/**
 * Timeout configuration for agent monitoring
 */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TIMEOUT_CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds

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
	private fileTracker: FileTracker;
	private metricsTracker: MetricsTracker;
	private maxSquadSize: number;
	private maxParallel: number;
	private autoApprove: boolean;
	private autoCommit: boolean;
	private verbose: boolean;
	private streamOutput: boolean;

	constructor(
		options: {
			stateDir?: string;
			maxSquadSize?: number;
			/** Maximum concurrent raiders (default 3, max 5) */
			maxParallel?: number;
			autoApprove?: boolean;
			autoCommit?: boolean;
			verbose?: boolean;
			streamOutput?: boolean;
			/** Merge queue retry configuration */
			retryConfig?: Partial<MergeQueueRetryConfig>;
		} = {},
	) {
		this.persistence = new Persistence(options.stateDir);
		this.mergeQueue = new MergeQueue(undefined, undefined, options.retryConfig);
		// Initialize file tracker from persisted state
		const trackingState = this.persistence.getFileTracking();
		this.fileTracker = new FileTracker(trackingState);
		// Initialize metrics tracker with rate limit tracking
		const rateLimitState = this.persistence.getRateLimitState();
		this.metricsTracker = new MetricsTracker(new RateLimitTracker(rateLimitState));
		this.maxSquadSize = options.maxSquadSize || 5;
		// Clamp maxParallel to valid range: 1-5, default 3
		this.maxParallel = Math.min(5, Math.max(1, options.maxParallel ?? 3));
		this.autoApprove = options.autoApprove || false;
		this.autoCommit = options.autoCommit || false;
		this.verbose = options.verbose || false;
		this.streamOutput = options.streamOutput ?? options.verbose ?? false;
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			raidLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Check if an agent has exceeded the timeout threshold
	 *
	 * Uses lastActivityAt to detect true idle/stuck state rather than
	 * just long-running tasks. A task that's actively processing will
	 * have its lastActivityAt updated frequently.
	 *
	 * @returns true if the agent is stuck and a warning was logged
	 */
	private checkAgentTimeout(member: SquadMember, task: Task): boolean {
		const now = new Date();
		const lastActivity = new Date(member.lastActivityAt);
		const elapsedMs = now.getTime() - lastActivity.getTime();

		if (elapsedMs >= AGENT_TIMEOUT_MS) {
			const elapsedMinutes = Math.floor(elapsedMs / 60000);

			squadLogger.warn(
				{
					agentId: member.id,
					agentType: member.type,
					taskId: task.id,
					taskType: task.type,
					elapsedMinutes,
					lastActivityAt: lastActivity.toISOString(),
					status: member.status,
					intervention: "warning_only",
				},
				`Agent timeout: ${member.type} agent ${member.id} has been inactive for ${elapsedMinutes} minutes. Consider intervention.`
			);

			// Mark as stuck for visibility in status (but don't interrupt)
			if (member.status !== "stuck") {
				this.persistence.updateSquadMember(member.id, { status: "stuck" });
			}

			return true;
		}

		return false;
	}

	/**
	 * Stream agent activity to console for visibility
	 *
	 * Handles multiple SDK message formats:
	 * - "assistant" messages with content blocks (tool_use, text)
	 * - "tool_result" messages for completed tool calls
	 * - "user" messages (streaming text input)
	 * - Other message types for debugging
	 */
	private streamAgentActivity(member: SquadMember, message: unknown): void {
		if (!this.streamOutput) return;

		const msg = message as Record<string, unknown>;
		const prefix = chalk.dim(`[${member.type}]`);

		// Handle content_block_start (streaming tool use)
		if (msg.type === "content_block_start") {
			const contentBlock = msg.content_block as { type?: string; name?: string } | undefined;
			if (contentBlock?.type === "tool_use" && contentBlock.name) {
				console.log(`${prefix} ${chalk.yellow(contentBlock.name)} ${chalk.dim("...")}`);
			}
		}

		// Handle content_block_delta (streaming updates)
		if (msg.type === "content_block_delta") {
			const delta = msg.delta as { type?: string; partial_json?: string; text?: string } | undefined;
			if (delta?.type === "text_delta" && delta.text) {
				const text = delta.text.trim();
				if (text && text.length < 100) {
					process.stdout.write(chalk.gray(text.substring(0, 50)));
				}
			}
		}

		// Handle assistant messages with content blocks (SDK format)
		if (msg.type === "assistant") {
			const content = msg.content as Array<{
				type: string;
				name?: string;
				input?: Record<string, unknown>;
				text?: string;
			}>;
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
						} else if ("prompt" in input) {
							inputSummary = chalk.cyan(String(input.prompt).substring(0, 40) + "...");
						}

						console.log(`${prefix} ${chalk.yellow(block.name)} ${inputSummary}`);
					} else if (block.type === "text" && block.text) {
						const firstLine = block.text.split("\n")[0].substring(0, 80);
						if (firstLine.trim()) {
							console.log(`${prefix} ${chalk.gray(firstLine)}${block.text.length > 80 ? "..." : ""}`);
						}
					}
				}
			}
		}

		// Handle tool results
		if (msg.type === "tool_result") {
			const toolName = (msg as { tool_name?: string; name?: string }).tool_name || (msg as { name?: string }).name;
			if (toolName) {
				console.log(`${prefix} ${chalk.green("✓")} ${toolName}`);
			}
		}

		// Handle message_start (new message beginning)
		if (msg.type === "message_start") {
			const msgData = msg.message as { role?: string } | undefined;
			if (msgData?.role === "assistant") {
				console.log(`${prefix} ${chalk.dim("thinking...")}`);
			}
		}

		// Handle result messages (final output)
		if (msg.type === "result") {
			const subtype = msg.subtype as string | undefined;
			if (subtype === "success") {
				console.log(`${prefix} ${chalk.green("✓")} Task complete`);
			} else if (subtype === "error") {
				console.log(`${prefix} ${chalk.red("✗")} Error: ${msg.error || "unknown"}`);
			}
		}
	}

	/**
	 * Track file operations from SDK messages
	 *
	 * Parses tool_use messages to extract file operations and records them
	 * in the file tracker for conflict detection.
	 */
	private trackFileOperationsFromMessage(agentId: string, message: unknown): void {
		const msg = message as Record<string, unknown>;

		// Handle assistant messages with content blocks (SDK format)
		if (msg.type === "assistant") {
			const content = msg.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_use") {
						const fileOp = parseFileOperation(block);
						if (fileOp) {
							this.fileTracker.recordFileAccess(agentId, fileOp.path, fileOp.operation);
							// Persist after each file operation for crash recovery
							this.persistence.saveFileTracking(this.fileTracker.getState());
						}
					}
				}
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
	 * Get current file conflicts between active agents
	 *
	 * Use this to check if parallel fabricators are stepping on each other's toes.
	 */
	getFileConflicts(): FileConflict[] {
		return this.fileTracker.detectConflicts();
	}

	/**
	 * Check if spawning a new agent would conflict with existing work
	 *
	 * @param expectedFiles - Files the new agent is expected to touch
	 * @returns Map of file paths to agent IDs currently working on them
	 */
	checkForConflicts(expectedFiles: string[]): Map<string, string[]> {
		return this.fileTracker.wouldConflict(expectedFiles);
	}

	/**
	 * Get files modified by a specific agent
	 */
	getAgentModifiedFiles(agentId: string): string[] {
		return this.fileTracker.getModifiedFiles(agentId);
	}

	/**
	 * Get a summary of file tracking status
	 */
	getFileTrackingSummary(): {
		activeAgents: number;
		completedAgents: number;
		totalFilesTouched: number;
		filesWithConflicts: number;
	} {
		return this.fileTracker.getSummary();
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

		// Start tracking this quest for rate limiting
		this.metricsTracker.startQuest(raid.id, goal, raid.id);

		// Start planning phase
		await this.startPlanningPhase(raid);

		return raid;
	}

	/**
	 * Planning Phase (BMAD-style)
	 *
	 * 1. Scout analyzes the codebase (or uses cached results)
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

		// Check scout cache before spawning agent
		const cachedResult = this.checkScoutCache(raid.goal);
		if (cachedResult) {
			this.log("Using cached scout intel", { goal: raid.goal });
			console.log(chalk.green("✓") + chalk.dim(" Scout cache hit - reusing previous analysis"));

			// Mark scout task complete with cached result
			this.persistence.updateTask(scoutTask.id, {
				status: "complete",
				result: cachedResult,
				completedAt: new Date(),
			});

			// Proceed directly to planner with cached intel
			await this.handleTaskCompletion(scoutTask, cachedResult);
			return;
		}

		// Cache miss - spawn scout agent
		this.log("Scout cache miss, spawning agent", { goal: raid.goal });
		await this.spawnAgent("scout", scoutTask);
	}

	/**
	 * Check the scout cache for a matching result
	 *
	 * @param goal The raid goal to check
	 * @returns Cached scout result if found, null otherwise
	 */
	private checkScoutCache(goal: string): string | null {
		try {
			// Only use cache if codebase is in a clean state
			if (!isCacheableState()) {
				this.log("Codebase has uncommitted changes, skipping cache");
				return null;
			}

			// Calculate fingerprint
			const fingerprint = calculateCodebaseFingerprint();
			if (!fingerprint) {
				this.log("Could not calculate codebase fingerprint");
				return null;
			}

			const fingerprintHash = hashFingerprint(fingerprint);
			const goalHash = hashGoal(goal);

			// Look up in cache
			const entry = this.persistence.getScoutCacheEntry(fingerprintHash, goalHash);
			if (entry) {
				return entry.scoutResult;
			}

			return null;
		} catch (error) {
			this.log("Error checking scout cache", { error: String(error) });
			return null;
		}
	}

	/**
	 * Store scout result in cache
	 *
	 * @param goal The raid goal
	 * @param result The scout intel result
	 */
	private storeScoutResult(goal: string, result: string): void {
		try {
			// Only cache if codebase is in a clean state
			if (!isCacheableState()) {
				this.log("Codebase has uncommitted changes, not caching scout result");
				return;
			}

			const fingerprint = calculateCodebaseFingerprint();
			if (!fingerprint) {
				return;
			}

			const fingerprintHash = hashFingerprint(fingerprint);
			const goalHash = hashGoal(goal);

			this.persistence.saveScoutCacheEntry(fingerprintHash, goalHash, result, goal);
			this.log("Stored scout result in cache", { goal });
		} catch (error) {
			this.log("Error storing scout result in cache", { error: String(error) });
			// Silent failure - caching is optional
		}
	}

	/**
	 * Spawn an agent to work on a task
	 */
	private async spawnAgent(type: AgentType, task: Task): Promise<SquadMember> {
		const raid = this.getCurrentRaid();
		const member = createSquadMember(type, task);
		this.persistence.addSquadMember(member);

		// Update task status
		this.persistence.updateTask(task.id, {
			status: "assigned",
			agentId: member.id,
		});

		// Start file tracking for fabricators (they're the ones that modify files)
		if (type === "fabricator" && raid) {
			this.fileTracker.startTracking(member.id, task.id, raid.id);
			this.persistence.saveFileTracking(this.fileTracker.getState());
		}

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

		// Start timeout monitoring interval
		// We need to keep a mutable reference to the member's lastActivityAt
		let currentMember = { ...member, lastActivityAt: new Date() };
		const timeoutCheckInterval = setInterval(() => {
			// Refresh member state from persistence for accurate lastActivityAt
			const freshMember = this.persistence.getSquad().find((m) => m.id === member.id);
			if (freshMember) {
				currentMember = freshMember;
				this.checkAgentTimeout(freshMember, task);
			}
		}, TIMEOUT_CHECK_INTERVAL_MS);

		try {
			let result = "";
			let sessionId: string | undefined;
			let questStartTime = Date.now();
			let totalTokensUsed = 0;

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

				// Track file operations for fabricators
				if (member.type === "fabricator") {
					this.trackFileOperationsFromMessage(member.id, message);
				}

				// Track token usage for rate limiting
				this.metricsTracker.recordTokenUsage(message, agentDef.model);
				const tokenUsage = this.metricsTracker.extractTokenUsage(message);
				if (tokenUsage) {
					totalTokensUsed += tokenUsage.totalTokens;
				}

				// Update lastActivityAt on meaningful activity
				// This keeps the timeout from triggering for actively working agents
				const msg = message as Record<string, unknown>;
				const isActivity =
					msg.type === "assistant" ||
					msg.type === "tool_result" ||
					msg.type === "content_block_start" ||
					(msg.type === "result" && msg.subtype === "success");

				if (isActivity) {
					const now = new Date();
					this.persistence.updateSquadMember(member.id, {
						lastActivityAt: now,
						// If agent was marked stuck but is now active, restore working status
						...(currentMember.status === "stuck" ? { status: "working" } : {}),
					});
					currentMember.lastActivityAt = now;
				}

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

			// Clear timeout monitoring
			clearInterval(timeoutCheckInterval);

			// Record quest completion metrics
			const questMetrics = this.metricsTracker.completeQuest(true);
			if (questMetrics) {
				this.persistence.addQuestMetric(questMetrics);
			}

			// Save rate limit state
			this.persistence.saveRateLimitState(this.metricsTracker.getRateLimitTracker().getState());

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

			// Stop file tracking for fabricators
			if (member.type === "fabricator") {
				this.fileTracker.stopTracking(member.id);
				this.persistence.saveFileTracking(this.fileTracker.getState());

				const modifiedFiles = this.fileTracker.getModifiedFiles(member.id);
				if (modifiedFiles.length > 0) {
					squadLogger.info(
						{ agentId: member.id, modifiedFiles: modifiedFiles.length },
						"Agent modified files",
					);
				}
			}

			// Handle next steps based on task type
			await this.handleTaskCompletion(task, result);
		} catch (error) {
			// Clear timeout monitoring on error
			clearInterval(timeoutCheckInterval);

			const errorMessage = error instanceof Error ? error.message : String(error);

			// Check for 429 rate limit error and record it
			const is429Error = errorMessage.toLowerCase().includes("429") ||
				errorMessage.toLowerCase().includes("rate limit") ||
				errorMessage.toLowerCase().includes("too many requests");

			if (is429Error) {
				// Extract response headers if available
				const responseHeaders = (error as any).response?.headers || {};
				this.metricsTracker.recordRateLimitHit(agentDef.model, error, responseHeaders);

				console.error(`🚨 Rate limit hit for ${agentDef.model} model during ${task.type} task`);
				console.error(`Current usage: ${JSON.stringify(this.metricsTracker.getRateLimitSummary().current, null, 2)}`);
			}

			// Record quest failure metrics
			this.metricsTracker.recordQuestFailure(errorMessage);
			const questMetrics = this.metricsTracker.completeQuest(false);
			if (questMetrics) {
				this.persistence.addQuestMetric(questMetrics);
			}

			// Save rate limit state even on errors
			this.persistence.saveRateLimitState(this.metricsTracker.getRateLimitTracker().getState());

			this.persistence.updateTask(task.id, {
				status: "failed",
				error: errorMessage,
				completedAt: new Date(),
			});

			this.persistence.updateSquadMember(member.id, {
				status: "error",
				lastActivityAt: new Date(),
			});

			// Stop file tracking on error too
			if (member.type === "fabricator") {
				this.fileTracker.stopTracking(member.id);
				this.persistence.saveFileTracking(this.fileTracker.getState());
			}

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
				// Store scout result in cache for future raids
				this.storeScoutResult(raid.goal, result);

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
				// Fabricator done - queue for audit with summarized context
				// Extract review-relevant parts of the plan and fabricator output
				// This provides auditor with focused context on what to verify
				const reviewContext = extractReviewContext(
					raid.planSummary || raid.goal,
					result
				);

				const auditTask: Task = {
					id: generateTaskId(),
					raidId: raid.id,
					type: "auditor",
					description: `Review implementation for: ${raid.goal}\n\n${reviewContext}`,
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
				const lower = result.toLowerCase();

				// Positive signals
				const positiveSignals = [
					"approve",
					"all tests pass",
					"tests pass",
					"implementation is correct",
					"well-done",
					"looks good",
					"lgtm",
					"✅",
				];

				// Negative signals (should reject)
				const negativeSignals = ["reject", "critical issue", "blocking", "must fix", "tests fail", "failed"];

				const hasPositive = positiveSignals.some((s) => lower.includes(s) || result.includes(s));
				const hasNegative = negativeSignals.some((s) => lower.includes(s));

				const approved = hasPositive && !hasNegative;

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

		// Create fabricator task with summarized context
		const commitInstructions = this.autoCommit
			? "\n\nIMPORTANT: When done, commit all your changes with a clear commit message describing what you implemented."
			: "";

		// Extract only implementation-relevant parts of the plan
		// This reduces token usage by 60-80% compared to passing the full plan
		const summarizedPlan = raid.planSummary
			? extractImplementationContext(raid.planSummary)
			: "";

		const fabricatorTask: Task = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "fabricator",
			description: `Implement: ${raid.goal}\n\nApproved Plan:\n${summarizedPlan}${commitInstructions}`,
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

		// Clear file tracking for this raid
		this.fileTracker.clearRaid(raid.id);
		this.persistence.saveFileTracking(this.fileTracker.getState());

		// Clear pocket for next raid
		this.persistence.clearPocket();

		this.log("Raid extracted successfully", { raidId: raid.id });
	}

	/**
	 * Get the maximum number of concurrent raiders
	 */
	getMaxParallel(): number {
		return this.maxParallel;
	}

	/**
	 * Get rate limit usage summary
	 */
	getRateLimitSummary(): ReturnType<MetricsTracker["getRateLimitSummary"]> {
		return this.metricsTracker.getRateLimitSummary();
	}

	/**
	 * Generate rate limit usage report
	 */
	generateRateLimitReport(): string {
		return this.metricsTracker.generateRateLimitReport();
	}

	/**
	 * Get quest metrics
	 */
	getQuestMetrics(days = 30): ReturnType<typeof this.persistence.getRecentQuestMetrics> {
		return this.persistence.getRecentQuestMetrics(days);
	}

	/**
	 * Get raid status summary
	 */
	getStatus(): {
		raid?: Raid;
		tasks: Task[];
		squad: SquadMember[];
		mergeQueue: ReturnType<MergeQueue["getQueue"]>;
		maxParallel: number;
		fileTracking: {
			activeAgents: number;
			completedAgents: number;
			totalFilesTouched: number;
			filesWithConflicts: number;
			conflicts: FileConflict[];
		};
	} {
		const trackingSummary = this.fileTracker.getSummary();
		return {
			raid: this.getCurrentRaid(),
			tasks: this.persistence.getTasks(),
			squad: this.persistence.getSquad(),
			mergeQueue: this.mergeQueue.getQueue(),
			maxParallel: this.maxParallel,
			fileTracking: {
				...trackingSummary,
				conflicts: this.fileTracker.detectConflicts(),
			},
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

			// Clear file tracking for this raid
			this.fileTracker.clearRaid(raid.id);
			this.persistence.saveFileTracking(this.fileTracker.getState());

			this.persistence.clearPocket();
			this.log("Raid surrendered", { raidId: raid.id });
		}
	}
}
