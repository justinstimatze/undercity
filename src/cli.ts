#!/usr/bin/env node

/**
 * Undercity CLI - Main Entry Point
 *
 * Comprehensive command-line interface for Undercity, a multi-raider orchestrator for Claude Max.
 * Provides AI-driven development workflows with automated raid management, task tracking, parallel
 * processing capabilities, and strategic planning utilities. The tool coordinates multiple AI agents
 * to execute complex development tasks with minimal human intervention.
 *
 * Core Features:
 * - Raid Management: Automated planning, execution, and extraction of development tasks
 * - Task Tracking: Persistent task queues with priority management and dependency resolution
 * - Parallel Processing: Multi-agent coordination for concurrent task execution
 * - Strategic Planning: AI-powered planning with human approval workflows
 * - State Persistence: Crash-resistant state management across sessions
 * - Merge Orchestration: Automated git workflows with conflict resolution
 * - Oracle Insights: Oblique strategy cards for creative problem-solving
 *
 * Multi-raider orchestrator for Claude Max - Gas Town for normal people.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { analysisCommands } from "./commands/analysis.js";
import { mixedCommands } from "./commands/mixed.js";
import { taskCommands } from "./commands/task.js";

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
	.description("Multi-raider orchestrator for Claude Max - Gas Town for budget extraction")
	.version(getVersion());

// Register all command modules
taskCommands.register(program);
analysisCommands.register(program);
mixedCommands.register(program);

// Parse and run
program.parse();
