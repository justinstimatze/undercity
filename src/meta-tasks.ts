/**
 * Meta-Task Templates
 *
 * Templates for meta-tasks that operate on the task board itself.
 * Meta-tasks return recommendations instead of making direct mutations.
 * The orchestrator processes these recommendations as the single point of mutation.
 */

import type { MetaTaskResult, MetaTaskType } from "./types.js";

/**
 * Check if a task objective is a meta-task
 */
export function isMetaTask(objective: string): boolean {
	return /^\[meta:(triage|prune|plan|prioritize|generate)\]/i.test(objective);
}

/**
 * Extract meta-task type from objective
 */
export function getMetaTaskType(objective: string): MetaTaskType | null {
	const match = objective.match(/^\[meta:(triage|prune|plan|prioritize|generate)\]/i);
	return match ? (match[1].toLowerCase() as MetaTaskType) : null;
}

/**
 * Get the system prompt for a meta-task type
 */
export function getMetaTaskPrompt(metaType: MetaTaskType): string {
	switch (metaType) {
		case "triage":
			return TRIAGE_PROMPT;
		case "prune":
			return PRUNE_PROMPT;
		case "prioritize":
			return PRIORITIZE_PROMPT;
		case "generate":
			return GENERATE_PROMPT;
		case "plan":
			return PLAN_PROMPT;
		default:
			return "";
	}
}

/**
 * Parse meta-task result from agent output
 */
export function parseMetaTaskResult(output: string, metaType: MetaTaskType): MetaTaskResult | null {
	try {
		// Look for JSON block in output
		const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[1]);
			// Validate structure
			if (parsed.recommendations && Array.isArray(parsed.recommendations)) {
				return {
					metaTaskType: metaType,
					recommendations: parsed.recommendations,
					summary: parsed.summary || "No summary provided",
					metrics: parsed.metrics,
				};
			}
		}

		// Try parsing the whole output as JSON
		const parsed = JSON.parse(output);
		if (parsed.recommendations && Array.isArray(parsed.recommendations)) {
			return {
				metaTaskType: metaType,
				recommendations: parsed.recommendations,
				summary: parsed.summary || "No summary provided",
				metrics: parsed.metrics,
			};
		}
	} catch {
		// Failed to parse
	}

	return null;
}

// =============================================================================
// Meta-Task Prompts
// =============================================================================

const TRIAGE_PROMPT = `You are analyzing a task board for health issues.

Your job is to identify problems and return structured recommendations.
DO NOT make any changes directly - return recommendations for the orchestrator.

Read the task board from .undercity/tasks.json and analyze for:

1. TEST CRUFT: Tasks that look like test artifacts
   - Patterns: "test task", "testing", "final test", "test with priority"
   - Action: recommend "remove" with high confidence

2. DUPLICATES: Tasks with very similar objectives (>70% word overlap)
   - Action: recommend "merge" with the duplicate task IDs

3. STATUS BUGS: Tasks marked "pending" but have a completedAt timestamp
   - Action: recommend "fix_status"

4. OVERLY GRANULAR: 5+ tasks sharing the same prefix (over-decomposed)
   - Action: recommend "review" - flag for human attention

5. VAGUE TASKS: Short objectives (<50 chars) starting with generic verbs
   - Patterns: "improve", "fix", "update", "better"
   - Action: recommend "review" - needs more specificity

Return your analysis as JSON:

\`\`\`json
{
  "summary": "Brief summary of analysis",
  "metrics": {
    "healthScore": 85,
    "issuesFound": 5,
    "tasksAnalyzed": 60
  },
  "recommendations": [
    {
      "action": "remove",
      "taskId": "task-abc123",
      "reason": "Test task - matches pattern 'test with priority'",
      "confidence": 0.95
    },
    {
      "action": "fix_status",
      "taskId": "task-def456",
      "reason": "Status is pending but has completedAt timestamp",
      "confidence": 1.0
    },
    {
      "action": "merge",
      "taskId": "task-ghi789",
      "relatedTaskIds": ["task-jkl012"],
      "reason": "85% similar to existing task",
      "confidence": 0.85
    }
  ]
}
\`\`\`

Only recommend actions you're confident about. Use confidence scores:
- 1.0: Certain (status bugs, exact duplicates)
- 0.9-0.95: Very confident (clear test patterns)
- 0.8-0.9: Confident (likely duplicates, clear issues)
- <0.8: Uncertain (flag for review, don't auto-apply)

The orchestrator will only apply recommendations with confidence >= 0.8.
`;

const PRUNE_PROMPT = `You are cleaning up a task board by identifying removable items.

Your job is to identify tasks that should be removed and return recommendations.
DO NOT make any changes directly - return recommendations for the orchestrator.

Read the task board from .undercity/tasks.json and identify:

1. TEST ARTIFACTS: Tasks created for testing purposes
   - Look for: "test", "testing", "example", "sample", "demo"
   - High confidence removal

2. ABANDONED TASKS: Tasks with old createdAt dates and no progress
   - If createdAt > 30 days ago and status is still "pending"
   - Medium confidence - recommend review

3. COMPLETED DUPLICATES: Tasks that duplicate already-completed work
   - Check if objective matches a completed task
   - High confidence removal

4. INVALID TASKS: Tasks with missing or malformed data
   - Missing objective, null priority, etc.
   - High confidence removal

Return your analysis as JSON:

\`\`\`json
{
  "summary": "Identified N tasks for removal",
  "recommendations": [
    {
      "action": "remove",
      "taskId": "task-abc123",
      "reason": "Test artifact - contains 'test task' in objective",
      "confidence": 0.95
    }
  ]
}
\`\`\`

Be conservative - only recommend removal for clear cases.
`;

const PRIORITIZE_PROMPT = `You are analyzing a task board to suggest priority adjustments.

Your job is to identify tasks that should be re-prioritized and return recommendations.
DO NOT make any changes directly - return recommendations for the orchestrator.

Read the task board from .undercity/tasks.json and analyze:

1. BLOCKING TASKS: Tasks that other tasks depend on should be higher priority
2. QUICK WINS: Small tasks that unblock larger work
3. STALE HIGH-PRIORITY: Old high-priority tasks that may no longer be urgent
4. DEPENDENCIES: Tasks whose dependencies are all complete should be elevated

Priority scale: 1 (highest) to 1000 (lowest)
- 1-10: Critical/blocking
- 11-50: High priority
- 51-100: Normal priority
- 100+: Low priority/backlog

Return your analysis as JSON:

\`\`\`json
{
  "summary": "Suggested N priority adjustments",
  "recommendations": [
    {
      "action": "prioritize",
      "taskId": "task-abc123",
      "reason": "Blocks 3 other tasks",
      "confidence": 0.9,
      "updates": {
        "priority": 5
      }
    }
  ]
}
\`\`\`
`;

const GENERATE_PROMPT = `You are analyzing a codebase to generate improvement tasks.

Your job is to identify valuable improvements and return task recommendations.
DO NOT make any changes directly - return recommendations for the orchestrator.

Analyze the codebase for:

1. CODE QUALITY: Functions that are too complex, need refactoring
2. TESTING GAPS: Areas with low test coverage
3. DOCUMENTATION: Missing or outdated docs
4. PERFORMANCE: Obvious performance improvements
5. SECURITY: Potential security issues
6. TECH DEBT: TODO comments, deprecated patterns

For each finding, create a well-defined task recommendation:

\`\`\`json
{
  "summary": "Generated N improvement tasks",
  "recommendations": [
    {
      "action": "add",
      "reason": "Found complex function with cyclomatic complexity > 15",
      "confidence": 0.85,
      "newTask": {
        "objective": "[refactor] Simplify processTaskResult in orchestrator.ts - extract validation logic to separate function",
        "priority": 500,
        "tags": ["refactor", "code-quality"]
      }
    }
  ]
}
\`\`\`

Guidelines:
- Tasks should be atomic (completable in one session)
- Use clear prefixes: [refactor], [test], [docs], [perf], [security]
- Include specific file paths when known
- Set reasonable priorities (not everything is urgent)
`;

const PLAN_PROMPT = `You are decomposing a high-level objective into implementation tasks.

Your job is to break down the objective and return task recommendations.
DO NOT make any changes directly - return recommendations for the orchestrator.

For the given objective:
1. Identify the key components/steps needed
2. Order them by dependencies
3. Create atomic, implementable tasks

Each task should be:
- Completable in one session
- Clear and specific
- Include relevant file paths if known
- Have appropriate priority (lower number = higher priority)

Return your plan as JSON:

\`\`\`json
{
  "summary": "Decomposed objective into N tasks",
  "recommendations": [
    {
      "action": "add",
      "reason": "Step 1 of implementation plan",
      "confidence": 0.9,
      "newTask": {
        "objective": "Create data models for feature X in src/types.ts",
        "priority": 10,
        "tags": ["feature-x"]
      }
    },
    {
      "action": "add",
      "reason": "Step 2 of implementation plan - depends on step 1",
      "confidence": 0.9,
      "newTask": {
        "objective": "Implement core logic for feature X in src/feature-x.ts",
        "priority": 20,
        "tags": ["feature-x"],
        "dependsOn": ["<id-from-step-1>"]
      }
    }
  ]
}
\`\`\`

Focus on creating a logical sequence of tasks that builds up to the full objective.
`;

export const META_TASK_PROMPTS = {
	triage: TRIAGE_PROMPT,
	prune: PRUNE_PROMPT,
	prioritize: PRIORITIZE_PROMPT,
	generate: GENERATE_PROMPT,
	plan: PLAN_PROMPT,
};
