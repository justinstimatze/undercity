/**
 * Worker Context Builder
 *
 * Re-exports from the centralized prompt-builder module for backward compatibility.
 * All implementations now live in src/prompt-builder.ts.
 */

export {
	buildImplementationContext,
	type ContextBuildConfig,
	type ContextBuildResult,
} from "../prompt-builder.js";
