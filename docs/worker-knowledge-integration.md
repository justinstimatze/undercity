# Worker Knowledge Integration

How workers query and use the knowledge system during task execution.

## Quick Start Guide

**Find relevant learnings:**
```typescript
const learnings = findRelevantLearnings("Add API validation", 5);
```

**Inject into prompts:**
```typescript
const prompt = formatLearningsForPrompt(learnings);
```

**Mark success/failure:**
```typescript
markLearningsUsed(learningIds, true);  // success
markLearningsUsed(learningIds, false); // failure
```

For complete examples, see [examples/knowledge-queries.ts](../examples/knowledge-queries.ts) (Example 7: Worker Integration Pattern).

## Worker Lifecycle Integration

```
Worker Start
    ↓
Build Context → findRelevantLearnings(task)
    ↓                    ↓
formatLearningsForPrompt() → Inject into prompt
    ↓
Track injectedLearningIds
    ↓
Execute Task
    ↓
On Success → extractAndStoreLearnings()
          → markLearningsUsed(ids, true)
    ↓
On Failure → markLearningsUsed(ids, false)
```

## Querying Relevant Learnings

Workers query learnings during context preparation:

```typescript
import { findRelevantLearnings } from "./knowledge.js";

// Find up to 5 relevant learnings for a task
const relevantLearnings = findRelevantLearnings(
  "Implement user authentication with JWT",
  5,           // max results
  ".undercity" // state directory
);

// Returns Learning[] sorted by relevance score
```

**Query matching process:**
1. Extract keywords from task objective
2. Score each learning by keyword overlap (70% weight)
3. Factor in confidence score (30% weight)
4. Filter to minimum score >0.1
5. Return top N results

## Injecting Learnings into Prompts

Format learnings for inclusion in agent prompts:

```typescript
import { formatLearningsForPrompt } from "./knowledge.js";

const learningsPrompt = formatLearningsForPrompt(relevantLearnings);

// Example output:
// RELEVANT LEARNINGS FROM PREVIOUS TASKS:
// - ESM imports require .js extension even for .ts files
// - This project uses Zod for validation schemas
// - Always use execFileSync for git commands with variables
//
// Use these insights if applicable to your current task.
```

**Integration in worker context:**

```typescript
// From worker.ts context building
const relevantLearnings = findRelevantLearnings(task, 5, this.stateDir);
if (relevantLearnings.length > 0) {
  const learningsPrompt = formatLearningsForPrompt(relevantLearnings);
  contextSection += `${learningsPrompt}\n\n---\n\n`;

  // Track which learnings we're using
  this.injectedLearningIds = relevantLearnings.map(l => l.id);
} else {
  this.injectedLearningIds = [];
}
```

## Tracking Learning Usage

Mark learnings as used after task completion:

```typescript
import { markLearningsUsed } from "./knowledge.js";

// After successful task completion
markLearningsUsed(this.injectedLearningIds, true, this.stateDir);

// After failed task
markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
```

**Effects of marking:**
- Increments `usedCount`
- Updates `lastUsedAt` timestamp
- Adjusts `confidence`:
  - Success: +0.05 (max 0.95)
  - Failure: -0.10 (min 0.10)

## Extracting New Learnings

After task completion, extract learnings from agent output:

```typescript
import { extractAndStoreLearnings } from "./knowledge-extractor.js";

// Extract and store learnings from agent conversation
const extracted = await extractAndStoreLearnings(
  taskId,
  agentConversationText,
  ".undercity"
);

// Returns Learning[] of newly stored learnings
```

**Worker implementation:**

```typescript
// From worker.ts recordSuccessLearnings()
private async recordSuccessLearnings(taskId: string, task: string): Promise<void> {
  try {
    // Extract learnings from agent output
    const extracted = await extractAndStoreLearnings(
      taskId,
      this.lastAgentOutput,
      this.stateDir
    );

    if (extracted.length > 0) {
      output.debug(`Extracted ${extracted.length} learnings from task`, { taskId });
    }

    // Mark injected learnings as successfully used
    if (this.injectedLearningIds.length > 0) {
      markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
      output.debug(`Marked ${this.injectedLearningIds.length} learnings as used`, { taskId });
    }
  } catch (error) {
    sessionLogger.debug({ error: String(error) }, "Knowledge extraction failed");
  }
}
```

## Complete Worker Integration Pattern

```typescript
import {
  findRelevantLearnings,
  formatLearningsForPrompt,
  markLearningsUsed,
} from "./knowledge.js";
import { extractAndStoreLearnings } from "./knowledge-extractor.js";

class TaskWorker {
  private injectedLearningIds: string[] = [];
  private lastAgentOutput: string = "";
  private stateDir: string;

  async prepareContext(task: string): Promise<string> {
    let context = "";

    // Query relevant learnings
    const learnings = findRelevantLearnings(task, 5, this.stateDir);

    if (learnings.length > 0) {
      // Format and add to context
      context += formatLearningsForPrompt(learnings);
      context += "\n\n---\n\n";

      // Track for later marking
      this.injectedLearningIds = learnings.map(l => l.id);
    } else {
      this.injectedLearningIds = [];
    }

    return context;
  }

  async onTaskSuccess(taskId: string): Promise<void> {
    // Extract new learnings
    await extractAndStoreLearnings(taskId, this.lastAgentOutput, this.stateDir);

    // Mark used learnings as successful
    if (this.injectedLearningIds.length > 0) {
      markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
    }
  }

  async onTaskFailure(): Promise<void> {
    // Mark used learnings as unsuccessful
    if (this.injectedLearningIds.length > 0) {
      markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
    }
  }
}
```

## State Directory Handling

**Important**: Knowledge is stored in the main repo, not worktrees.

```typescript
// Workers run in worktrees but read/write knowledge to main repo
const relevantLearnings = findRelevantLearnings(
  task,
  5,
  this.stateDir  // Main repo .undercity, not worktree
);
```

This ensures:
- All workers share the same knowledge base
- Learnings persist after worktree cleanup
- Knowledge compounds across parallel tasks

## Filtering by Category

Query learnings of specific categories:

```typescript
import { loadKnowledge, type LearningCategory } from "./knowledge.js";

function findByCategory(
  objective: string,
  category: LearningCategory,
  maxResults: number = 5
): Learning[] {
  const kb = loadKnowledge();
  const objectiveKeywords = new Set(extractKeywords(objective));

  return kb.learnings
    .filter(l => l.category === category)
    .map(l => {
      const overlap = [...objectiveKeywords].filter(kw =>
        l.keywords.includes(kw)
      ).length;
      const score = (overlap / objectiveKeywords.size) * 0.7 + l.confidence * 0.3;
      return { learning: l, score };
    })
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.learning);
}

// Find only gotchas related to ESM imports
const gotchas = findByCategory("ESM module import issues", "gotcha");
```

## Debugging Knowledge Queries

Inspect what learnings would be retrieved:

```typescript
import { loadKnowledge, findRelevantLearnings } from "./knowledge.js";

// View all learnings
const kb = loadKnowledge();
console.log(`Total learnings: ${kb.learnings.length}`);

// Test a query
const task = "Add user authentication";
const results = findRelevantLearnings(task, 10);

for (const learning of results) {
  console.log({
    id: learning.id,
    category: learning.category,
    content: learning.content.substring(0, 50),
    confidence: learning.confidence,
    usedCount: learning.usedCount,
  });
}
```

## Performance Considerations

| Operation | Complexity | Notes |
|-----------|------------|-------|
| loadKnowledge | O(1) file read | Reads entire JSON file |
| findRelevantLearnings | O(n) | Scores all learnings |
| addLearning | O(n) | Duplicate check on all learnings |
| markLearningsUsed | O(n) | Scans for matching IDs |

For large knowledge bases (>1000 learnings), consider:
- Periodic pruning to remove stale entries
- Limiting max stored learnings
- Indexing by keywords (future optimization)

## Error Handling

Knowledge operations use silent failure for non-critical paths:

```typescript
// Non-critical - don't fail the task
try {
  const extracted = await extractAndStoreLearnings(taskId, output, stateDir);
} catch (error) {
  sessionLogger.debug({ error: String(error) }, "Knowledge extraction failed");
  // Continue - task success doesn't depend on knowledge extraction
}
```

## Testing Knowledge Integration

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLearning, findRelevantLearnings, markLearningsUsed, loadKnowledge } from "./knowledge.js";

describe("Knowledge Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("finds relevant learnings by keywords", () => {
    // Add a learning
    addLearning({
      taskId: "task-1",
      category: "pattern",
      content: "Use Zod for API validation schemas",
      keywords: ["zod", "api", "validation", "schema"],
    }, tempDir);

    // Query should find it
    const results = findRelevantLearnings("Add API validation", 5, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Zod");
  });

  it("updates confidence on use", () => {
    const learning = addLearning({
      taskId: "task-1",
      category: "gotcha",
      content: "ESM requires .js extension",
      keywords: ["esm", "import", "extension"],
    }, tempDir);

    // Initial confidence
    expect(learning.confidence).toBe(0.5);

    // Mark as successful
    markLearningsUsed([learning.id], true, tempDir);

    const kb = loadKnowledge(tempDir);
    const updated = kb.learnings.find(l => l.id === learning.id);
    expect(updated?.confidence).toBe(0.55);
  });
});
```

## Troubleshooting

### Empty Query Results

**Problem**: `findRelevantLearnings` returns empty array.

**Solutions**:
- Check knowledge base has learnings: `loadKnowledge().learnings.length`
- Verify keywords match: learnings use lowercase, stemmed keywords
- Lower relevance threshold by checking raw scores
- Ensure task objective has specific technical terms

**Example diagnostic**:
```typescript
const kb = loadKnowledge();
console.log(`Total learnings: ${kb.learnings.length}`);
console.log(`Categories: ${kb.learnings.map(l => l.category).join(", ")}`);
```

### Low Confidence Learnings

**Problem**: Learnings have confidence <0.3 and aren't being retrieved.

**Solutions**:
- Confidence drops after failed usage (−0.10 per failure)
- Check `usedCount` vs `successCount` ratio
- Consider pruning learnings with sustained low confidence
- Add new learnings for failing patterns

**Diagnosis**:
```typescript
const lowConf = kb.learnings.filter(l => l.confidence < 0.3);
console.log(`Low confidence learnings: ${lowConf.length}`);
for (const l of lowConf) {
  console.log(`  - ${l.content} (${l.successCount}/${l.usedCount} success rate)`);
}
```

### Learning Injection Not Improving Tasks

**Problem**: Injected learnings don't improve task success rate.

**Solutions**:
- Review learning content quality (vague vs specific)
- Check prompt placement (learnings before task description)
- Verify keywords are actually relevant to tasks
- Consider category-specific filtering (only inject gotchas/patterns)
- Monitor `successCount` to identify ineffective learnings

**Pattern to add**:
```typescript
// Filter to high-confidence learnings only
const highConfLearnings = findRelevantLearnings(task, 10)
  .filter(l => l.confidence > 0.6);
```
