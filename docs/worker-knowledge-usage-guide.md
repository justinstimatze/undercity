# Worker Knowledge Usage Guide

Step-by-step guide for workers querying and using the knowledge system during task execution.

## Prerequisites

- TypeScript project with ESM module support
- Access to `.undercity/` state directory
- Understanding of task execution lifecycle

## Step 1: Import Knowledge Functions

```typescript
import {
  findRelevantLearnings,
  formatLearningsForPrompt,
  markLearningsUsed,
  loadKnowledge,
  type Learning,
} from "./knowledge.js";
import { extractAndStoreLearnings } from "./knowledge-extractor.js";
```

## Step 2: Query Learnings During Context Preparation

Call `findRelevantLearnings()` before task execution to retrieve relevant past experience:

```typescript
// Basic query - returns up to 5 relevant learnings
const learnings = findRelevantLearnings(
  "Add validation to REST API endpoint",
  5,  // maxResults
  ".undercity"  // stateDir
);
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `objective` | `string` | Required | Task description to match |
| `maxResults` | `number` | 5 | Maximum learnings to return |
| `stateDir` | `string` | ".undercity" | State directory path |

**Returns:** `Learning[]` sorted by relevance score (descending).

## Step 3: Format Learnings for Prompt Injection

Convert retrieved learnings into prompt-ready text:

```typescript
if (learnings.length > 0) {
  const promptSection = formatLearningsForPrompt(learnings);
  // promptSection now contains formatted learnings text

  // Inject into agent context
  const fullPrompt = `${promptSection}\n\n---\n\n${taskDescription}`;
}
```

**Example output:**
```
RELEVANT LEARNINGS FROM PREVIOUS TASKS:
- ESM imports require .js extension even for TypeScript files
- This project uses Zod schemas for all API validation
- Always use execFileSync for git commands with variables

Use these insights if applicable to your current task.
```

## Step 4: Track Injected Learning IDs

Store which learnings were injected so you can update their stats later:

```typescript
class TaskWorker {
  private injectedLearningIds: string[] = [];

  async prepareContext(task: string): Promise<string> {
    const learnings = findRelevantLearnings(task, 5, this.stateDir);

    // Track IDs for later marking
    this.injectedLearningIds = learnings.map(l => l.id);

    return formatLearningsForPrompt(learnings);
  }
}
```

## Step 5: Mark Learnings Used After Task Completion

Update learning statistics based on task outcome:

```typescript
// After successful task
markLearningsUsed(this.injectedLearningIds, true, this.stateDir);

// After failed task
markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
```

**Effects on learning:**
| Outcome | Confidence Change | Other Updates |
|---------|-------------------|---------------|
| Success | +0.05 (max 0.95) | usedCount++, successCount++, lastUsedAt |
| Failure | -0.10 (min 0.10) | usedCount++, lastUsedAt |

## Step 6: Extract New Learnings

After successful task completion, extract new learnings from agent output:

```typescript
import { extractAndStoreLearnings } from "./knowledge-extractor.js";

// Extract and store learnings from conversation
const extracted = await extractAndStoreLearnings(
  taskId,
  agentConversationText,
  this.stateDir
);

console.log(`Extracted ${extracted.length} new learnings`);
```

## Complete Integration Example

```typescript
import {
  findRelevantLearnings,
  formatLearningsForPrompt,
  markLearningsUsed,
} from "./knowledge.js";
import { extractAndStoreLearnings } from "./knowledge-extractor.js";

class KnowledgeAwareWorker {
  private injectedLearningIds: string[] = [];
  private stateDir: string;
  private lastAgentOutput = "";

  constructor(stateDir = ".undercity") {
    this.stateDir = stateDir;
  }

  async execute(taskId: string, task: string): Promise<boolean> {
    try {
      // Phase 1: Context preparation with knowledge
      const context = await this.prepareContext(task);

      // Phase 2: Execute task (simplified)
      const success = await this.runTask(context, task);

      // Phase 3: Record outcomes
      if (success) {
        await this.recordSuccess(taskId);
      } else {
        await this.recordFailure();
      }

      return success;
    } catch (error) {
      await this.recordFailure();
      throw error;
    }
  }

  private async prepareContext(task: string): Promise<string> {
    let context = "";

    const learnings = findRelevantLearnings(task, 5, this.stateDir);

    if (learnings.length > 0) {
      context += formatLearningsForPrompt(learnings);
      context += "\n\n---\n\n";
      this.injectedLearningIds = learnings.map(l => l.id);
    } else {
      this.injectedLearningIds = [];
    }

    return context;
  }

  private async runTask(context: string, task: string): Promise<boolean> {
    // Implementation details omitted
    // Store agent output in this.lastAgentOutput
    return true;
  }

  private async recordSuccess(taskId: string): Promise<void> {
    // Extract new learnings
    await extractAndStoreLearnings(taskId, this.lastAgentOutput, this.stateDir);

    // Mark used learnings as successful
    if (this.injectedLearningIds.length > 0) {
      markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
    }
  }

  private async recordFailure(): Promise<void> {
    if (this.injectedLearningIds.length > 0) {
      markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
    }
  }
}
```

## Advanced: Filtering by Category

Query learnings of specific categories for targeted injection:

```typescript
import { loadKnowledge, type LearningCategory } from "./knowledge.js";

function findByCategory(
  objective: string,
  category: LearningCategory,
  maxResults = 5,
  stateDir = ".undercity"
): Learning[] {
  const kb = loadKnowledge(stateDir);

  // Extract keywords
  const keywords = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  return kb.learnings
    .filter(l => l.category === category)
    .map(l => {
      const overlap = keywords.filter(kw => l.keywords.includes(kw)).length;
      const score = (overlap / Math.max(keywords.length, 1)) * 0.7 + l.confidence * 0.3;
      return { learning: l, score };
    })
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.learning);
}

// Usage: Only inject gotchas for bug fix tasks
const gotchas = findByCategory("Fix import error", "gotcha", 5);
```

## Advanced: Confidence Filtering

Inject only battle-tested learnings for critical tasks:

```typescript
function findHighConfidenceLearnings(
  objective: string,
  minConfidence = 0.6,
  maxResults = 5,
  stateDir = ".undercity"
): Learning[] {
  return findRelevantLearnings(objective, maxResults * 2, stateDir)
    .filter(l => l.confidence >= minConfidence)
    .slice(0, maxResults);
}

// For critical tasks, only use proven learnings
const proven = findHighConfidenceLearnings("Deploy to production", 0.8, 5);
```

## Error Handling

Knowledge operations should not fail the task:

```typescript
async function safeKnowledgeQuery(task: string): Promise<string> {
  try {
    const learnings = findRelevantLearnings(task, 5);
    return formatLearningsForPrompt(learnings);
  } catch (error) {
    console.warn("Knowledge query failed, continuing without learnings:", error);
    return "";
  }
}

async function safeMarkUsed(ids: string[], success: boolean): Promise<void> {
  try {
    markLearningsUsed(ids, success);
  } catch (error) {
    console.warn("Failed to mark learnings as used:", error);
    // Continue - this is not critical
  }
}
```

## State Directory Considerations

Workers running in isolated worktrees should read/write knowledge to the main repository:

```typescript
class WorktreeWorker {
  private mainRepoStateDir: string;  // Points to main repo's .undercity
  private worktreePath: string;       // Current worktree working directory

  constructor(mainRepoRoot: string, worktreePath: string) {
    this.mainRepoStateDir = join(mainRepoRoot, ".undercity");
    this.worktreePath = worktreePath;
  }

  async queryKnowledge(task: string): Promise<Learning[]> {
    // Always query main repo's knowledge, not worktree
    return findRelevantLearnings(task, 5, this.mainRepoStateDir);
  }
}
```

**Why this matters:**
- All workers share the same knowledge base
- Learnings persist after worktree cleanup
- Knowledge compounds across parallel task execution

## Debugging

### View Knowledge Base Contents

```typescript
const kb = loadKnowledge();
console.log(`Total learnings: ${kb.learnings.length}`);

for (const learning of kb.learnings) {
  console.log(`[${learning.category}] ${learning.content}`);
  console.log(`  Confidence: ${(learning.confidence * 100).toFixed(0)}%`);
  console.log(`  Used: ${learning.usedCount}x`);
}
```

### Test Query Results

```typescript
const results = findRelevantLearnings("my task description", 10);
console.log(`Found ${results.length} relevant learnings`);

for (const l of results) {
  console.log(`- ${l.content} (conf: ${l.confidence.toFixed(2)})`);
}
```

### Check Knowledge Stats

```typescript
import { getKnowledgeStats } from "./knowledge.js";

const stats = getKnowledgeStats();
console.log(`Total: ${stats.totalLearnings}`);
console.log(`By category:`, stats.byCategory);
console.log(`Avg confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`);
```

## Performance Tips

1. **Limit query results** - Query only what you need (5-10 learnings typical)
2. **Filter by category** - Use category-specific queries for targeted tasks
3. **Cache within session** - Don't query same task multiple times
4. **Batch mark operations** - Mark all used learnings in single call

## Related Documentation

- [Knowledge System Architecture](./knowledge-system.md) - How the system works internally
- [Worker Integration Details](./worker-knowledge-integration.md) - Full integration patterns
- [API Reference](./API.md) - Complete API documentation
- [Examples](../examples/knowledge-queries.ts) - Runnable TypeScript examples
