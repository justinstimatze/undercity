/**
 * Worker Hooks
 *
 * PreToolUse and PostToolUse hooks for agent execution.
 * Used for security auditing and blocking dangerous operations.
 */

import { sessionLogger } from "../logger.js";
import type {
	HookCallbackMatcher,
	SDKHookCallback,
	SDKHookOutput,
	SDKPreToolUseHookInput,
} from "./agent-execution.js";

// Re-export stop hooks for backwards compatibility
export {
	createStandardStopHooks,
	getMaxTurnsForModel,
	type StopHookResult,
	type StopHookState,
} from "./stop-hooks.js";

/**
 * Dangerous bash patterns that should be blocked
 * These patterns could cause system damage if executed
 */
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// Recursive force delete from root
	{ pattern: /rm\s+(-[rf]+\s+)*\/($|\s)/, description: "rm -rf / (delete entire filesystem)" },
	{ pattern: /rm\s+(-[rf]+\s+)+\/\s/, description: "rm with force flags on root" },

	// Direct device writes
	{ pattern: />\s*\/dev\/sd[a-z]/, description: "write to block device" },
	{ pattern: /dd\s+.*of=\/dev\/sd[a-z]/, description: "dd to block device" },

	// Filesystem formatting
	{ pattern: /mkfs\./, description: "filesystem format command" },

	// Fork bombs
	{ pattern: /:\(\)\{\s*:\|:&\s*\};:/, description: "fork bomb" },
	{ pattern: /\$\(.*\).*\|.*\$\(/, description: "potential fork bomb pattern" },

	// System destruction
	{ pattern: />\s*\/dev\/null\s*2>&1\s*<\s*\/dev\/zero/, description: "dev/null overwrite" },

	// Chmod dangerous patterns
	{ pattern: /chmod\s+(-R\s+)?777\s+\/($|\s)/, description: "chmod 777 on root" },

	// Chown dangerous patterns
	{ pattern: /chown\s+(-R\s+)?.*\s+\/($|\s)/, description: "chown on root" },
];

/**
 * Check if a bash command matches any dangerous pattern
 */
export function isDangerousBashCommand(command: string): { isDangerous: boolean; reason?: string } {
	const normalizedCommand = command.trim();

	for (const { pattern, description } of DANGEROUS_BASH_PATTERNS) {
		if (pattern.test(normalizedCommand)) {
			return { isDangerous: true, reason: description };
		}
	}

	return { isDangerous: false };
}

/**
 * PreToolUse hook for auditing bash commands
 *
 * This hook logs all bash commands and blocks dangerous patterns.
 * Enable via `auditBash: true` in .undercityrc
 */
export function createBashAuditHook(taskId: string): SDKHookCallback {
	return async (input, _toolUseID, _options): Promise<SDKHookOutput> => {
		// Only audit Bash tool - check hook event type
		if (input.hook_event_name !== "PreToolUse") {
			return { continue: true };
		}

		const preToolInput = input as SDKPreToolUseHookInput;

		// Only audit Bash tool
		if (preToolInput.tool_name !== "Bash") {
			return { continue: true };
		}

		const toolInput = preToolInput.tool_input as { command?: string } | null;
		const command = toolInput?.command;
		if (!command) {
			return { continue: true };
		}

		// Log all bash commands for audit trail
		sessionLogger.info(
			{
				taskId,
				tool: "Bash",
				command: command.slice(0, 200), // Truncate for logging
			},
			"Bash command audit",
		);

		// Check for dangerous patterns
		const { isDangerous, reason } = isDangerousBashCommand(command);
		if (isDangerous) {
			sessionLogger.error(
				{
					taskId,
					command: command.slice(0, 200),
					reason,
				},
				`BLOCKED: Dangerous bash command detected - ${reason}`,
			);
			return {
				continue: false,
				decision: "block",
				reason: `Blocked dangerous bash command: ${reason}`,
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: `Dangerous pattern detected: ${reason}`,
				},
			};
		}

		return { continue: true };
	};
}

/**
 * Create PreToolUse hooks array for agent execution
 *
 * @param taskId - Current task ID for audit logging
 * @param auditBash - Whether to enable bash auditing
 * @returns Array of PreToolUse hook configurations (SDK-compatible)
 */
export function createPreToolUseHooks(taskId: string, auditBash: boolean): HookCallbackMatcher[] {
	if (!auditBash) {
		return [];
	}

	return [
		{
			hooks: [createBashAuditHook(taskId)],
		},
	];
}
