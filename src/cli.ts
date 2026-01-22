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

// Parse and run
program.parse();
