/**
 * Shared types for command modules
 */
import type { Command } from "commander";

/**
 * Interface for command modules
 */
export interface CommandModule {
	/**
	 * Register this command module with the CLI program
	 */
	register(program: Command): void;
}
