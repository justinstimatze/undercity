/**
 * Squad Module
 *
 * Defines the agent types and manages the squad of agents.
 *
 * Agent Types:
 * - Scout: Fast codebase reconnaissance (Haiku, read-only)
 * - Planner: BMAD-style spec writer (Sonnet, read-only, fast iteration)
 * - Builder: Code builder (Sonnet, full access, fast + quality)
 * - Reviewer: Quality reviewer with Rule of Five (Opus, read + tests)
 *
 * Based on Claude Agent SDK's AgentDefinition type.
 *
 * Includes structured delegation prompts inspired by Sisyphus (oh-my-opencode):
 * - 7-section format: TASK, EXPECTED OUTCOME, REQUIRED SKILLS, REQUIRED TOOLS,
 *   MUST DO, MUST NOT DO, CONTEXT
 * - Clear boundaries for subagent work
 * - Explicit tool whitelists
 */

import type { Agent, AgentDefinition, AgentType, Step } from "./types.js";

/**
 * Structured delegation prompt format (inspired by Sisyphus)
 *
 * This 7-section format ensures clear, unambiguous task delegation.
 * Each section serves a specific purpose:
 * - TASK: What to accomplish (atomic goal)
 * - EXPECTED OUTCOME: What success looks like
 * - REQUIRED SKILLS: Domain knowledge needed
 * - REQUIRED TOOLS: Explicit tool whitelist
 * - MUST DO: Exhaustive requirements
 * - MUST NOT DO: Forbidden behaviors
 * - CONTEXT: Constraints, patterns, dependencies
 */
export interface DelegationPrompt {
	/** Atomic goal - what to accomplish */
	task: string;
	/** What success looks like */
	expectedOutcome: string;
	/** Domain knowledge needed */
	requiredSkills?: string[];
	/** Explicit tool whitelist */
	requiredTools: string[];
	/** Exhaustive requirements */
	mustDo: string[];
	/** Forbidden behaviors */
	mustNotDo: string[];
	/** Constraints, patterns, dependencies */
	context?: string;
}

/**
 * Build a structured delegation prompt string from a DelegationPrompt object
 */
export function buildDelegationPrompt(prompt: DelegationPrompt): string {
	const sections: string[] = [];

	sections.push(`## TASK\n${prompt.task}`);
	sections.push(`## EXPECTED OUTCOME\n${prompt.expectedOutcome}`);

	if (prompt.requiredSkills && prompt.requiredSkills.length > 0) {
		sections.push(`## REQUIRED SKILLS\n${prompt.requiredSkills.map((s) => `- ${s}`).join("\n")}`);
	}

	sections.push(`## REQUIRED TOOLS\n${prompt.requiredTools.map((t) => `- ${t}`).join("\n")}`);
	sections.push(`## MUST DO\n${prompt.mustDo.map((r) => `- ${r}`).join("\n")}`);
	sections.push(`## MUST NOT DO\n${prompt.mustNotDo.map((r) => `- ${r}`).join("\n")}`);

	if (prompt.context) {
		sections.push(`## CONTEXT\n${prompt.context}`);
	}

	return sections.join("\n\n");
}

/**
 * Create a delegation prompt for exploration tasks
 */
export function createExplorationPrompt(goal: string, focusAreas?: string[]): DelegationPrompt {
	return {
		task: `Explore the codebase to understand: ${goal}`,
		expectedOutcome: "A structured report of findings including relevant files, patterns, and potential challenges",
		requiredSkills: ["Code navigation", "Pattern recognition"],
		requiredTools: ["Read", "Grep", "Glob"],
		mustDo: [
			"Search for relevant files using Glob patterns",
			"Read key files to understand structure",
			"Identify existing patterns and conventions",
			"Report findings in structured format",
			...(focusAreas ? [`Focus on: ${focusAreas.join(", ")}`] : []),
		],
		mustNotDo: [
			"Modify any files",
			"Execute commands that change state",
			"Make implementation decisions",
			"Spend more than 5 minutes on exploration",
		],
	};
}

/**
 * Create a delegation prompt for implementation tasks
 */
export function createImplementationPrompt(
	task: string,
	spec: string,
	targetFiles: string[],
	patterns?: string[],
): DelegationPrompt {
	return {
		task,
		expectedOutcome: "Working implementation that passes typecheck and follows existing patterns",
		requiredSkills: ["TypeScript", "Code patterns"],
		requiredTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
		mustDo: [
			"Follow the spec exactly",
			"Match existing code patterns",
			"Run typecheck after changes",
			"Handle edge cases identified in spec",
			...(targetFiles.length > 0 ? [`Modify these files: ${targetFiles.join(", ")}`] : []),
		],
		mustNotDo: [
			"Expand scope beyond the spec",
			"Refactor unrelated code",
			"Add features not in the spec",
			"Skip typecheck verification",
			"Use any types",
		],
		context: [
			`## Spec\n${spec}`,
			...(patterns ? [`## Existing patterns to follow\n${patterns.map((p) => `- ${p}`).join("\n")}`] : []),
		].join("\n\n"),
	};
}

/**
 * Create a delegation prompt for validation tasks
 */
export function createValidationPrompt(
	task: string,
	expectedChanges: string[],
	isIndependent: boolean,
): DelegationPrompt {
	return {
		task: `Validate the implementation: ${task}`,
		expectedOutcome: "Validation report with pass/fail status and specific issues if any",
		requiredSkills: ["Code review", "Testing", "Security awareness"],
		requiredTools: ["Read", "Bash", "Grep", "Glob"],
		mustDo: [
			"Run typecheck (pnpm typecheck)",
			"Run tests (pnpm test --run)",
			"Check for security issues (OWASP top 10)",
			"Verify edge cases are handled",
			"Compare implementation against spec",
			...(expectedChanges.length > 0 ? [`Verify changes in: ${expectedChanges.join(", ")}`] : []),
		],
		mustNotDo: [
			"Fix issues yourself - only report them",
			"Skip any verification steps",
			"Approve without running tests",
			...(isIndependent ? ["Assume correctness without verification"] : []),
		],
		context: isIndependent
			? "You are an INDEPENDENT validator - you did not write this code. Be skeptical and thorough."
			: undefined,
	};
}

/**
 * Squad agent definitions for the Claude SDK
 *
 * These define the four agent types for task execution.
 */
export const SQUAD_AGENTS: Record<AgentType, AgentDefinition> = {
	// Scout - Fast recon, read-only, Haiku for speed/cost
	// The only agent using Haiku - speed matters more than quality for recon
	scout: {
		description:
			"Fast codebase reconnaissance. Use for finding files, understanding structure, mapping the territory before planning begins.",
		prompt: `You are a flute. Your job is to quickly survey the codebase and report findings.

Guidelines:
- Be thorough but fast - gather intel efficiently
- Don't modify anything - you're read-only
- Report: relevant files, patterns, dependencies, potential challenges
- Focus on what the logistics needs to create a good spec

Output your findings in a structured format the logistics can use.`,
		tools: ["Read", "Grep", "Glob"],
		model: "haiku",
	},

	// Planner - BMAD-style spec creation, read-only, Sonnet for fast iteration
	// Creates detailed specs using the Rule of Five
	planner: {
		description:
			"Specification writer. Creates detailed implementation plans from flute intel. Uses BMAD-style planning and the Rule of Five before execution begins.",
		prompt: `You are a logistics. Based on flute reports, create a detailed implementation spec.

Apply the Rule of Five - review your plan 5 times with different lenses:
1. Correctness: Does this solve the actual problem?
2. Edge cases: What could go wrong? What's missing?
3. Simplicity: Is this the simplest approach? Over-engineered?
4. Testability: How will we verify this works?
5. Maintainability: Will future developers understand this?

Your spec should include:
- Files to modify/create
- Specific changes needed in each file
- Edge cases to handle
- Test requirements
- Potential risks or blockers

Output a clear, actionable plan for fabricators to execute.
Don't write code - write specs. The fabricators will implement.`,
		tools: ["Read", "Grep", "Glob"],
		model: "sonnet",
	},

	// Builder - Builds things, full access, Sonnet for speed + quality
	// Follows the approved plan, doesn't improvise
	builder: {
		description:
			"Implementation specialist. Builds features, fixes bugs, writes code following the approved logistics spec.",
		prompt: `You are a builder. Your job is to EXECUTE the approved plan by using your tools.

CRITICAL: You must USE your tools (Write, Edit, Bash, etc.) to make changes. Do NOT:
- Ask for permission - you already have it
- Explain what you would do - just DO it
- Discuss options - the plan is already approved
- Wait for confirmation - act immediately

You have full tool access. Use it.

Execution guidelines:
- Follow the spec exactly - don't improvise or expand scope
- Use existing code patterns
- Apply Rule of Five mentally before writing:
  1. Correctness: Does it match the spec?
  2. Edge cases: Are they handled?
  3. Security: No OWASP issues?
  4. Performance: No obvious problems?
  5. Maintainability: Is it clear?

BUILD VERIFICATION (CRITICAL):
After making significant code changes (implementing features, adding files, major modifications):
1. Run "pnpm typecheck" FIRST to verify TypeScript types pass
2. Run "pnpm build" to verify the codebase builds successfully
3. If typecheck OR build fails, you MUST fix all errors before continuing
4. Common failures to watch for:
   - TypeScript type errors (from typecheck)
   - Missing imports
   - Undefined variables/functions
   - Syntax errors
   - Missing dependencies
5. Do NOT complete your step while type errors or build failures exist
6. Report typecheck and build status in your summary

If you hit a blocker not covered by the spec:
- Minor: Handle sensibly, note it
- Major: Report and stop

GIT COMMITS:
- Write clear, concise commit messages
- NO emojis in commit messages - keep them plain and professional
- Format: "Short description of what changed"
- Don't add attribution lines (Co-Authored-By, etc.)
- NEVER run "git push" - the orchestrator handles all pushes after verification

CRITICAL - DO NOT PUSH:
- You may ONLY commit locally (git add, git commit)
- NEVER run "git push" or any push command
- The orchestrator will push after verification passes
- If you push, you bypass the verification gate

When done, summarize what you changed and confirm build status.`,
		tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
		model: "sonnet",
	},

	// Reviewer - Quality check, read-only + bash for tests, Opus for best judgment
	// Uses Rule of Five for comprehensive review
	reviewer: {
		description:
			"Quality assurance. Reviews code against the plan using Rule of Five, runs tests, catches issues before extraction.",
		prompt: `You are an sheriff. Review code critically against the original plan.

Apply Rule of Five review lenses:
1. Correctness: Does the implementation match the spec?
2. Edge cases: Are the identified edge cases handled?
3. Security: Any vulnerabilities? (injection, XSS, auth issues)
4. Performance: Any concerning patterns?
5. Maintainability: Is this code clear and well-structured?

Your job:
- Compare implementation against the approved plan
- Run tests (pnpm test or equivalent)
- Check for regressions
- Be paranoid - find issues before they ship

BUILD VERIFICATION (CRITICAL):
As part of your quality gates, you MUST verify the build:
1. Run "pnpm typecheck" FIRST to verify TypeScript types pass
2. Run "pnpm build" to ensure the codebase builds successfully
3. Check that builder properly ran build verification
4. Verify there are no build errors, warnings, or type issues
5. If typecheck OR build fails, this is a CRITICAL issue - do not approve the implementation
6. Type verification and build verification are mandatory quality gates

Report:
- Issues found (critical, major, minor)
- Build status (pass/fail, any errors/warnings)
- Tests status (pass/fail, coverage if available)
- Recommendation: approve, fix-and-retry, or escalate

Don't fix code yourself - report issues for fabricators to fix.`,
		tools: ["Read", "Bash", "Grep", "Glob"],
		model: "opus",
	},
};

/**
 * Generate a unique squad member ID
 */
export function generateAgentId(type: AgentType): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `${type}-${timestamp}-${random}`;
}

/**
 * Create a new squad member
 */
export function createAgent(type: AgentType, step?: Step): Agent {
	const now = new Date();
	return {
		id: generateAgentId(type),
		type,
		step,
		status: step ? "working" : "idle",
		spawnedAt: now,
		lastActivityAt: now,
	};
}

/**
 * Get the agent definition for a type
 */
export function getAgentDefinition(type: AgentType): AgentDefinition {
	return SQUAD_AGENTS[type];
}

/**
 * Get all agent definitions (for SDK options)
 */
export function getAllAgentDefinitions(): Record<string, AgentDefinition> {
	return SQUAD_AGENTS;
}

/**
 * Determine which agent type should handle a step based on description
 */
export function determineAgentType(taskDescription: string): AgentType {
	const desc = taskDescription.toLowerCase();

	// Scout keywords
	if (
		desc.includes("find") ||
		desc.includes("search") ||
		desc.includes("locate") ||
		desc.includes("where") ||
		desc.includes("what files") ||
		desc.includes("understand") ||
		desc.includes("analyze structure")
	) {
		return "scout";
	}

	// Planner keywords
	if (
		desc.includes("plan") ||
		desc.includes("design") ||
		desc.includes("spec") ||
		desc.includes("approach") ||
		desc.includes("strategy") ||
		desc.includes("how should")
	) {
		return "planner";
	}

	// Reviewer keywords
	if (
		desc.includes("review") ||
		desc.includes("test") ||
		desc.includes("check") ||
		desc.includes("verify") ||
		desc.includes("audit") ||
		desc.includes("quality")
	) {
		return "reviewer";
	}

	// Default to builder for implementation steps
	return "builder";
}
