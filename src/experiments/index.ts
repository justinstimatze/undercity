/**
 * Experimentation Framework Main Export
 */

export * from "./cli.js";
export * from "./examples.js";
export * from "./framework.js";
export * from "./integration.js";
export * from "./types.js";

// Convenience function to create a new experiment framework instance
export function createExperimentFramework(storagePath?: string) {
	return new ExperimentFramework(storagePath);
}

// Convenience function to create experiment CLI
export function createExperimentCLI(storagePath?: string) {
	return new ExperimentCLI(storagePath);
}

import { ExperimentCLI } from "./cli.js";
import { ExperimentFramework } from "./framework.js";
