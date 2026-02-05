#!/usr/bin/env node

// Initializes and configures the Undercity CLI, registering command modules and setting up the base command structure.

/**
 * Undercity CLI - Main Entry Point
 *
 * Comprehensive command-line interface for Undercity, a multi-agent orchestrator for Claude Max.
 * Provides AI-driven development workflows with automated session management, task tracking, parallel
 * processing capabilities, and strategic planning utilities. The tool coordinates multiple AI agents
 * to execute complex development tasks with minimal human intervention.
 *
 * Core Features:
 * - Session Management: Automated planning, execution, and extraction of development tasks
 * - Task Tracking: Persistent task queues with priority management and dependency resolution
 * - Parallel Processing: Multi-agent coordination for concurrent task execution
 * - Strategic Planning: AI-powered planning with human approval workflows
 * - State Persistence: Crash-resistant state management across sessions
 * - Merge Orchestration: Automated git workflows with conflict resolution
 * - Oracle Insights: Oblique strategy cards for creative problem-solving
 *
 * Multi-agent orchestrator for Claude Max - Gas Town for normal people.
 */

// Handle EPIPE gracefully - occurs when piping to head/tail/etc and they close early
// e.g., `undercity tasks --all | head` would crash without this
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") {
		process.exit(0);
	}
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") {
		process.exit(0);
	}
	throw err;
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { analysisCommands } from "./commands/analysis.js";
import { experimentCommands } from "./commands/experiment.js";
import { mixedCommands } from "./commands/mixed.js";
import { ragCommands } from "./commands/rag.js";
import { taskCommands } from "./commands/task.js";
import { configureOutput, type OutputMode } from "./output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get version from package.json
function getVersion(): string {
	try {
		const pkgPath = join(__dirname, "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.1.0";
	} catch {
		return "0.1.0";
	}
}

// Create the CLI program
const program = new Command();

program
	.name("undercity")
	.description("Multi-agent orchestrator for autonomous task execution")
	.version(getVersion())
	.option("--human", "Human-readable output (default: structured JSON for agents)")
	.option("--agent", "Structured JSON output (default when not a TTY)")
	.hook("preAction", () => {
		// Configure output mode based on global flags
		const opts = program.opts();
		if (opts.human) {
			configureOutput({ mode: "human" as OutputMode });
		} else if (opts.agent) {
			configureOutput({ mode: "agent" as OutputMode });
		}
		// Otherwise auto-detect (done in output.ts)
	});

// Register all command modules
taskCommands.register(program);
analysisCommands.register(program);
experimentCommands.register(program);
mixedCommands.register(program);
ragCommands.register(program);

/**
 * Determines if an error is recoverable (user error) or non-recoverable (system failure).
 *
 * Exit code convention:
 * - Exit code 1: Recoverable errors (user errors, invalid input, missing arguments, validation failures)
 * - Exit code 2: Non-recoverable errors (system failures, unexpected exceptions, internal bugs)
 * - Exit code 0: Success (handled automatically by Commander.js)
 *
 * @param error - The error to classify
 * @returns Exit code 1 for recoverable errors, 2 for non-recoverable errors
 *
 * @example
 * ```typescript
 * // User provides invalid flag → exit 1
 * undercity grind --invalid-flag
 *
 * // Missing required argument → exit 1
 * undercity add
 *
 * // System error (out of memory, permission denied) → exit 2
 * undercity grind  // when system resources exhausted
 * ```
 */
function getExitCode(error: unknown): 1 | 2 {
	// Commander.js errors (invalid commands, missing arguments, unknown options)
	// These are always user errors → exit 1
	if (error && typeof error === "object" && "code" in error) {
		const errCode = (error as { code: string }).code;
		if (
			errCode === "commander.unknownCommand" ||
			errCode === "commander.missingArgument" ||
			errCode === "commander.unknownOption" ||
			errCode === "commander.invalidArgument" ||
			errCode === "commander.excessArguments"
		) {
			return 1;
		}
	}

	// Custom validation errors from command handlers
	if (error instanceof Error) {
		const name = error.name;
		if (name === "ValidationError" || name === "InvalidInputError" || name === "UserError") {
			return 1;
		}
	}

	// All other errors are system failures → exit 2
	// Includes: TypeError, ReferenceError, RangeError, system errors, unexpected exceptions
	return 2;
}

// Parse and run with proper exit code mapping
// Use parseAsync() to handle async command handlers properly
(async () => {
	try {
		await program.parseAsync();
	} catch (error: unknown) {
		const exitCode = getExitCode(error);
		const message = error instanceof Error ? error.message : String(error);

		// Log to stderr before exiting
		process.stderr.write(`Error: ${message}\n`);

		process.exit(exitCode);
	}
})();
