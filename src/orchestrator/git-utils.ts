/**
 * Orchestrator Git Utilities
 *
 * Shared git utility functions for orchestrator operations.
 * These are kept separate from the main git.ts to avoid circular dependencies.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/**
 * Validate a directory path before executing commands in it
 *
 * Returns the validated path if valid, throws if invalid.
 * This return pattern helps static analyzers track sanitization.
 *
 * Security: Rejects paths starting with '-' to prevent command-line
 * option injection (e.g., --upload-pack attacks in git commands).
 */
export function validateCwd(cwd: string): string {
	// Reject paths starting with '-' to prevent option injection
	if (cwd.startsWith("-")) {
		throw new Error(`Invalid cwd: cannot start with dash: ${cwd}`);
	}
	const normalized = normalize(cwd);
	if (!isAbsolute(normalized)) {
		throw new Error(`Invalid cwd: must be absolute path, got ${cwd}`);
	}
	if (!existsSync(normalized)) {
		throw new Error(`Invalid cwd: path does not exist: ${cwd}`);
	}
	return normalized;
}

/**
 * Execute a git command in a specific directory (safe from shell injection)
 */
export function execGitInDir(args: string[], cwd: string): string {
	const validatedCwd = validateCwd(cwd);
	return execFileSync("git", args, { cwd: validatedCwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Validate and sanitize a git ref name (branch, tag, etc.) to prevent injection
 *
 * Returns the validated ref if valid, throws if invalid.
 * This return pattern helps static analyzers track sanitization.
 *
 * Security: Rejects refs starting with '-' to prevent command-line
 * option injection (e.g., --upload-pack attacks in git commands).
 */
export function validateGitRef(ref: string): string {
	// Reject refs starting with '-' to prevent option injection
	if (ref.startsWith("-")) {
		throw new Error(`Invalid git ref: cannot start with dash: ${ref}`);
	}
	// Git ref names cannot contain: space, ~, ^, :, ?, *, [, \, control chars
	// Also reject shell metacharacters for extra safety
	// Only allow: word chars (\w = [a-zA-Z0-9_]), dots, slashes, hyphens
	if (!/^[\w./-]+$/.test(ref)) {
		throw new Error(`Invalid git ref: ${ref}`);
	}
	return ref;
}
