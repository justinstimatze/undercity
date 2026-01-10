/**
 * Raid Lifecycle Module
 *
 * Orchestrates the full raid lifecycle:
 * 1. PLAN PHASE (BMAD-style)
 *    - Flute analyzes the codebase
 *    - Logistics creates detailed spec
 *    - Human approves the plan
 *
 * 2. EXECUTE PHASE (Gas Town-style)
 *    - Fabricators implement the approved plan
 *    - Sheriff reviews the work
 *    - Serial elevator handles integration
 *
 * 3. EXTRACT
 *    - All work merged
 *    - Raid complete
 *
 * Implements GUPP: if there's work in progress, continue it.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { extractImplementationContext, extractReviewContext } from "./context.js";
import { dualLogger } from "./dual-logger.js";
import { EfficiencyTracker } from "./efficiency-tracker.js";
import { FileTracker, parseFileOperation } from "./file-tracker.js";
import {
	calculateCodebaseFingerprint,
	createAndCheckout,
	Elevator,
	hashFingerprint,
	hashGoal,
	isCacheableState,
} from "./git.js";
import { raidLogger, squadLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import { Persistence } from "./persistence.js";
import { RateLimitTracker } from "./rate-limit.js";
import { createSquadMember, SQUAD_AGENTS } from "./squad.js";
import type {
	AgentType,
	EfficiencyOutcome,
	ElevatorRetryConfig,
	FileConflict,
	LoadoutModelChoices,
	ParallelismLevel,
	Raid,
	SquadMember,
	Waypoint,
} from "./types.js";
import { WorktreeError, WorktreeManager } from "./worktree-manager.js";

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
 * Generate a unique waypoint ID
 */
function generateTaskId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `waypoint-${timestamp}-${random}`;
}

/**
 * Raid orchestrator
 *
 * Manages the full raid lifecycle from start to extraction.
 */
export class RaidOrchestrator {
	private persistence: Persistence;
	private elevator: Elevator;
	private fileTracker: FileTracker;
	private worktreeManager: WorktreeManager;
	private maxSquadSize: number;
	private maxParallel: number;
	private autoApprove: boolean;
	private autoCommit: boolean;
	private verbose: boolean;
	private streamOutput: boolean;

	// Efficiency tracking
	private efficiencyTracker?: EfficiencyTracker;
	private metricsTracker: MetricsTracker;
	private rateLimitTracker: RateLimitTracker;
	private currentParallelismLevel: ParallelismLevel = "limited";
	private currentModelChoices: LoadoutModelChoices = {
		flute: "haiku",
		logistics: "sonnet",
		quester: "sonnet",
		sheriff: "sonnet",
	};

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
			retryConfig?: Partial<ElevatorRetryConfig>;
			/** Parallelism level for efficiency tracking */
			parallelismLevel?: ParallelismLevel;
			/** Model choices for efficiency tracking */
			modelChoices?: LoadoutModelChoices;
		} = {},
	) {
		this.persistence = new Persistence(options.stateDir);
		this.elevator = new Elevator(undefined, undefined, options.retryConfig);
		// Initialize file tracker from persisted state
		const trackingState = this.persistence.getFileTracking();
		this.fileTracker = new FileTracker(trackingState);
		// Initialize worktree manager for raid isolation
		this.worktreeManager = new WorktreeManager(options.stateDir);
		this.maxSquadSize = options.maxSquadSize || 5;
		// Clamp maxParallel to valid range: 1-5, default 3
		this.maxParallel = Math.min(5, Math.max(1, options.maxParallel ?? 3));
		this.autoApprove = options.autoApprove || false;
		this.autoCommit = options.autoCommit || false;
		this.verbose = options.verbose || false;
		this.streamOutput = options.streamOutput ?? options.verbose ?? false;

		// Initialize metrics tracker
		this.metricsTracker = new MetricsTracker();

		// Initialize rate limit tracker from persisted state
		const rateLimitState = this.persistence.getRateLimitState();
		this.rateLimitTracker = new RateLimitTracker(rateLimitState ?? undefined);

		// Initialize efficiency tracking configuration
		if (options.parallelismLevel) {
			this.currentParallelismLevel = options.parallelismLevel;
		}
		if (options.modelChoices) {
			this.currentModelChoices = options.modelChoices;
		}

		// Perform startup recovery for orphaned worktrees
		this.performStartupRecovery();
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			raidLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Perform startup recovery for orphaned worktrees and corrupted state
	 */
	private performStartupRecovery(): void {
		try {
			// Get current active raid from persistence
			const currentRaid = this.getCurrentRaid();
			const activeRaidIds: string[] = currentRaid ? [currentRaid.id] : [];

			// Clean up orphaned worktrees (worktrees without corresponding active raids)
			this.worktreeManager.cleanupOrphanedWorktrees(activeRaidIds);

			// Validate worktree state consistency
			const persistedWorktrees = this.persistence.getAllActiveWorktrees();
			const actualWorktrees = this.worktreeManager.getActiveRaidWorktrees();

			// Find worktrees that exist in persistence but not on disk
			for (const persistedWorktree of persistedWorktrees) {
				const exists = actualWorktrees.some((w) => w.raidId === persistedWorktree.raidId);
				if (!exists) {
					this.log("Cleaning up stale worktree from persistence", {
						raidId: persistedWorktree.raidId,
					});
					this.persistence.removeWorktree(persistedWorktree.raidId);
				}
			}

			// Find worktrees that exist on disk but not in persistence
			for (const actualWorktree of actualWorktrees) {
				if (!activeRaidIds.includes(actualWorktree.raidId)) {
					this.log("Cleaning up untracked worktree", {
						raidId: actualWorktree.raidId,
					});
					try {
						this.worktreeManager.removeWorktree(actualWorktree.raidId, true);
					} catch (error) {
						this.log("Error cleaning up untracked worktree", {
							raidId: actualWorktree.raidId,
							error: String(error),
						});
					}
				}
			}

			this.log("Startup recovery completed successfully");
		} catch (error) {
			this.log("Error during startup recovery", { error: String(error) });
			// Non-fatal - continue with initialization
		}
	}

	/**
	 * Start efficiency tracking for a raid
	 */
	private startEfficiencyTracking(raidId: string, goal: string): void {
		const questId = `quest-${raidId}`;
		this.efficiencyTracker = new EfficiencyTracker(
			questId,
			raidId,
			goal,
			this.currentParallelismLevel,
			this.currentModelChoices,
		);
		this.log("Started efficiency tracking", { raidId, questId });
	}

	/**
	 * Configure efficiency tracking parameters
	 */
	configureEfficiencyTracking(
		parallelismLevel: ParallelismLevel,
		modelChoices: LoadoutModelChoices,
		experimentId?: string,
		variantName?: string,
	): void {
		this.currentParallelismLevel = parallelismLevel;
		this.currentModelChoices = modelChoices;

		// Update existing tracker if running
		if (this.efficiencyTracker) {
			// Re-create tracker with new parameters
			const status = this.efficiencyTracker.getStatus();
			const raid = this.getCurrentRaid();
			if (raid) {
				this.efficiencyTracker = new EfficiencyTracker(
					status.questId,
					raid.id,
					raid.goal,
					parallelismLevel,
					modelChoices,
					experimentId,
					variantName,
				);
			}
		}
	}

	/**
	 * Record rework attempt in efficiency tracker
	 */
	private recordReworkAttempt(reason: string, agentType: AgentType, tokensUsed: number, successful: boolean): void {
		if (this.efficiencyTracker) {
			this.efficiencyTracker.recordReworkAttempt(reason, agentType, tokensUsed, successful);
			this.log("Recorded rework attempt", { reason, agentType, tokensUsed, successful });
		}
	}

	/**
	 * Record user intervention in efficiency tracker
	 */
	recordUserIntervention(
		type: "approval_needed" | "conflict_resolution" | "clarification" | "manual_fix" | "direction_change",
		description: string,
		timeSpentMs: number,
	): void {
		if (this.efficiencyTracker) {
			this.efficiencyTracker.recordUserIntervention(type, description, timeSpentMs);
			this.log("Recorded user intervention", { type, description, timeSpentMs });
		}
	}

	/**
	 * Get current efficiency outcome
	 */
	getEfficiencyOutcome(): EfficiencyOutcome | null {
		return this.efficiencyTracker?.generateOutcome() ?? null;
	}

	/**
	 * Check if an agent has exceeded the timeout threshold
	 *
	 * Uses lastActivityAt to detect true idle/stuck state rather than
	 * just long-running waypoints. A waypoint that's actively processing will
	 * have its lastActivityAt updated frequently.
	 *
	 * @returns true if the agent is stuck and a warning was logged
	 */
	private checkAgentTimeout(member: SquadMember, waypoint: Waypoint): boolean {
		const now = new Date();
		const lastActivity = new Date(member.lastActivityAt);
		const elapsedMs = now.getTime() - lastActivity.getTime();

		if (elapsedMs >= AGENT_TIMEOUT_MS) {
			const elapsedMinutes = Math.floor(elapsedMs / 60000);

			squadLogger.warn(
				{
					agentId: member.id,
					agentType: member.type,
					waypointId: waypoint.id,
					taskType: waypoint.type,
					elapsedMinutes,
					lastActivityAt: lastActivity.toISOString(),
					status: member.status,
					intervention: "warning_only",
				},
				`Agent timeout: ${member.type} agent ${member.id} has been inactive for ${elapsedMinutes} minutes. Consider intervention.`,
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
	 * Stream agent activity to console and log file for visibility
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
				dualLogger.writeLine(`${prefix} ${chalk.yellow(contentBlock.name)} ${chalk.dim("...")}`);
			}
		}

		// Handle content_block_delta (streaming updates)
		if (msg.type === "content_block_delta") {
			const delta = msg.delta as { type?: string; partial_json?: string; text?: string } | undefined;
			if (delta?.type === "text_delta" && delta.text) {
				const text = delta.text.trim();
				if (text && text.length < 100) {
					dualLogger.write(chalk.gray(text.substring(0, 50)));
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
							inputSummary = chalk.cyan(`${String(input.prompt).substring(0, 40)}...`);
						}

						dualLogger.writeLine(`${prefix} ${chalk.yellow(block.name)} ${inputSummary}`);
					} else if (block.type === "text" && block.text) {
						const firstLine = block.text.split("\n")[0].substring(0, 80);
						if (firstLine.trim()) {
							dualLogger.writeLine(`${prefix} ${chalk.gray(firstLine)}${block.text.length > 80 ? "..." : ""}`);
						}
					}
				}
			}
		}

		// Handle tool results
		if (msg.type === "tool_result") {
			const toolName = (msg as { tool_name?: string; name?: string }).tool_name || (msg as { name?: string }).name;
			if (toolName) {
				dualLogger.writeLine(`${prefix} ${chalk.green("✓")} ${toolName}`);
			}
		}

		// Handle message_start (new message beginning)
		if (msg.type === "message_start") {
			const msgData = msg.message as { role?: string } | undefined;
			if (msgData?.role === "assistant") {
				dualLogger.writeLine(`${prefix} ${chalk.dim("thinking...")}`);
			}
		}

		// Handle result messages (final output)
		if (msg.type === "result") {
			const subtype = msg.subtype as string | undefined;
			if (subtype === "success") {
				dualLogger.writeLine(`${prefix} ${chalk.green("✓")} Waypoint complete`);
			} else if (subtype === "error") {
				dualLogger.writeLine(`${prefix} ${chalk.red("✗")} Error: ${msg.error || "unknown"}`);
			}
		}
	}

	/**
	 * Track file operations from SDK messages
	 *
	 * Parses tool_use messages to extract file operations and records them
	 * in the file tracker for conflict detection.
	 */
	private trackFileOperationsFromMessage(agentId: string, message: unknown, agentType?: AgentType): void {
		const msg = message as Record<string, unknown>;

		// Handle assistant messages with content blocks (SDK format)
		if (msg.type === "assistant") {
			const content = msg.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_use") {
						const fileOp = parseFileOperation(block);
						if (fileOp) {
							// Get the agent's working directory for proper path normalization
							let agentCwd = process.cwd();

							// Only use worktree path for agents that work in worktrees (quester/sheriff)
							if (agentType === "quester" || agentType === "sheriff") {
								const raid = this.getCurrentRaid();
								if (raid) {
									const worktreeInfo = this.persistence.getWorktreeForRaid(raid.id);
									if (worktreeInfo) {
										agentCwd = worktreeInfo.path;
									}
								}
							}

							this.fileTracker.recordFileAccess(agentId, fileOp.path, fileOp.operation, undefined, agentCwd);
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
	 * - Flute the codebase
	 * - Create a plan
	 * - Wait for approval
	 */
	async start(goal: string): Promise<Raid> {
		// Check for existing raid (GUPP)
		if (this.hasActiveRaid()) {
			const existing = this.getCurrentRaid();
			if (existing) {
				this.log("Resuming existing raid", { raidId: existing.id });

				// Start dual logging for resumed raid if not already active
				if (!dualLogger.isActive()) {
					dualLogger.start(existing.id);
				}

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

		// Start dual logging for this raid
		dualLogger.start(raid.id);

		// Start efficiency tracking for this raid
		this.startEfficiencyTracking(raid.id, goal);

		// Start planning phase
		await this.startPlanningPhase(raid);

		return raid;
	}

	/**
	 * Planning Phase (BMAD-style)
	 *
	 * 1. Flute analyzes the codebase (or uses cached results)
	 * 2. Logistics creates detailed spec
	 */
	private async startPlanningPhase(raid: Raid): Promise<void> {
		this.log("Starting planning phase...");

		// Check for auto-resume from rate limit pause
		this.checkRateLimitAutoResume();

		// Create flute waypoint
		const fluteTask: Waypoint = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "flute",
			description: `Flute the codebase to understand: ${raid.goal}`,
			status: "pending",
			createdAt: new Date(),
		};
		this.persistence.addTask(fluteTask);

		// Create logistics waypoint (depends on flute)
		const plannerTask: Waypoint = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "logistics",
			description: `Create implementation plan for: ${raid.goal}`,
			status: "pending",
			createdAt: new Date(),
		};
		this.persistence.addTask(plannerTask);

		// Check flute cache before spawning agent
		const cachedResult = this.checkFluteCache(raid.goal);
		if (cachedResult) {
			this.log("Using cached flute intel", { goal: raid.goal });
			console.log(chalk.green("✓") + chalk.dim(" Flute cache hit - reusing previous analysis"));

			// Mark flute waypoint complete with cached result
			this.persistence.updateTask(fluteTask.id, {
				status: "complete",
				result: cachedResult,
				completedAt: new Date(),
			});

			// Proceed directly to logistics with cached intel
			await this.handleTaskCompletion(fluteTask, cachedResult);
			return;
		}

		// Cache miss - spawn flute agent
		this.log("Flute cache miss, spawning agent", { goal: raid.goal });
		await this.spawnAgent("flute", fluteTask);
	}

	/**
	 * Check the flute cache for a matching result
	 *
	 * @param goal The raid goal to check
	 * @returns Cached flute result if found, null otherwise
	 */
	private checkFluteCache(goal: string): string | null {
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
			const entry = this.persistence.getFluteCacheEntry(fingerprintHash, goalHash);
			if (entry) {
				return entry.fluteResult;
			}

			return null;
		} catch (error) {
			this.log("Error checking flute cache", { error: String(error) });
			return null;
		}
	}

	/**
	 * Store flute result in cache
	 *
	 * @param goal The raid goal
	 * @param result The flute intel result
	 */
	private storeScoutResult(goal: string, result: string): void {
		try {
			// Only cache if codebase is in a clean state
			if (!isCacheableState()) {
				this.log("Codebase has uncommitted changes, not caching flute result");
				return;
			}

			const fingerprint = calculateCodebaseFingerprint();
			if (!fingerprint) {
				return;
			}

			const fingerprintHash = hashFingerprint(fingerprint);
			const goalHash = hashGoal(goal);

			this.persistence.saveFluteCacheEntry(fingerprintHash, goalHash, result, goal);
			this.log("Stored flute result in cache", { goal });
		} catch (error) {
			this.log("Error storing flute result in cache", { error: String(error) });
			// Silent failure - caching is optional
		}
	}

	/**
	 * Spawn an agent to work on a waypoint
	 */
	private async spawnAgent(type: AgentType, waypoint: Waypoint): Promise<SquadMember> {
		// Check if system is paused due to rate limits
		if (this.rateLimitTracker.isPaused()) {
			this.log("Cannot spawn agent - system paused due to rate limits");
			this.rateLimitTracker.logPauseStatus();
			throw new Error("System paused due to rate limits");
		}

		const raid = this.getCurrentRaid();
		const member = createSquadMember(type, waypoint);
		this.persistence.addSquadMember(member);

		// Update waypoint status
		this.persistence.updateTask(waypoint.id, {
			status: "assigned",
			agentId: member.id,
		});

		// Start file tracking for fabricators (they're the ones that modify files)
		if (type === "quester" && raid) {
			this.fileTracker.startTracking(member.id, waypoint.id, raid.id);
			this.persistence.saveFileTracking(this.fileTracker.getState());
		}

		// Record agent activity in efficiency tracker
		if (this.efficiencyTracker) {
			this.efficiencyTracker.recordAgentActivity(type);
		}

		squadLogger.info({ agentType: type, agentId: member.id }, "Spawned agent");

		// Run the agent
		await this.runAgent(member, waypoint);

		return member;
	}

	/**
	 * Run an agent using the Claude SDK
	 */
	private async runAgent(member: SquadMember, waypoint: Waypoint): Promise<void> {
		const agentDef = SQUAD_AGENTS[member.type];

		this.persistence.updateTask(waypoint.id, { status: "in_progress" });
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
				this.checkAgentTimeout(freshMember, waypoint);
			}
		}, TIMEOUT_CHECK_INTERVAL_MS);

		try {
			let result = "";
			let sessionId: string | undefined;

			// Check for existing session to resume
			const existingSession = this.persistence.getSquadMemberSession(member.id);

			// Use bypassPermissions for agents that need to write/execute
			// Flute and Logistics are read-only, Quester and Sheriff need full access
			const needsFullAccess = member.type === "quester" || member.type === "sheriff";

			// Determine the working directory: use worktree for quester/sheriff, main repo for others
			let workingDir = process.cwd();
			if (member.type === "quester" || member.type === "sheriff") {
				const raid = this.getCurrentRaid();
				if (raid) {
					const worktreeInfo = this.persistence.getWorktreeForRaid(raid.id);
					if (worktreeInfo) {
						workingDir = worktreeInfo.path;
						this.log("Using worktree for agent", {
							agentType: member.type,
							worktreePath: worktreeInfo.path,
						});
					}
				}
			}

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
				cwd: workingDir,
				...(existingSession ? { resume: existingSession } : {}),
			};

			for await (const message of query({
				prompt: waypoint.description,
				options: queryOptions,
			})) {
				// Stream activity to console
				this.streamAgentActivity(member, message);

				// Track file operations for fabricators
				if (member.type === "quester") {
					this.trackFileOperationsFromMessage(member.id, message, member.type);
				}

				// Track token usage for efficiency metrics
				this.metricsTracker.recordTokenUsage(message, agentDef.model);
				const usage = this.metricsTracker.extractTokenUsage(message);
				if (usage && this.efficiencyTracker) {
					this.efficiencyTracker.recordTokenUsage(usage.totalTokens, member.type);
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

			// Waypoint completed successfully
			this.persistence.updateTask(waypoint.id, {
				status: "complete",
				result,
				completedAt: new Date(),
			});

			this.persistence.updateSquadMember(member.id, {
				status: "done",
				lastActivityAt: new Date(),
			});

			squadLogger.info({ agentId: member.id, waypointId: waypoint.id }, "Agent completed waypoint");

			// Record first attempt completion in efficiency tracker
			if (this.efficiencyTracker) {
				this.efficiencyTracker.recordFirstAttemptCompletion(true);
			}

			// Stop file tracking for fabricators
			if (member.type === "quester") {
				this.fileTracker.stopTracking(member.id);
				this.persistence.saveFileTracking(this.fileTracker.getState());

				const modifiedFiles = this.fileTracker.getModifiedFiles(member.id);
				if (modifiedFiles.length > 0) {
					squadLogger.info({ agentId: member.id, modifiedFiles: modifiedFiles.length }, "Agent modified files");
				}
			}

			// Handle next steps based on waypoint type
			await this.handleTaskCompletion(waypoint, result);
		} catch (error) {
			// Clear timeout monitoring on error
			clearInterval(timeoutCheckInterval);

			const errorMessage = error instanceof Error ? error.message : String(error);

			// Check if this is a 429 rate limit error
			if (RateLimitTracker.is429Error(error)) {
				this.log("Rate limit detected from agent error", { agentType: member.type, error: errorMessage });

				// Count current active agents
				const activeAgents = this.persistence
					.getSquad()
					.filter((m) => m.status === "working" || m.status === "idle").length;

				// Record the rate limit hit and trigger pause
				this.rateLimitTracker.recordRateLimitHit(
					agentDef.model,
					errorMessage,
					undefined, // TODO: Extract headers if available
				);

				// Update pause with agent count
				const pauseState = this.rateLimitTracker.getPauseState();
				if (pauseState.isPaused) {
					this.rateLimitTracker.pauseForRateLimit(agentDef.model, errorMessage, activeAgents);
				}

				// Persist the rate limit state
				this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
			}

			this.persistence.updateTask(waypoint.id, {
				status: "failed",
				error: errorMessage,
				completedAt: new Date(),
			});

			this.persistence.updateSquadMember(member.id, {
				status: "error",
				lastActivityAt: new Date(),
			});

			// Record failed attempt in efficiency tracker
			if (this.efficiencyTracker) {
				this.efficiencyTracker.recordFirstAttemptCompletion(false);
				this.recordReworkAttempt(errorMessage, member.type, 0, false);
			}

			// Stop file tracking on error too
			if (member.type === "quester") {
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
	 * Handle waypoint completion and trigger next steps
	 */
	private async handleTaskCompletion(waypoint: Waypoint, result: string): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid) return;

		switch (waypoint.type) {
			case "flute": {
				// Store flute result in cache for future raids
				this.storeScoutResult(raid.goal, result);

				// Flute done - spawn logistics
				const plannerTask = this.persistence
					.getTasks()
					.find((t) => t.raidId === raid.id && t.type === "logistics" && t.status === "pending");
				if (plannerTask) {
					// Update logistics waypoint with flute intel
					plannerTask.description = `${plannerTask.description}\n\nScout Intel:\n${result}`;
					this.persistence.updateTask(plannerTask.id, {
						description: plannerTask.description,
					});
					await this.spawnAgent("logistics", plannerTask);
				}
				break;
			}

			case "logistics": {
				// Logistics done - update raid with plan summary
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

			case "quester": {
				// Quester done - queue for audit with summarized context
				// Extract review-relevant parts of the plan and quester output
				// This provides sheriff with focused context on what to verify
				const reviewContext = extractReviewContext(raid.planSummary || raid.goal, result);

				const auditTask: Waypoint = {
					id: generateTaskId(),
					raidId: raid.id,
					type: "sheriff",
					description: `Review implementation for: ${raid.goal}\n\n${reviewContext}`,
					status: "pending",
					createdAt: new Date(),
					branch: waypoint.branch,
				};
				this.persistence.addTask(auditTask);
				await this.spawnAgent("sheriff", auditTask);
				break;
			}

			case "sheriff": {
				// Sheriff done - check if approved
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
				const negativeSignals = [
					"reject",
					"critical issue",
					"blocking",
					"must fix",
					"tests fail",
					"typecheck fail",
					"type errors",
					"failed",
				];

				const hasPositive = positiveSignals.some((s) => lower.includes(s) || result.includes(s));
				const hasNegative = negativeSignals.some((s) => lower.includes(s));

				const approved = hasPositive && !hasNegative;

				if (approved && waypoint.branch) {
					// Add to elevator
					this.elevator.add(waypoint.branch, waypoint.id, waypoint.agentId || "unknown");
					this.log("Branch added to elevator", { branch: waypoint.branch });

					// Process elevator
					await this.processElevator();
				} else {
					this.log("Audit found issues", { result });
					// Could spawn another quester to fix, for now just log
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

		// Check for auto-resume from rate limit pause
		this.checkRateLimitAutoResume();

		raid.planApproved = true;
		raid.status = "executing";
		this.persistence.saveRaid(raid);

		this.log("Plan approved. Starting execution phase...");

		// Create quester waypoint with summarized context
		const commitInstructions = this.autoCommit
			? "\n\nIMPORTANT: When done, commit all your changes with a clear commit message describing what you implemented."
			: "";

		// Extract only implementation-relevant parts of the plan
		// This reduces token usage by 60-80% compared to passing the full plan
		const summarizedPlan = raid.planSummary ? extractImplementationContext(raid.planSummary) : "";

		const fabricatorTask: Waypoint = {
			id: generateTaskId(),
			raidId: raid.id,
			type: "quester",
			description: `Implement: ${raid.goal}\n\nApproved Plan:\n${summarizedPlan}${commitInstructions}`,
			status: "pending",
			createdAt: new Date(),
		};

		// Create a worktree for this raid instead of switching branches
		try {
			const worktreeInfo = this.worktreeManager.createWorktree(raid.id);
			fabricatorTask.branch = worktreeInfo.branch;

			// Save worktree info to persistence
			this.persistence.addWorktree(worktreeInfo);

			this.log("Created worktree for raid", {
				raidId: raid.id,
				worktreePath: worktreeInfo.path,
				branch: worktreeInfo.branch,
			});
		} catch (error) {
			const errorMessage = error instanceof WorktreeError ? error.message : String(error);
			this.log("Could not create worktree", { raidId: raid.id, error: errorMessage });

			// Fallback: use traditional branch switching for this raid
			try {
				const branchName = `undercity/${raid.id}/fallback`;
				createAndCheckout(branchName);
				fabricatorTask.branch = branchName;
				this.log("Created fallback branch", { raidId: raid.id, branch: branchName });
			} catch (fallbackError) {
				this.log("Could not create fallback branch", {
					raidId: raid.id,
					error: String(fallbackError),
				});
				throw new Error(`Failed to create worktree or fallback branch: ${errorMessage}`);
			}
		}

		this.persistence.addTask(fabricatorTask);
		await this.spawnAgent("quester", fabricatorTask);
	}

	/**
	 * Process the elevator
	 */
	private async processElevator(): Promise<void> {
		const raid = this.getCurrentRaid();
		if (!raid) return;

		raid.status = "merging";
		this.persistence.saveRaid(raid);

		const results = await this.elevator.processAll();

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

		// Record stable completion in efficiency tracker
		if (this.efficiencyTracker) {
			this.efficiencyTracker.recordStableCompletion(true);
			const outcome = this.efficiencyTracker.generateOutcome();
			this.persistence.saveEfficiencyOutcome(outcome);
			this.log("Recorded efficiency outcome", { outcome });
		}

		// Add to stash history
		this.persistence.addCompletedRaid(raid, true);

		// Clear file tracking for this raid
		this.fileTracker.clearRaid(raid.id);
		this.persistence.saveFileTracking(this.fileTracker.getState());

		// Clean up worktree for this raid
		try {
			if (this.worktreeManager.hasWorktree(raid.id)) {
				this.worktreeManager.removeWorktree(raid.id);
				this.persistence.removeWorktree(raid.id);
				this.log("Cleaned up worktree", { raidId: raid.id });
			}
		} catch (error) {
			this.log("Error cleaning up worktree", { raidId: raid.id, error: String(error) });
		}

		// Clear pocket for next raid
		this.persistence.clearPocket();

		// Stop dual logging and rotate log
		dualLogger.stop(raid.id);

		this.log("Raid extracted successfully", { raidId: raid.id });
	}

	/**
	 * Get the maximum number of concurrent raiders
	 */
	getMaxParallel(): number {
		return this.maxParallel;
	}

	/**
	 * Check for auto-resume from rate limit pause
	 */
	checkRateLimitAutoResume(): boolean {
		const resumed = this.rateLimitTracker.checkAutoResume();
		if (resumed) {
			// Persist updated state
			this.persistence.saveRateLimitState(this.rateLimitTracker.getState());
		}
		return resumed;
	}

	/**
	 * Get current rate limit status
	 */
	getRateLimitStatus(): {
		isPaused: boolean;
		pauseState?: ReturnType<RateLimitTracker["getPauseState"]>;
		remainingTime?: string;
		usage: ReturnType<RateLimitTracker["getUsageSummary"]>;
	} {
		const isPaused = this.rateLimitTracker.isPaused();
		return {
			isPaused,
			pauseState: isPaused ? this.rateLimitTracker.getPauseState() : undefined,
			remainingTime: isPaused ? this.rateLimitTracker.formatRemainingTime() : undefined,
			usage: this.rateLimitTracker.getUsageSummary(),
		};
	}

	/**
	 * Get raid status summary
	 */
	getStatus(): {
		raid?: Raid;
		waypoints: Waypoint[];
		squad: SquadMember[];
		elevator: ReturnType<Elevator["getQueue"]>;
		maxParallel: number;
		rateLimitStatus: ReturnType<RaidOrchestrator["getRateLimitStatus"]>;
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
			waypoints: this.persistence.getTasks(),
			squad: this.persistence.getSquad(),
			elevator: this.elevator.getQueue(),
			maxParallel: this.maxParallel,
			rateLimitStatus: this.getRateLimitStatus(),
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
			// Record failure in efficiency tracker
			if (this.efficiencyTracker) {
				this.efficiencyTracker.recordStableCompletion(false);
				const outcome = this.efficiencyTracker.generateOutcome();
				this.persistence.saveEfficiencyOutcome(outcome);
				this.log("Recorded failed efficiency outcome", { outcome });
			}

			raid.status = "failed";
			raid.completedAt = new Date();
			this.persistence.saveRaid(raid);
			this.persistence.addCompletedRaid(raid, false);

			// Clear file tracking for this raid
			this.fileTracker.clearRaid(raid.id);
			this.persistence.saveFileTracking(this.fileTracker.getState());

			// Clean up worktree for this raid
			try {
				if (this.worktreeManager.hasWorktree(raid.id)) {
					this.worktreeManager.removeWorktree(raid.id, true); // Force cleanup on failure
					this.persistence.removeWorktree(raid.id);
					this.log("Cleaned up worktree", { raidId: raid.id });
				}
			} catch (error) {
				this.log("Error cleaning up worktree", { raidId: raid.id, error: String(error) });
			}

			this.persistence.clearPocket();

			// Stop dual logging and rotate log
			dualLogger.stop(raid.id);

			this.log("Raid surrendered", { raidId: raid.id });
		}
	}

	/**
	 * Emergency cleanup - clean up all worktrees and reset state
	 * Use this when something goes wrong and you need to reset everything
	 */
	emergencyCleanup(): void {
		this.log("Performing emergency cleanup");

		try {
			// Clean up all worktrees
			this.worktreeManager.emergencyCleanup();

			// Clear worktree state from persistence
			this.persistence.clearWorktreeState();

			// Clear all other state
			this.persistence.clearAll();
			this.fileTracker.clearRaid("");

			this.log("Emergency cleanup completed successfully");
		} catch (error) {
			this.log("Error during emergency cleanup", { error: String(error) });
		}
	}

	/**
	 * Get worktree manager for external access
	 */
	getWorktreeManager(): WorktreeManager {
		return this.worktreeManager;
	}
}
