/**
 * Mixed commands (solo, grind, utility, experiment commands)
 * These are combined due to their varied nature and to complete the refactoring efficiently.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { getConfigSource, loadConfig, mergeWithConfig } from "../config.js";
import { UndercityOracle } from "../oracle.js";
import { Persistence } from "../persistence.js";
import type { CommandModule } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get version from package.json
function getVersion(): string {
	try {
		const pkgPath = join(__dirname, "..", "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.1.0";
	} catch {
		return "0.1.0";
	}
}

export const mixedCommands: CommandModule = {
	register(program) {
		// Solo command - light mode with verification and adaptive escalation
		program
			.command("solo <goal>")
			.description("Light mode: run a single task with verification and adaptive escalation")
			.option("-s, --stream", "Stream raider activity")
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
					// Merge CLI options with config file defaults
					const options = mergeWithConfig(cliOptions);

					// Dynamic import to avoid loading heavy modules until needed
					const { SoloOrchestrator, SupervisedOrchestrator } = await import("../solo.js");

					console.log(chalk.cyan.bold("\n⚡ Undercity Solo Mode"));
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

		// Grind command - autonomous quest processing
		program
			.command("grind")
			.description("Process quest board continuously (autonomous, handles rate limits, can run for hours)")
			.option("-n, --count <n>", "Process only N quests then stop", "0")
			.option("-p, --parallel <n>", "Maximum concurrent quests (1-5)", "1")
			.option("-s, --stream", "Stream raider activity")
			.option("-v, --verbose", "Verbose logging")
			.option("--supervised", "Use supervised mode")
			.option("-m, --model <tier>", "Starting model tier", "sonnet")
			.option("--worker <tier>", "Worker model for supervised mode", "sonnet")
			.option("--no-commit", "Don't auto-commit on success")
			.option("--no-typecheck", "Skip typecheck verification")
			.option("--no-review", "Skip review passes")
			.action(
				async (options: {
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
				}) => {
					console.log(chalk.cyan.bold("\n⚙️ Undercity Grind Mode"));
					console.log(chalk.dim("  Autonomous operation • Rate limit handling • Infinite processing"));
					console.log();

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

					try {
						// Get tasks from quest board
						const { getAllItems } = await import("../quest.js");
						const allQuests = getAllItems();
						const pendingQuests = allQuests.filter((q) => q.status === "pending");

						const questsToProcess = maxCount > 0 ? pendingQuests.slice(0, maxCount) : pendingQuests;
						const tasks = questsToProcess.map((q) => q.objective);

						const result = await orchestrator.runParallel(tasks);

						console.log(chalk.green.bold("\n📊 Grind Session Complete"));
						console.log(`  Total processed: ${result.results.length}`);
						console.log(`  Successful: ${result.successful}`);
						console.log(`  Failed: ${result.failed}`);
						console.log(`  Merged: ${result.merged}`);
						console.log(`  Duration: ${Math.round(result.durationMs / 60000)} minutes`);
					} catch (error) {
						console.error(chalk.red(`Grind error: ${error instanceof Error ? error.message : error}`));
						process.exit(1);
					}
				},
			);

		// Init command
		program
			.command("init")
			.description("Initialize Undercity state directory")
			.option("-d, --directory <path>", "Custom directory path (default: .undercity)")
			.action((options: { directory?: string }) => {
				const persistence = new Persistence(options.directory);
				persistence.initializeUndercity(options.directory);
				console.log(chalk.green(`✓ Initialized Undercity state directory: ${options.directory || ".undercity"}`));
				console.log(chalk.dim("  Ready to launch raids and manage quests"));
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

		// History command
		program
			.command("history")
			.description("Show completed raids from the stash")
			.option("-n, --count <n>", "Number of raids to show", "10")
			.action((options: { count?: string }) => {
				console.log(chalk.bold("Recent Raids"));
				console.log(chalk.gray("History functionality not yet implemented"));
				console.log(chalk.dim("This will show completed raids from the stash"));
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
						const cards = oracle.drawSpread(count, options.category as any);

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

		// Dashboard command
		program
			.command("dashboard")
			.description("Live TUI dashboard with status display and streaming logs")
			.option("-r, --refresh <ms>", "Refresh interval in milliseconds", "1000")
			.action(async (options: { refresh?: string }) => {
				const refreshInterval = Number.parseInt(options.refresh || "1000", 10);

				console.log(chalk.cyan("Starting Undercity Dashboard..."));
				console.log(chalk.dim(`Refresh interval: ${refreshInterval}ms`));

				try {
					const { startDashboard } = await import("../tui-dashboard.js");
					await startDashboard({ refreshInterval });
				} catch (error) {
					console.error(chalk.red("Dashboard failed to start:"), error);
					process.exit(1);
				}
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

		// Experiment command (simplified)
		program
			.command("experiment")
			.description("Run A/B experiments on raid configurations")
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

		// Quick Ollama test
		program
			.command("quick-ollama-test")
			.description("Run a quick Ollama vs Haiku diff generation test")
			.action(async () => {
				console.log("🧪 Running quick Ollama experiment...");

				try {
					const { runQuickOllamaExperiment } = await import("../diff-experiment-runner.js");
					const experimentId = await runQuickOllamaExperiment();
					console.log(`✅ Quick experiment completed: ${experimentId}`);
					console.log(`Use 'undercity experiment show ${experimentId}' to see results`);
				} catch (error) {
					console.error(`❌ Quick experiment failed: ${error}`);
				}
			});
	},
};
