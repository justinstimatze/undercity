/**
 * Orchestrator Git Utilities
 *
 * Shared git utility functions for orchestrator operations.
 * These are kept separate from the main git.ts to avoid circular dependencies.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/**
 * Validate a directory path before executing commands in it
 */
export function validateCwd(cwd: string): void {
	const normalized = normalize(cwd);
	if (!isAbsolute(normalized)) {
		throw new Error(`Invalid cwd: must be absolute path, got ${cwd}`);
	}
	if (!existsSync(normalized)) {
		throw new Error(`Invalid cwd: path does not exist: ${cwd}`);
	}
}

/**
 * Execute a git command in a specific directory (safe from shell injection)
 */
export function execGitInDir(args: string[], cwd: string): string {
	validateCwd(cwd);
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Run a shell command in a specific directory (use only for trusted commands)
 */
export function execInDir(command: string, cwd: string): string {
	validateCwd(cwd);
	return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Validate and sanitize a git ref name (branch, tag, etc.) to prevent injection
 *
 * Returns the validated ref if valid, throws if invalid.
 * This return pattern helps static analyzers track sanitization.
 */
export function validateGitRef(ref: string): string {
	// Git ref names cannot contain: space, ~, ^, :, ?, *, [, \, control chars
	// Also reject shell metacharacters for extra safety
	// Only allow: word chars (\w = [a-zA-Z0-9_]), dots, slashes, hyphens
	if (!/^[\w./-]+$/.test(ref)) {
		throw new Error(`Invalid git ref: ${ref}`);
	}
	return ref;
}
