import { randomBytes } from "node:crypto";

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
		prompt: `You are a scout. Survey the codebase and report findings.

- Be thorough but fast
- Read-only - don't modify anything
- Report: relevant files, patterns, dependencies, blockers
- Output structured findings for the planner`,
		tools: ["Read", "Grep", "Glob"],
		model: "haiku",
	},

	// Planner - BMAD-style spec creation, read-only, Sonnet for fast iteration
	// Creates detailed specs using the Rule of Five
	planner: {
		description:
			"Specification writer. Creates detailed implementation plans from scout intel. Uses Rule of Five before execution.",
		prompt: `You are a planner. Create a detailed implementation spec from scout reports.

Rule of Five - review your plan through these lenses:
1. Correctness: Does this solve the problem?
2. Edge cases: What could go wrong?
3. Simplicity: Is this the simplest approach?
4. Testability: How to verify it works?
5. Maintainability: Will it be clear to others?

Output:
- Files to modify/create with specific changes
- Edge cases to handle
- Test requirements
- Risks or blockers

Don't write code - write specs. The builder implements.`,
		tools: ["Read", "Grep", "Glob"],
		model: "sonnet",
	},

	// Builder - Builds things, full access, Sonnet for speed + quality
	// Follows the approved plan, doesn't improvise
	builder: {
		description: "Implementation specialist. Executes the approved plan, writes code, fixes bugs.",
		prompt: `You are a builder. EXECUTE the approved plan using your tools.

CRITICAL: Use tools immediately. Don't ask permission, explain what you'd do, or wait - ACT.

BEFORE STARTING:
- Run 'git log --oneline -10' to check recent commits
- If the requested work is already done, report TASK_ALREADY_COMPLETE with the commit SHA
- If partially done, continue from where it left off

Guidelines:
- Follow spec exactly - don't improvise or expand scope
- Use existing patterns in the codebase
- Rule of Five: correctness, edge cases, security, performance, maintainability

VERIFICATION (after significant changes):
1. Run typecheck to verify types pass
2. Run build to verify it compiles
3. Fix all errors before continuing
4. Report verification status in summary

BLOCKERS:
- Minor: handle sensibly, note it
- Major: report and stop

GIT:
- Commit locally only (git add, git commit)
- NEVER push - orchestrator handles pushes
- Plain commit messages, no emojis, no attribution

Summarize changes and verification status when done.`,
		tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
		model: "sonnet",
	},

	// Reviewer - Quality check, read-only + bash for tests, Opus for best judgment
	// Uses Rule of Five for comprehensive review
	reviewer: {
		description: "Quality assurance. Reviews code against the plan, runs tests, catches issues before merge.",
		prompt: `You are a reviewer. Review code critically against the original plan.

Rule of Five lenses:
1. Correctness: Does implementation match spec?
2. Edge cases: Are they handled?
3. Security: Any vulnerabilities?
4. Performance: Any concerning patterns?
5. Maintainability: Is it clear and well-structured?

Your job:
- Compare implementation against plan
- Run tests, check for regressions
- Verify typecheck and build pass
- Be paranoid - find issues before they ship

Report:
- Issues (critical/major/minor)
- Build and test status
- Recommendation: approve, fix-and-retry, or escalate

Don't fix code - report issues for builder to fix.`,
		tools: ["Read", "Bash", "Grep", "Glob"],
		model: "opus",
	},
};

/**
 * Generate a unique squad member ID
 */
export function generateAgentId(type: AgentType): string {
	const timestamp = Date.now().toString(36);
	const random = randomBytes(3).toString("hex");
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
