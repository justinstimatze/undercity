/**
 * Dual Logger Module
 *
 * Provides dual logging functionality that writes streaming output to both
 * terminal AND log files. Allows monitoring from other processes.
 *
 * Features:
 * - Writes all streaming output to both console and log file
 * - Log rotation per raid (archived logs are named by raid ID)
 * - Thread-safe log file operations
 * - Maintains current.log as the active log file
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { logger as baseLogger } from "./logger.js";

export class DualLogger {
	private logDir: string;
	private currentLogPath: string;
	private logStream: WriteStream | null = null;
	private isEnabled: boolean = false;

	constructor(baseDir: string = ".undercity") {
		this.logDir = join(baseDir, "logs");
		this.currentLogPath = join(this.logDir, "current.log");
		this.ensureLogDirectory();
	}

	/**
	 * Ensure log directory exists
	 */
	private ensureLogDirectory(): void {
		if (!existsSync(this.logDir)) {
			mkdirSync(this.logDir, { recursive: true });
		}
	}

	/**
	 * Start dual logging for a new raid
	 */
	start(raidId?: string): void {
		this.ensureLogDirectory();

		// If we have an existing log stream, rotate it first
		if (this.logStream) {
			this.rotateCurrentLog();
		}

		// Create new log stream for current.log
		this.logStream = createWriteStream(this.currentLogPath, { flags: "w" });
		this.isEnabled = true;

		// Write header
		const timestamp = new Date().toISOString();
		const header = `=== Undercity Raid Log ===\nStarted: ${timestamp}\n${raidId ? `Raid ID: ${raidId}\n` : ""}${"=".repeat(50)}\n\n`;

		this.writeToLogFile(header);

		// Force flush to ensure file is written
		if (this.logStream) {
			this.logStream.write("", "utf8");
		}

		baseLogger.info({ raidId, logFile: this.currentLogPath }, "Dual logging started");
	}

	/**
	 * Stop dual logging and optionally rotate current log
	 */
	stop(raidId?: string): void {
		if (!this.isEnabled) return;

		const timestamp = new Date().toISOString();
		const footer = `\n${"=".repeat(50)}\nCompleted: ${timestamp}\n=== End Log ===\n`;

		this.writeToLogFile(footer);

		if (this.logStream) {
			this.logStream.end(() => {
				// Rotate log if we have a raid ID (after stream is closed)
				if (raidId) {
					this.rotateCurrentLog(raidId);
				}
			});
			this.logStream = null;
		} else if (raidId) {
			this.rotateCurrentLog(raidId);
		}

		this.isEnabled = false;
		baseLogger.info({ raidId }, "Dual logging stopped");
	}

	/**
	 * Write a message to both console and log file
	 */
	write(message: string): void {
		// Always write to console
		process.stdout.write(message);

		// Also write to log file if enabled (without extra timestamps for streaming output)
		if (this.isEnabled) {
			this.writeToLogFile(message);
		}
	}

	/**
	 * Write a line to both console and log file
	 */
	writeLine(message: string): void {
		this.write(`${message}\n`);
	}

	/**
	 * Write raw content directly to log file (without timestamp)
	 */
	private writeToLogFile(content: string): void {
		if (this.logStream && this.isEnabled) {
			this.logStream.write(content);
		}
	}

	/**
	 * Rotate current.log to an archived name
	 */
	private rotateCurrentLog(raidId?: string): void {
		if (!existsSync(this.currentLogPath)) return;

		try {
			// Generate archive filename
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const archiveName = raidId ? `raid-${raidId}-${timestamp}.log` : `archived-${timestamp}.log`;

			const archivePath = join(this.logDir, archiveName);

			// Move current.log to archive
			renameSync(this.currentLogPath, archivePath);

			baseLogger.info({ archivePath, raidId }, "Log rotated");
		} catch (error) {
			baseLogger.error({ error: String(error) }, "Failed to rotate log");
		}
	}

	/**
	 * Get the current log file path
	 */
	getCurrentLogPath(): string {
		return this.currentLogPath;
	}

	/**
	 * Check if dual logging is currently active
	 */
	isActive(): boolean {
		return this.isEnabled;
	}

	/**
	 * Get recent log entries (last N lines)
	 */
	getRecentEntries(lines: number = 50): string[] {
		if (!existsSync(this.currentLogPath)) return [];

		try {
			const content = readFileSync(this.currentLogPath, "utf-8");
			const allLines = content.split("\n");
			return allLines.slice(-lines).filter((line) => line.trim());
		} catch (error) {
			baseLogger.error({ error: String(error) }, "Failed to read log file");
			return [];
		}
	}
}

// Global singleton instance
export const dualLogger = new DualLogger();
