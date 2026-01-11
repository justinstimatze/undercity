/**
 * File Utilities
 *
 * Shared utilities for atomic file operations to prevent status flicker
 * during watch operations and ensure consistency across the codebase.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomically write content to a file using the temp-file-then-rename pattern.
 * This prevents partial reads during watch operations that could cause status flicker.
 *
 * @param filePath - Target file path
 * @param content - Content to write
 * @param options - Write options
 */
export function writeFileAtomic(filePath: string, content: string, options?: { encoding?: BufferEncoding }): void {
	const tempPath = `${filePath}.tmp`;
	const dir = dirname(filePath);

	// Ensure directory exists
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		// Write to temporary file first
		writeFileSync(tempPath, content, {
			encoding: options?.encoding ?? "utf-8",
			flag: "w",
		});

		// Atomically rename temporary file to target file
		// This ensures the file is never in a partially written state
		renameSync(tempPath, filePath);
	} catch (error) {
		// Clean up temporary file if it exists
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		throw error;
	}
}

/**
 * Atomically write content to a file using the temp-file-then-rename pattern (async version).
 * This prevents partial reads during watch operations that could cause status flicker.
 *
 * @param filePath - Target file path
 * @param content - Content to write
 * @param options - Write options
 */
export async function writeFileAtomicAsync(
	filePath: string,
	content: string,
	options?: { encoding?: BufferEncoding },
): Promise<void> {
	const tempPath = `${filePath}.tmp`;
	const dir = dirname(filePath);

	// Ensure directory exists
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		// Write to temporary file first
		await writeFile(tempPath, content, {
			encoding: options?.encoding ?? "utf-8",
			flag: "w",
		});

		// Atomically rename temporary file to target file
		const fs = await import("node:fs/promises");
		await fs.rename(tempPath, filePath);
	} catch (error) {
		// Clean up temporary file if it exists
		if (existsSync(tempPath)) {
			try {
				const fs = await import("node:fs/promises");
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup errors
			}
		}
		throw error;
	}
}

/**
 * Atomically write JSON data to a file.
 * This is a convenience wrapper around writeFileAtomic for JSON data.
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param space - JSON.stringify space parameter (default: 2)
 */
export function writeJsonAtomic<T>(filePath: string, data: T, space?: number): void {
	writeFileAtomic(filePath, JSON.stringify(data, null, space ?? 2));
}

/**
 * Atomically write JSON data to a file (async version).
 * This is a convenience wrapper around writeFileAtomicAsync for JSON data.
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param space - JSON.stringify space parameter (default: 2)
 */
export async function writeJsonAtomicAsync<T>(filePath: string, data: T, space?: number): Promise<void> {
	await writeFileAtomicAsync(filePath, JSON.stringify(data, null, space ?? 2));
}
