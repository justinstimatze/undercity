/**
 * Mixed commands (solo, grind, utility, experiment commands)
 * These are combined due to their varied nature and to complete the refactoring efficiently.
 */
import chalk from "chalk";
import { getConfigSource, loadConfig, mergeWithConfig } from "../config.js";
import { type OracleCard, UndercityOracle } from "../oracle.js";
import * as output from "../output.js";
import { Persistence } from "../persistence.js";
import { RateLimitTracker } from "../rate-limit.js";
import type { CommandModule } from "./types.js";

export const mixedCommands: CommandModule = {
	register(program) {
		// Solo command - DEPRECATED, use grind instead
		program
			.command("solo <goal>")
			.description("[DEPRECATED: use 'grind <goal>'] Run a single task with verification")
			.option("-s, --stream", "Stream agent activity")
			.option("-v, --verbose", "Verbose logging")
			.option("-m, --model <tier>", "Starting model tier: haiku, sonnet, opus", "sonnet")
			.option("--no-commit", "Don't auto-commit on success")
			.option("--no-typecheck", "Skip typecheck verification")
			.option("--supervised", "Use supervised mode (Opus orchestrates workers)")
			.option("--worker <tier>", "Worker model for supervised mode: haiku, sonnet", "sonnet")
			.option("-d, --dry-run", "Show complexity assessment without executing")
			.option("--no-local", "Disable local tools and local LLM routing")
			.option("--review", "Enable escalating review passes before commit (haiku → sonnet → opus)")
			.option("--annealing", "Use annealing review at opus tier (multi-angle advisory)")
			.action(
				async (
					goal: string,
					cliOptions: {
						stream?: boolean;
						verbose?: boolean;
						model?: string;
						commit?: boolean;
						typecheck?: boolean;
						supervised?: boolean;
						worker?: string;
						dryRun?: boolean;
						local?: boolean;
						review?: boolean;
						annealing?: boolean;
					},
				) => {
					// Show deprecation warning
					console.log(chalk.yellow.bold("\n⚠ DEPRECATED: 'solo' command will be removed in a future version"));
					console.log(chalk.yellow(`  Use: undercity grind "${goal}"\n`));

					// Merge CLI options with config file defaults
					const options = mergeWithConfig(cliOptions);

					// Dynamic import to avoid loading heavy modules until needed
					const { SoloOrchestrator, SupervisedOrchestrator } = await import("../solo.js");

					console.log(chalk.cyan.bold("⚡ Undercity Solo Mode"));
					console.log(chalk.dim("  Adaptive escalation • External verification • Auto-commit"));
					const configSource = getConfigSource();
					if (configSource) {
						console.log(chalk.dim(`  Config: ${configSource}`));
					}
					console.log();

					try {
						// Early dry-run complexity assessment
						if (cliOptions.dryRun) {
							const { assessComplexityFast } = await import("../complexity.js");
							const assessment = assessComplexityFast(goal);
							console.log(chalk.bold("Complexity Assessment (Dry Run)"));
							console.log(chalk.dim(`  Complexity: ${assessment.level}`));
							console.log(chalk.dim(`  Estimated Scope: ${assessment.estimatedScope}`));
							console.log(chalk.dim(`  Recommended Model: ${assessment.model}`));
							console.log(chalk.dim(`  Confidence: ${(assessment.confidence * 100).toFixed(1)}%`));
							console.log(chalk.dim(`  Signals: ${assessment.signals.join(", ")}`));
							return;
						}

						if (options.supervised) {
							// Supervised mode: Opus orchestrates workers
							console.log(chalk.dim(`Mode: Supervised (Opus → ${options.worker || "sonnet"} workers)`));
							const orchestrator = new SupervisedOrchestrator({
								autoCommit: options.commit !== false,
								stream: options.stream,
								verbose: options.verbose,
								workerModel: (options.worker || "sonnet") as "haiku" | "sonnet",
							});

							const result = await orchestrator.runSupervised(goal);

							if (result.status === "complete") {
								console.log(chalk.green.bold("\n✓ Task complete"));
								if (result.commitSha) {
									console.log(chalk.dim(`  Commit: ${result.commitSha.substring(0, 8)}`));
								}
								console.log(chalk.dim(`  Duration: ${Math.round(result.durationMs / 1000)}s`));
							} else {
								console.log(chalk.red.bold("\n✗ Task failed"));
								if (result.error) {
									console.log(chalk.dim(`  Error: ${result.error}`));
								}
							}
						} else {
							// Solo mode: Adaptive escalation
							const orchestrator = new SoloOrchestrator({
								autoCommit: options.commit !== false,
								runTypecheck: options.typecheck !== false,
								stream: options.stream,
								verbose: options.verbose,
								startingModel: options.model as "haiku" | "sonnet" | "opus",
							});

							const result = await orchestrator.runTask(goal);

							if (result.status === "complete") {
								console.log(chalk.green.bold("\n✓ Task complete"));
								if (result.commitSha) {
									console.log(chalk.dim(`  Commit: ${result.commitSha.substring(0, 8)}`));
								}
								console.log(chalk.dim(`  Duration: ${Math.round(result.durationMs / 1000)}s`));
							} else {
								console.log(chalk.red.bold("\n✗ Task failed"));
								if (result.error) {
									console.log(chalk.dim(`  Error: ${result.error}`));
								}
							}
						}
					} catch (error) {
						console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
						process.exit(1);
					}
				},
			);

		// Grind command - autonomous task processing
		program
			.command("grind [goal]")
			.description("Run tasks: pass a goal directly, or process from task board")
			.option("-n, --count <n>", "Process only N tasks then stop", "0")
			.option("-p, --parallel <n>", "Maximum concurrent tasks (1-5)", "1")
			.option("-s, --stream", "Stream agent activity")
			.option("-v, --verbose", "Verbose logging")
			.option("--supervised", "Use supervised mode")
			.option("-m, --model <tier>", "Starting model tier", "sonnet")
			.option("--worker <tier>", "Worker model for supervised mode", "sonnet")
			.option("--no-commit", "Don't auto-commit on success")
			.option("--no-typecheck", "Skip typecheck verification")
			.option("--no-review", "Skip review passes")
			.action(
				async (
					goal: string | undefined,
					options: {
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
					},
				) => {
					const { ParallelSoloOrchestrator } = await import("../parallel-solo.js");

					const maxCount = Number.parseInt(options.count || "0", 10);
					const parallelism = Math.min(5, Math.max(1, Number.parseInt(options.parallel || "1", 10)));

					const orchestrator = new ParallelSoloOrchestrator({
						maxConcurrent: parallelism,
						autoCommit: options.commit !== false,
						stream: options.stream || false,
						verbose: options.verbose || false,
						startingModel: (options.model || "sonnet") as "haiku" | "sonnet" | "opus",
						reviewPasses: options.review !== false,
					});

					// If a goal is passed directly, run it as a single task
					if (goal) {
						output.header("Undercity Grind", "Running task directly");

						try {
							const result = await orchestrator.runParallel([goal]);
							output.summary("Complete", [
								{ label: "Successful", value: result.successful, status: result.successful > 0 ? "good" : "neutral" },
								{ label: "Failed", value: result.failed, status: result.failed > 0 ? "bad" : "neutral" },
								{ label: "Duration", value: `${Math.round(result.durationMs / 1000)}s` },
							]);
						} catch (error) {
							output.error(`Task failed: ${error}`);
							process.exit(1);
						}
						return;
					}

					// No goal provided - process from task board
					output.header("Undercity Grind Mode", "Autonomous operation • Rate limit handling • Infinite processing");

					// Track how many tasks we've processed (for -n flag)
					let tasksProcessed = 0;

					// Check for interrupted batch and offer to resume
					if (orchestrator.hasActiveRecovery()) {
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
								const tasksToResume =
									maxCount > 0 ? recoveryTasks.slice(0, maxCount) : recoveryTasks;

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
						const { getAllItems, markTaskComplete, markTaskFailed } = await import("../task.js");
						const allTasks = getAllItems();
						const pendingTasks = allTasks.filter((q) => q.status === "pending");

						// Account for tasks already processed during recovery
						const remainingCount = maxCount > 0 ? maxCount - tasksProcessed : 0;
						const tasksToProcess =
							maxCount > 0 ? pendingTasks.slice(0, remainingCount) : pendingTasks;

						// Skip if no tasks to process (either none pending or -n limit reached)
						if (tasksToProcess.length === 0) {
							if (pendingTasks.length === 0) {
								output.info("No pending tasks on the task board");
							}
							// If tasksProcessed > 0, we already showed recovery summary
							return;
						}

						const tasks = tasksToProcess.map((q) => q.objective);

						// Build a map of objective -> task ID for status updates
						const objectiveToQuestId = new Map<string, string>();
						for (const q of tasksToProcess) {
							objectiveToQuestId.set(q.objective, q.id);
						}

						const result = await orchestrator.runParallel(tasks);

						// Update task status based on results
						for (const taskResult of result.results) {
							const taskId = objectiveToQuestId.get(taskResult.task);
							if (taskId) {
								if (taskResult.merged) {
									markTaskComplete(taskId);
									output.taskComplete(taskId, "Task merged successfully");
								} else if (taskResult.mergeError || taskResult.result?.status === "failed") {
									const errorMsg = taskResult.mergeError || "Task failed";
									markTaskFailed(taskId, errorMsg);
									output.taskFailed(taskId, "Task failed", errorMsg);
								}
							}
						}

						output.summary("Grind Session Complete", [
							{ label: "Total processed", value: result.results.length + tasksProcessed },
							{ label: "Successful", value: result.successful, status: result.successful > 0 ? "good" : "neutral" },
							{ label: "Failed", value: result.failed, status: result.failed > 0 ? "bad" : "neutral" },
							{ label: "Merged", value: result.merged },
							{ label: "Duration", value: `${Math.round(result.durationMs / 60000)} minutes` },
						]);
					} catch (error) {
						output.error(`Grind error: ${error instanceof Error ? error.message : error}`);
						process.exit(1);
					}
				},
			);

		// Limits command - quick snapshot of usage (use 'watch' for live monitoring)
		program
			.command("limits")
			.description("Show current usage snapshot (use 'watch' for live dashboard)")
			.action(async () => {
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
			});

		// Init command
		program
			.command("init")
			.description("Initialize Undercity state directory")
			.option("-d, --directory <path>", "Custom directory path (default: .undercity)")
			.action((options: { directory?: string }) => {
				const persistence = new Persistence(options.directory);
				persistence.initializeUndercity(options.directory);
				console.log(chalk.green(`✓ Initialized Undercity state directory: ${options.directory || ".undercity"}`));
				console.log(chalk.dim("  Ready to launch sessions and manage tasks"));
			});

		// Setup command
		program
			.command("setup")
			.description("Check authentication setup for Claude Max")
			.action(() => {
				const apiKey = process.env.ANTHROPIC_API_KEY;
				if (apiKey) {
					console.log(chalk.green("✓ ANTHROPIC_API_KEY is set"));
					console.log(chalk.dim(`  Key: ${apiKey.substring(0, 12)}...`));
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
			});

		// Oracle command
		program
			.command("oracle [situation]")
			.description("Draw from the oracle deck for novel insights and fresh perspectives")
			.option("-c, --count <number>", "Number of cards to draw (1-5)", "1")
			.option(
				"-t, --category <type>",
				"Filter by card category: questioning, action, perspective, disruption, exploration",
			)
			.option("--all-categories", "Show all available categories")
			.action(
				(situation: string | undefined, options: { count?: string; category?: string; allCategories?: boolean }) => {
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
				},
			);

		// DSPy readiness command
		program
			.command("dspy-readiness")
			.description("Assess whether DSPy integration would provide value based on current prompt performance")
			.action(async () => {
				console.log(chalk.bold("DSPy Integration Readiness Assessment"));
				console.log();

				// This would analyze prompt performance patterns
				console.log(chalk.yellow("⚠️ This feature requires enhanced metrics collection"));
				console.log(chalk.dim("Future implementation will analyze:"));
				console.log(chalk.dim("  • Prompt consistency across tasks"));
				console.log(chalk.dim("  • Model switching patterns"));
				console.log(chalk.dim("  • Output quality variance"));
				console.log(chalk.dim("  • Optimization opportunities"));
			});

		// Config command
		program
			.command("config")
			.description("Show current configuration from .undercityrc files")
			.option("--init", "Create a sample .undercityrc file in current directory")
			.action(async (options: { init?: boolean }) => {
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
			});

		// Watch command - Matrix-style visualization
		program
			.command("watch")
			.description("Matrix-style TUI dashboard - dense cyberpunk visualization of grind operations")
			.action(async () => {
				try {
					const { launchDashboard } = await import("../dashboard.js");
					launchDashboard();
				} catch (error) {
					console.error(chalk.red("Dashboard failed to start:"), error);
					console.error(chalk.dim("Make sure blessed and blessed-contrib are installed"));
					process.exit(1);
				}
			});

		// Serve command - HTTP daemon for external control
		program
			.command("serve")
			.description("Start HTTP daemon for external control (Claude Code, curl, etc)")
			.option("-p, --port <port>", "Port to listen on", "7331")
			.option("--grind", "Also run grind loop (daemon + grind in one)")
			.action(async (options: { port?: string; grind?: boolean }) => {
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
			});

		// Daemon status/control command
		program
			.command("daemon [action]")
			.description("Check or control the daemon (status, stop)")
			.action(async (action?: string) => {
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
						console.log(
							chalk.dim(`  ${tasks.pending} pending, ${tasks.inProgress} in progress, ${tasks.complete} complete`),
						);
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
			});

		// Experiment command (simplified)
		program
			.command("experiment")
			.description("Run A/B experiments on session configurations")
			.argument("<action>", "Action to perform (list, show, start, analyze)")
			.argument("[idOrTemplate]", "Experiment ID or template name")
			.action(async (action: string, idOrTemplate: string | undefined) => {
				console.log(chalk.bold("Experiment System"));
				console.log(chalk.yellow("⚠️ Experiment functionality not yet implemented"));
				console.log(chalk.dim(`Requested action: ${action}`));
				if (idOrTemplate) {
					console.log(chalk.dim(`Target: ${idOrTemplate}`));
				}
			});

	},
};
