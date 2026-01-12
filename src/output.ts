/**
 * Unified Output System
 *
 * Provides consistent output formatting across the codebase:
 * - Human mode: Concise, progress-focused terminal output
 * - Agent mode: Structured JSON for machine parsing (default)
 *
 * Auto-detects TTY to choose mode, but can be overridden with --human flag.
 */

import chalk from "chalk";

export type OutputMode = "human" | "agent";

/**
 * Structured event for agent-mode JSON output
 */
export interface OutputEvent {
	type:
		| "info"
		| "success"
		| "error"
		| "warning"
		| "progress"
		| "status"
		| "task_start"
		| "task_complete"
		| "task_failed"
		| "metrics"
		| "debug"
		// Worker-level events for real-time reporting
		| "worker_phase"
		| "worker_attempt"
		| "worker_verification"
		| "worker_escalation"
		| "worker_review";
	message: string;
	timestamp: string;
	data?: Record<string, unknown>;
}

/**
 * Progress state for human-readable progress display
 */
interface ProgressState {
	current: number;
	total: number;
	label: string;
}

/**
 * Output configuration
 */
interface OutputConfig {
	mode: OutputMode;
	verbose: boolean;
}

// Global configuration - can be set once at startup
const globalConfig: OutputConfig = {
	mode: detectMode(),
	verbose: false,
};

/**
 * Auto-detect output mode based on environment
 * - TTY (interactive terminal) → human mode
 * - Non-TTY (piped, CI, agent) → agent mode (JSON)
 */
function detectMode(): OutputMode {
	// Check for explicit flags first
	if (process.env.UNDERCITY_OUTPUT === "human") return "human";
	if (process.env.UNDERCITY_OUTPUT === "agent") return "agent";

	// Check CLI args for --human flag
	if (process.argv.includes("--human")) return "human";

	// Auto-detect: TTY → human, otherwise agent (JSON)
	return process.stdout.isTTY ? "human" : "agent";
}

/**
 * Configure the output system
 */
export function configureOutput(config: Partial<OutputConfig>): void {
	if (config.mode !== undefined) {
		globalConfig.mode = config.mode;
	}
	if (config.verbose !== undefined) {
		globalConfig.verbose = config.verbose;
	}
}

/**
 * Get current output mode
 */
export function getOutputMode(): OutputMode {
	return globalConfig.mode;
}

/**
 * Check if human mode is active
 */
export function isHumanMode(): boolean {
	return globalConfig.mode === "human";
}

/**
 * Output a structured event (JSON in agent mode, formatted in human mode)
 */
function outputEvent(event: OutputEvent): void {
	if (globalConfig.mode === "agent") {
		// Agent mode: single-line JSON per event
		console.log(JSON.stringify(event));
	} else {
		// Human mode: formatted output
		const prefix = getHumanPrefix(event.type);
		if (event.data && globalConfig.verbose) {
			console.log(`${prefix} ${event.message}`, event.data);
		} else {
			console.log(`${prefix} ${event.message}`);
		}
	}
}

/**
 * Get human-readable prefix for event types
 */
function getHumanPrefix(type: OutputEvent["type"]): string {
	switch (type) {
		case "success":
			return chalk.green("✓");
		case "error":
			return chalk.red("✗");
		case "warning":
			return chalk.yellow("⚠");
		case "progress":
			return chalk.cyan("→");
		case "task_start":
			return chalk.cyan("▶");
		case "task_complete":
			return chalk.green("✓");
		case "task_failed":
			return chalk.red("✗");
		case "metrics":
			return chalk.blue("📊");
		case "debug":
			return chalk.dim("·");
		// Worker-level events
		case "worker_phase":
			return chalk.cyan("  │");
		case "worker_attempt":
			return chalk.cyan("  ├─");
		case "worker_verification":
			return chalk.cyan("  │ ");
		case "worker_escalation":
			return chalk.yellow("  ↑");
		case "worker_review":
			return chalk.magenta("  ◆");
		case "status":
		case "info":
		default:
			return chalk.dim("•");
	}
}

/**
 * Create timestamp for events
 */
function now(): string {
	return new Date().toISOString();
}

// =============================================================================
// Public API - Semantic output functions
// =============================================================================

/**
 * Output an informational message
 */
export function info(message: string, data?: Record<string, unknown>): void {
	outputEvent({ type: "info", message, timestamp: now(), data });
}

/**
 * Output a success message
 */
export function success(message: string, data?: Record<string, unknown>): void {
	outputEvent({ type: "success", message, timestamp: now(), data });
}

/**
 * Output an error message
 */
export function error(message: string, data?: Record<string, unknown>): void {
	outputEvent({ type: "error", message, timestamp: now(), data });
}

/**
 * Output a warning message
 */
export function warning(message: string, data?: Record<string, unknown>): void {
	outputEvent({ type: "warning", message, timestamp: now(), data });
}

/**
 * Output a progress update
 */
export function progress(message: string, state?: ProgressState, data?: Record<string, unknown>): void {
	const progressData = state ? { ...data, progress: state } : data;
	outputEvent({ type: "progress", message, timestamp: now(), data: progressData });
}

/**
 * Output a status message
 */
export function status(message: string, data?: Record<string, unknown>): void {
	outputEvent({ type: "status", message, timestamp: now(), data });
}

/**
 * Output task start notification
 */
export function taskStart(taskId: string, description: string, data?: Record<string, unknown>): void {
	outputEvent({
		type: "task_start",
		message: description,
		timestamp: now(),
		data: { taskId, ...data },
	});
}

/**
 * Output task completion notification
 */
export function taskComplete(taskId: string, message: string, data?: Record<string, unknown>): void {
	outputEvent({
		type: "task_complete",
		message,
		timestamp: now(),
		data: { taskId, ...data },
	});
}

/**
 * Output task failure notification
 */
export function taskFailed(
	taskId: string,
	message: string,
	errorDetails?: string,
	data?: Record<string, unknown>,
): void {
	outputEvent({
		type: "task_failed",
		message,
		timestamp: now(),
		data: { taskId, error: errorDetails, ...data },
	});
}

/**
 * Output metrics/statistics
 */
export function metrics(message: string, data: Record<string, unknown>): void {
	outputEvent({ type: "metrics", message, timestamp: now(), data });
}

/**
 * Output debug information (only in verbose mode)
 */
export function debug(message: string, data?: Record<string, unknown>): void {
	if (globalConfig.verbose) {
		outputEvent({ type: "debug", message, timestamp: now(), data });
	}
}

// =============================================================================
// Worker-level event functions for real-time reporting
// =============================================================================

/**
 * Output worker phase change (analyzing, executing, verifying, etc.)
 */
export function workerPhase(
	taskId: string,
	phase: "analyzing" | "executing" | "verifying" | "committing" | "reviewing" | "parsing",
	data?: Record<string, unknown>,
): void {
	const phaseMessages: Record<string, string> = {
		analyzing: "Analyzing task complexity...",
		executing: "Executing with agent...",
		verifying: "Running verification...",
		committing: "Committing changes...",
		reviewing: "Running review passes...",
		parsing: "Parsing result...",
	};
	outputEvent({
		type: "worker_phase",
		message: phaseMessages[phase] || phase,
		timestamp: now(),
		data: { taskId, phase, ...data },
	});
}

/**
 * Output worker attempt information
 */
export function workerAttempt(
	taskId: string,
	attempt: number,
	maxAttempts: number,
	model: string,
	data?: Record<string, unknown>,
): void {
	outputEvent({
		type: "worker_attempt",
		message: `Attempt ${attempt}/${maxAttempts} (${model})`,
		timestamp: now(),
		data: { taskId, attempt, maxAttempts, model, ...data },
	});
}

/**
 * Output worker verification result
 */
export function workerVerification(
	taskId: string,
	passed: boolean,
	issues?: string[],
	data?: Record<string, unknown>,
): void {
	const message = passed ? "Verification passed" : `Verification failed: ${issues?.join(", ") || "unknown"}`;
	outputEvent({
		type: "worker_verification",
		message,
		timestamp: now(),
		data: { taskId, passed, issues, ...data },
	});
}

/**
 * Output worker escalation event
 */
export function workerEscalation(taskId: string, fromModel: string, toModel: string, reason?: string): void {
	outputEvent({
		type: "worker_escalation",
		message: `Escalating: ${fromModel} → ${toModel}${reason ? ` (${reason})` : ""}`,
		timestamp: now(),
		data: { taskId, fromModel, toModel, reason },
	});
}

/**
 * Output worker review event
 */
export function workerReview(
	taskId: string,
	tier: string,
	pass: number,
	maxPasses: number,
	result: "passed" | "fixing" | "escalating",
): void {
	const messages: Record<string, string> = {
		passed: `Review ${pass}/${maxPasses} (${tier}): passed`,
		fixing: `Review ${pass}/${maxPasses} (${tier}): fixing issues...`,
		escalating: `Review ${pass}/${maxPasses} (${tier}): escalating`,
	};
	outputEvent({
		type: "worker_review",
		message: messages[result],
		timestamp: now(),
		data: { taskId, tier, pass, maxPasses, result },
	});
}

// =============================================================================
// Human-only formatting helpers
// =============================================================================

/**
 * Print a header/banner (human mode only)
 */
export function header(title: string, subtitle?: string): void {
	if (globalConfig.mode === "human") {
		console.log();
		console.log(chalk.cyan.bold(`⚡ ${title}`));
		if (subtitle) {
			console.log(chalk.dim(`  ${subtitle}`));
		}
		console.log();
	} else {
		outputEvent({
			type: "info",
			message: title,
			timestamp: now(),
			data: subtitle ? { subtitle } : undefined,
		});
	}
}

/**
 * Print a section divider (human mode only)
 */
export function section(title: string): void {
	if (globalConfig.mode === "human") {
		console.log(chalk.cyan(`\n━━━ ${title} ━━━\n`));
	} else {
		outputEvent({ type: "status", message: title, timestamp: now() });
	}
}

/**
 * Print a summary block
 */
export function summary(
	title: string,
	items: Array<{ label: string; value: string | number; status?: "good" | "bad" | "neutral" }>,
): void {
	if (globalConfig.mode === "human") {
		console.log(chalk.bold(`\n${title}`));
		for (const item of items) {
			const statusColor = item.status === "good" ? chalk.green : item.status === "bad" ? chalk.red : chalk.white;
			console.log(`  ${item.label}: ${statusColor(String(item.value))}`);
		}
		console.log();
	} else {
		const data: Record<string, unknown> = {};
		for (const item of items) {
			data[item.label] = item.value;
		}
		outputEvent({ type: "metrics", message: title, timestamp: now(), data });
	}
}

/**
 * Print a simple key-value pair
 */
export function keyValue(key: string, value: string | number | boolean): void {
	if (globalConfig.mode === "human") {
		console.log(`  ${chalk.dim(key + ":")} ${value}`);
	} else {
		outputEvent({ type: "info", message: `${key}: ${value}`, timestamp: now(), data: { [key]: value } });
	}
}

/**
 * Print a list of items
 */
export function list(items: string[], prefix: string = "•"): void {
	if (globalConfig.mode === "human") {
		for (const item of items) {
			console.log(`  ${chalk.dim(prefix)} ${item}`);
		}
	} else {
		outputEvent({ type: "info", message: "list", timestamp: now(), data: { items } });
	}
}

// =============================================================================
// Progress tracking for long operations
// =============================================================================

/**
 * Create a progress tracker for batch operations
 */
export function createProgressTracker(total: number, label: string): ProgressTracker {
	return new ProgressTracker(total, label);
}

class ProgressTracker {
	private current = 0;
	private startTime = Date.now();

	constructor(
		private total: number,
		private label: string,
	) {
		if (globalConfig.mode === "human") {
			this.render();
		}
	}

	increment(message?: string): void {
		this.current++;
		if (globalConfig.mode === "human") {
			this.render(message);
		} else {
			progress(message || this.label, {
				current: this.current,
				total: this.total,
				label: this.label,
			});
		}
	}

	complete(message?: string): void {
		this.current = this.total;
		const duration = Date.now() - this.startTime;
		if (globalConfig.mode === "human") {
			const finalMessage = message || `${this.label} complete`;
			console.log(`\r${chalk.green("✓")} ${finalMessage} (${Math.round(duration / 1000)}s)`);
		} else {
			success(message || `${this.label} complete`, {
				durationMs: duration,
				total: this.total,
			});
		}
	}

	private render(message?: string): void {
		const percent = Math.round((this.current / this.total) * 100);
		const elapsed = Math.round((Date.now() - this.startTime) / 1000);
		const display = message || this.label;
		const truncated = display.length > 40 ? `${display.substring(0, 37)}...` : display;
		process.stdout.write(`\r${chalk.cyan("→")} ${truncated} [${this.current}/${this.total}] ${percent}% (${elapsed}s)`);
	}
}

// =============================================================================
// Backward compatibility - chalk wrapper for gradual migration
// =============================================================================

/**
 * Wrap legacy chalk.* calls to work with both modes
 * Use this during migration from direct console.log + chalk usage
 */
export const compat = {
	log: (message: string): void => {
		if (globalConfig.mode === "human") {
			console.log(message);
		} else {
			// Strip ANSI codes for agent mode
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional - stripping ANSI escape sequences
			const stripped = message.replace(/\x1b\[[0-9;]*m/g, "");
			outputEvent({ type: "info", message: stripped, timestamp: now() });
		}
	},
};
