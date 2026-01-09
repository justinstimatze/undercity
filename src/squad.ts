/**
 * Squad Module
 *
 * Defines the agent types and manages the squad of raiders.
 *
 * Agent Types:
 * - Scout: Fast codebase reconnaissance (Haiku, read-only)
 * - Planner: BMAD-style spec writer (Sonnet, read-only, fast iteration)
 * - Fabricator: Code builder (Sonnet, full access, fast + quality)
 * - Auditor: Quality reviewer with Rule of Five (Opus, read + tests)
 *
 * Based on Claude Agent SDK's AgentDefinition type.
 */

import type { AgentDefinition, AgentType, SquadMember, Task } from "./types.js";

/**
 * Squad agent definitions for the Claude SDK
 *
 * These define the four raider types that go topside.
 */
export const SQUAD_AGENTS: Record<AgentType, AgentDefinition> = {
	// Scout - Fast recon, read-only, Haiku for speed/cost
	// The only agent using Haiku - speed matters more than quality for recon
	scout: {
		description:
			"Fast codebase reconnaissance. Use for finding files, understanding structure, mapping the territory before planning begins.",
		prompt: `You are a scout. Your job is to quickly survey the codebase and report findings.

Guidelines:
- Be thorough but fast - gather intel efficiently
- Don't modify anything - you're read-only
- Report: relevant files, patterns, dependencies, potential challenges
- Focus on what the planner needs to create a good spec

Output your findings in a structured format the planner can use.`,
		tools: ["Read", "Grep", "Glob"],
		model: "haiku",
	},

	// Planner - BMAD-style spec creation, read-only, Sonnet for fast iteration
	// Creates detailed specs using the Rule of Five
	planner: {
		description:
			"Specification writer. Creates detailed implementation plans from scout intel. Uses BMAD-style planning and the Rule of Five before execution begins.",
		prompt: `You are a planner. Based on scout reports, create a detailed implementation spec.

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

	// Fabricator - Builds things, full access, Sonnet for speed + quality
	// Follows the approved plan, doesn't improvise
	fabricator: {
		description:
			"Implementation specialist. Builds features, fixes bugs, writes code following the approved planner spec.",
		prompt: `You are a fabricator. Your job is to EXECUTE the approved plan by using your tools.

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
1. Run "pnpm build" to verify the codebase builds successfully
2. If build fails, you MUST fix all errors before continuing
3. Common build failures to watch for:
   - TypeScript type errors
   - Missing imports
   - Undefined variables/functions
   - Syntax errors
   - Missing dependencies
4. Do NOT complete your task while build failures exist
5. Report build status in your summary

If you hit a blocker not covered by the spec:
- Minor: Handle sensibly, note it
- Major: Report and stop

When done, summarize what you changed and confirm build status.`,
		tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
		model: "sonnet",
	},

	// Auditor - Quality check, read-only + bash for tests, Opus for best judgment
	// Uses Rule of Five for comprehensive review
	auditor: {
		description:
			"Quality assurance. Reviews code against the plan using Rule of Five, runs tests, catches issues before extraction.",
		prompt: `You are an auditor. Review code critically against the original plan.

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
1. Run "pnpm build" to ensure the codebase builds successfully
2. Check that fabricator properly ran build verification
3. Verify there are no build errors, warnings, or type issues
4. If build fails, this is a CRITICAL issue - do not approve the implementation
5. Build verification is a mandatory quality gate

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
export function generateSquadMemberId(type: AgentType): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `${type}-${timestamp}-${random}`;
}

/**
 * Create a new squad member
 */
export function createSquadMember(type: AgentType, task?: Task): SquadMember {
	const now = new Date();
	return {
		id: generateSquadMemberId(type),
		type,
		task,
		status: task ? "working" : "idle",
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
 * Determine which agent type should handle a task based on description
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

	// Auditor keywords
	if (
		desc.includes("review") ||
		desc.includes("test") ||
		desc.includes("check") ||
		desc.includes("verify") ||
		desc.includes("audit") ||
		desc.includes("quality")
	) {
		return "auditor";
	}

	// Default to fabricator for implementation tasks
	return "fabricator";
}
