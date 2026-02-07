/**
 * Worker Prompt Builder
 *
 * Re-exports from the centralized prompt-builder module for backward compatibility.
 * All implementations now live in src/prompt-builder.ts.
 */

export {
	type BuildResearchPromptOptions,
	buildMetaTaskPrompt,
	buildResearchPrompt,
	buildResumePrompt,
	formatTicketContext,
	type PromptBuildResult,
	type ResearchPromptResult,
} from "../prompt-builder.js";
