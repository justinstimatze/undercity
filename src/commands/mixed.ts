/**
 * Mixed commands (grind, limits, utility commands)
 * Command handlers extracted to mixed-handlers.ts for maintainability
 */

import {
	type BriefOptions,
	type ConfigOptions,
	type DecideOptions,
	type EmergencyOptions,
	type GrindOptions,
	handleBrief,
	handleConfig,
	handleDaemon,
	handleDecide,
	handleDrain,
	handleDspyReadiness,
	handleEmergency,
	handleGrind,
	handleHumanInput,
	handleIndex,
	handleInit,
	handleIntrospect,
	handleKnowledge,
	handleLimits,
	handleOracle,
	handlePM,
	handlePulse,
	handleServe,
	handleSetup,
	handleStatus,
	handleTuning,
	handleUsage,
	handleWatch,
	type HumanInputOptions,
	type IndexOptions,
	type InitOptions,
	type IntrospectOptions,
	type KnowledgeOptions,
	type OracleOptions,
	type PMOptions,
	type PulseOptions,
	type ServeOptions,
	type StatusOptions,
	type TuningOptions,
	type UsageOptions,
} from "./mixed-handlers.js";
import type { CommandModule } from "./types.js";

export const mixedCommands: CommandModule = {
	register(program) {
		// Grind command - autonomous task processing
		program
			.command("grind")
			.description("Process tasks from the task board (use 'add' to queue tasks first)")
			.option("-n, --count <n>", "Process only N tasks then stop", "0")
			.option("-p, --parallel <n>", "Maximum concurrent tasks (1-5)", "1")
			.option("-t, --task-id <id>", "Run a specific task by ID")
			.option("-s, --stream", "Stream agent activity")
			.option("-v, --verbose", "Verbose logging")
			.option("-m, --model <tier>", "Starting model tier", "sonnet")
			.option("--no-commit", "Don't auto-commit on success")
			.option("--no-typecheck", "Skip typecheck verification")
			.option("--review", "Enable review passes (disabled by default to save tokens)")
			.option("--no-decompose", "Skip atomicity check and task decomposition")
			.option("--max-attempts <n>", "Maximum attempts per task before failing (default: 3)")
			.option("--max-retries-per-tier <n>", "Maximum fix attempts at same tier before escalating (default: 3)")
			.option("--max-review-passes <n>", "Maximum review passes per tier before escalating (default: 2)")
			.option("--max-opus-review-passes <n>", "Maximum review passes at opus tier (default: 6)")
			.option("--max-decomposition-depth <n>", "Maximum decomposition depth (default: 1, subtasks won't decompose)")
			.option("--max-tier <tier>", "Maximum model tier to escalate to (haiku, sonnet, opus). Default: opus")
			.option("--dry-run", "Show what would execute without running tasks")
			.option("--push", "Push to remote after successful merge (default: off)")
			.option("--duration <time>", "Auto-drain after duration (e.g., 6h, 30m)")
			.option("--postmortem", "Run post-mortem analysis after grind completes")
			.action((options: GrindOptions) => handleGrind(options));

		// Limits command - quick snapshot of usage (use 'watch' for live monitoring)
		// NOTE: Consider using 'status' for session overview or 'watch' for live monitoring
		program
			.command("limits")
			.description("[Deprecated: use 'status'] Show current usage snapshot")
			.action(() => handleLimits());

		// Usage command - fetch Claude Max usage from claude.ai
		program
			.command("usage")
			.description("Fetch Claude Max usage from claude.ai (requires one-time login)")
			.option("--login", "Open browser to log in (saves session for future calls)")
			.option("--clear", "Clear saved browser session")
			.action((options: UsageOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleUsage({ ...options, human: parentOpts.human || options.human });
			});

		// Pulse command - quick state check
		// NOTE: Consider using 'status' for session overview
		program
			.command("pulse")
			.description("[Deprecated: use 'status'] Quick state check with workers and queue")
			.option("-w, --watch", "Live updating (like htop)")
			.action((options: PulseOptions, cmd) => {
				// Inherit --human from parent program if set
				const parentOpts = cmd.parent?.opts() || {};
				handlePulse({ ...options, human: parentOpts.human || options.human });
			});

		// Brief command - narrative summary
		// NOTE: Consider using 'status --events' for recent activity
		program
			.command("brief")
			.description("[Deprecated: use 'status'] Narrative summary of recent activity")
			.option("--hours <n>", "Time window in hours (default: 24)", "24")
			.action((options: BriefOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleBrief({ ...options, human: parentOpts.human || options.human });
			});

		// Decide command - view and resolve pending decisions
		program
			.command("decide")
			.description("View and resolve pending decisions from task execution (JSON default)")
			.option("--resolve <id>", "Resolve a specific decision by ID")
			.option("--decision <text>", "The decision made (required with --resolve)")
			.option("--reasoning <text>", "Reasoning for the decision")
			.action((options: DecideOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleDecide({ ...options, human: parentOpts.human || options.human });
			});

		// Tuning command - view/manage learned routing profile
		program
			.command("tuning")
			.description("View learned model routing profile (self-tuning)")
			.option("--rebuild", "Force rebuild profile from metrics")
			.option("--clear", "Clear learned profile (reset to defaults)")
			.action((options: TuningOptions) => handleTuning(options));

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

		// Drain command - graceful shutdown
		program
			.command("drain")
			.description("Signal grind to finish current tasks and start no more")
			.action(() => handleDrain());

		// Emergency command - manage emergency mode (main branch CI failure handling)
		program
			.command("emergency")
			.description("Manage emergency mode (halts merges when main branch CI fails)")
			.option("--status", "Show emergency mode status (default)")
			.option("--check", "Check main branch health")
			.option("--clear", "Manually clear emergency mode")
			.action((options: EmergencyOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleEmergency({ ...options, human: parentOpts.human || options.human });
			});

		// Status command - check grind session status from event log
		program
			.command("status")
			.description("Show current/recent grind status from event log (JSON default for Claude)")
			.option("-n, --count <n>", "Number of recent events to show", "20")
			.option("--human", "Output human-readable format instead of JSON")
			.option("--events", "Show raw events instead of summary")
			.action((options: StatusOptions) => handleStatus(options));

		// Index command - build/update AST index for smart context
		program
			.command("index")
			.description("Build or update AST index for smart context selection")
			.option("-f, --full", "Full rebuild (instead of incremental update)")
			.option("-s, --stats", "Show index statistics only")
			.option("--summaries", "Show file summaries")
			.action((options: IndexOptions) => handleIndex(options));

		// Introspect command - analyze own metrics and performance
		// NOTE: Consider using 'metrics' for overview, 'insights' for recommendations
		program
			.command("introspect")
			.description("[See also: metrics, insights] Self-analysis with success rates and routing")
			.option("-j, --json", "Output raw JSON for agent consumption")
			.option("-n, --limit <n>", "Only analyze last N task records")
			.option("--since <date>", "Only analyze records since date (YYYY-MM-DD)")
			.option("-p, --patterns", "Show task pattern analysis (keyword clustering)")
			.action((options: IntrospectOptions) => handleIntrospect(options));

		// Knowledge command - search accumulated learnings
		program
			.command("knowledge [query]")
			.description("Search accumulated learnings from task execution (JSON default)")
			.option("--stats", "Show knowledge base statistics")
			.option("--all", "List all learnings (not just search results)")
			.option("-n, --limit <n>", "Limit number of results (default: 10 for search, 50 for --all)")
			.action((query: string | undefined, options: KnowledgeOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleKnowledge(query, { ...options, human: parentOpts.human || options.human });
			});

		// PM command - proactive product management (ideation, research, task generation)
		program
			.command("pm [topic]")
			.description("Proactive PM: research topics and generate task proposals")
			.option("--research", "Research a topic via web search")
			.option("--propose", "Generate task proposals from codebase analysis")
			.option("--ideate", "Full ideation session: research + propose (default)")
			.option("--add", "Add proposed tasks to the board (requires confirmation)")
			.action((topic: string | undefined, options: PMOptions) => handlePM(topic, options));

		// Human-input command - provide guidance for recurring failures
		program
			.command("human-input")
			.description("Manage human guidance for recurring task failures (breaks retry loops)")
			.option("--list", "List tasks needing human input (default)")
			.option("--provide <signature>", "Provide guidance for an error signature")
			.option("--guidance <text>", "The guidance text (used with --provide)")
			.option("--stats", "Show human input tracking statistics")
			.action((options: HumanInputOptions, cmd) => {
				const parentOpts = cmd.parent?.opts() || {};
				handleHumanInput({ ...options, human: parentOpts.human || options.human });
			});
	},
};
