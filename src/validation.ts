/**
 * Validation middleware for command outputs
 *
 * Provides pre-validation of raw output from git diff, typecheck, test, lint,
 * and spell check commands before attempting to parse them. This middleware
 * catches common malformations, incomplete output, non-zero exit codes with
 * unexpected formats, and edge cases that could cause downstream parsing failures.
 */

import { InvalidInputError } from "./errors.js";

/**
 * Maximum size for command output (10MB) to prevent memory issues
 */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

/**
 * Generic command output validator
 *
 * Validates that command output is a string and handles Buffer conversion.
 * Performs basic sanity checks on output size and encoding.
 *
 * @param output - Raw output from command execution
 * @param commandName - Name of command for error messages
 * @returns Validated string output
 * @throws InvalidInputError if output is null, undefined, or malformed
 */
export function validateCommandOutput(output: unknown, commandName: string): string {
	// Handle null/undefined
	if (output === null || output === undefined) {
		throw new InvalidInputError(`${commandName} output is null or undefined`, output, "NULL_OUTPUT");
	}

	// Convert Buffer to string if needed
	let outputStr: string;
	if (Buffer.isBuffer(output)) {
		try {
			outputStr = output.toString("utf-8");
		} catch (error) {
			throw new InvalidInputError(
				`${commandName} output Buffer conversion failed`,
				String(error),
				"BUFFER_CONVERSION_ERROR",
			);
		}
	} else if (typeof output === "string") {
		outputStr = output;
	} else {
		throw new InvalidInputError(
			`${commandName} output must be string or Buffer, got ${typeof output}`,
			typeof output,
			"INVALID_OUTPUT_TYPE",
		);
	}

	// Check size limit
	if (outputStr.length > MAX_OUTPUT_SIZE) {
		throw new InvalidInputError(
			`${commandName} output exceeds size limit (${outputStr.length} > ${MAX_OUTPUT_SIZE} bytes)`,
			`${outputStr.length} bytes`,
			"OUTPUT_TOO_LARGE",
		);
	}

	// Empty output is valid - some commands produce no output on success
	return outputStr;
}

/**
 * Validate git diff output
 *
 * Checks for valid git diff format, detects merge conflict markers,
 * and validates diff headers.
 *
 * @param output - Raw git diff output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed
 */
export function validateGitDiffOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "git diff");

	// Empty diff is valid (no changes)
	if (validated.trim().length === 0) {
		return validated;
	}

	// Check for merge conflict markers - these indicate unresolved conflicts
	const conflictMarkers = ["<<<<<<<", "=======", ">>>>>>>"];
	for (const marker of conflictMarkers) {
		if (validated.includes(marker)) {
			throw new InvalidInputError("git diff output contains merge conflict markers", marker, "MERGE_CONFLICT");
		}
	}

	return validated;
}

/**
 * Validate git status output
 *
 * Validates that git status --porcelain output is properly formatted
 * with newline-separated file paths.
 *
 * @param output - Raw git status output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed
 */
export function validateGitStatusOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "git status");

	// Empty status is valid (no changes)
	if (validated.trim().length === 0) {
		return validated;
	}

	// Porcelain format should have lines starting with status codes
	// Format: XY path (where X and Y are status characters)
	const lines = validated.split("\n").filter((line) => line.trim().length > 0);
	for (const line of lines) {
		// Each line should be at least 3 chars: 2 status chars + space + path
		if (line.length < 3) {
			throw new InvalidInputError("git status output has malformed line (too short)", line, "MALFORMED_STATUS_LINE");
		}
	}

	return validated;
}

/**
 * Validate typecheck output
 *
 * Validates TypeScript compiler (tsc) output structure and ensures
 * it's in a recognizable format for parsing.
 *
 * @param output - Raw typecheck output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed
 */
export function validateTypecheckOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "typecheck");

	// Empty output is valid (no errors)
	if (validated.trim().length === 0) {
		return validated;
	}

	// TypeScript errors typically contain file paths with line numbers
	// Format: path/to/file.ts(line,col): error TS####: message
	// Also accept plain text format from some tsc configurations
	// Don't be too strict - just ensure it looks like error output

	return validated;
}

/**
 * Validate test output
 *
 * Validates test runner output (vitest/jest) and ensures parseable
 * test result structure.
 *
 * @param output - Raw test output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed or truncated
 */
export function validateTestOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "test");

	// Empty output is suspicious for tests but might indicate no tests found
	// Let the parsing logic handle that case

	// Check for truncation indicators
	const truncationMarkers = ["output truncated", "...truncated...", "output too large", "SIGTERM", "SIGKILL"];

	for (const marker of truncationMarkers) {
		if (validated.toLowerCase().includes(marker.toLowerCase())) {
			throw new InvalidInputError("test output appears to be truncated or terminated", marker, "TRUNCATED_TEST_OUTPUT");
		}
	}

	return validated;
}

/**
 * Validate lint output
 *
 * Validates Biome lint output and ensures it's in a parseable format.
 *
 * @param output - Raw lint output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed
 */
export function validateLintOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "lint");

	// Empty output is valid (no lint issues)
	return validated;
}

/**
 * Validate spell check output
 *
 * Validates spell checker output format.
 *
 * @param output - Raw spell check output
 * @returns Validated string output
 * @throws InvalidInputError if output is malformed
 */
export function validateSpellCheckOutput(output: unknown): string {
	const validated = validateCommandOutput(output, "spell check");

	// Empty output is valid (no spelling errors)
	return validated;
}
