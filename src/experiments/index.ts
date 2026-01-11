/**
 * Experimentation Framework Main Export
 */

export * from "./types.js";
export * from "./framework.js";
export * from "./integration.js";
export * from "./examples.js";
export * from "./cli.js";
export * from "./diff-generator.js";

// Convenience function to create a new experiment framework instance
export function createExperimentFramework(storagePath?: string) {
  return new ExperimentFramework(storagePath);
}

// Convenience function to create experiment CLI
export function createExperimentCLI(storagePath?: string) {
  return new ExperimentCLI(storagePath);
}

import { ExperimentFramework } from "./framework.js";
import { QuestExperimentIntegrator } from "./integration.js";
import { ExperimentCLI } from "./cli.js";