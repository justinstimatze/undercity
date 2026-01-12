/**
 * Mixed commands (grind, limits, utility commands)
 * Command handlers extracted to mixed-handlers.ts for maintainability
 */

import {
	type ConfigOptions,
	type GrindOptions,
	handleConfig,
	handleDaemon,
	handleDspyReadiness,
	handleGrind,
	handleInit,
	handleLimits,
	handleOracle,
	handleServe,
	handleSetup,
	handleStatus,
	handleWatch,
	type InitOptions,
	type OracleOptions,
	type ServeOptions,
	type StatusOptions,
} from "./mixed-handlers.js";
import type { CommandModule } from "./types.js";

export const mixedCommands: CommandModule = {
	register(program) {
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
			.option("--review", "Enable review passes (disabled by default to save tokens)")
			.option("--no-decompose", "Skip atomicity check and task decomposition")
			.action((goal: string | undefined, options: GrindOptions) => handleGrind(goal, options));

		// Limits command - quick snapshot of usage (use 'watch' for live monitoring)
		program
			.command("limits")
			.description("Show current usage snapshot (use 'watch' for live dashboard)")
			.action(() => handleLimits());

		// Init command - set up undercity in a new topside repo
		program
			.command("init")
			.description("Initialize undercity in a repository (creates .undercity/ and installs Claude skill)")
			.option("-d, --directory <path>", "Custom directory path (default: .undercity)")
			.option("-f, --force", "Overwrite existing skill file")
			.action((options: InitOptions) => handleInit(options));

		// Setup command
		program
			.command("setup")
			.description("Check authentication setup for Claude Max")
			.action(() => handleSetup());

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
			.action((situation: string | undefined, options: OracleOptions) => handleOracle(situation, options));

		// DSPy readiness command
		program
			.command("dspy-readiness")
			.description("Assess whether DSPy integration would provide value based on current prompt performance")
			.action(() => handleDspyReadiness());

		// Config command
		program
			.command("config")
			.description("Show current configuration from .undercityrc files")
			.option("--init", "Create a sample .undercityrc file in current directory")
			.action((options: ConfigOptions) => handleConfig(options));

		// Watch command - Matrix-style visualization
		program
			.command("watch")
			.description("Matrix-style TUI dashboard - dense cyberpunk visualization of grind operations")
			.action(() => handleWatch());

		// Serve command - HTTP daemon for external control
		program
			.command("serve")
			.description("Start HTTP daemon for external control (Claude Code, curl, etc)")
			.option("-p, --port <port>", "Port to listen on", "7331")
			.option("--grind", "Also run grind loop (daemon + grind in one)")
			.action((options: ServeOptions) => handleServe(options));

		// Daemon status/control command
		program
			.command("daemon [action]")
			.description("Check or control the daemon (status, stop)")
			.action((action?: string) => handleDaemon(action));

		// Status command - check grind session status from event log
		program
			.command("status")
			.description("Show current/recent grind status from event log (JSON default for Claude)")
			.option("-n, --count <n>", "Number of recent events to show", "20")
			.option("--human", "Output human-readable format instead of JSON")
			.option("--events", "Show raw events instead of summary")
			.action((options: StatusOptions) => handleStatus(options));
	},
};
