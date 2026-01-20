# Workflow Formulas Guide

Standardized patterns for integrating the knowledge system into worker task execution.

## What Are Workflow Formulas?

Workflow formulas are reusable integration patterns that describe how to query, format, inject, track, and mark knowledge throughout a task's lifecycle. Each formula represents a different use case:

- **Basic**: Simple prompt enhancement
- **Full Integration**: Standard worker with complete lifecycle
- **Category Filtering**: Task-specific filtering (gotchas for bugs, patterns for features)
- **Confidence Filtering**: Quality-based filtering for critical vs exploratory tasks
- **Worktree-Safe**: Multi-worker parallel execution
- **Error Handling**: Production-ready, fault-tolerant code
- **Diagnostics**: Debugging empty or unexpected results
- **Batch Processing**: Multiple similar tasks with caching
- **Quality Assessment**: Filtering low-quality learnings

## The Knowledge Lifecycle

All formulas follow this core cycle:

```
Query → Format → Inject → Track → Mark
  ↓       ↓        ↓       ↓       ↓
Find   Convert   Add to  Store   Update
Learn  to Text   Prompt   IDs    Stats
```

**Phases:**
1. **Query**: Find relevant learnings using `findRelevantLearnings(task)`
2. **Format**: Convert to prompt text using `formatLearningsForPrompt()`
3. **Inject**: Add formatted text to agent context
4. **Track**: Store learning IDs in worker state
5. **Mark**: Update stats using `markLearningsUsed(ids, success)`

## Choosing the Right Formula

Use this decision tree to select the appropriate formula:

```
Is this a single, simple task?
├─ YES → Use Formula 1 (Basic)
│
└─ NO, it's a full worker implementation
   ├─ Do you need error handling?
   │  ├─ YES → Use Formula 6 (Error Handling)
   │  └─ NO → Use Formula 2 (Full Integration)
   │
   ├─ Do you need category filtering?
   │  ├─ YES (bug fix?) → Find "gotchas"
   │  ├─ YES (new feature?) → Find "patterns"
   │  └─ Use Formula 3 (Category Filtering)
   │
   ├─ Do you need quality filtering?
   │  ├─ YES (critical task) → Use Formula 4 (Confidence Filtering)
   │  └─ NO
   │
   ├─ Are you running in a worktree?
   │  ├─ YES → Use Formula 5 (Worktree-Safe)
   │  └─ NO
   │
   ├─ Are you processing multiple tasks?
   │  ├─ YES → Use Formula 8 (Batch Processing)
   │  └─ NO
   │
   └─ Need diagnostics?
      ├─ YES → Use Formula 7 (Diagnostics)
      └─ Otherwise → Check for quality issues → Formula 9 (Quality Assessment)
```

## Formula 1: Basic Context Preparation

**Use case**: Simple one-off tasks, proof of concepts, minimal knowledge integration

**What it does**: Queries and formats learnings with no tracking

```typescript
import { findRelevantLearnings, formatLearningsForPrompt } from "./knowledge.js";

function prepareBasicContext(task: string, stateDir: string): string {
  // Query: Find relevant learnings
  const learnings = findRelevantLearnings(task, 5, stateDir);

  if (learnings.length === 0) {
    return ""; // No relevant learnings found
  }

  // Format: Convert to prompt text
  return formatLearningsForPrompt(learnings);
}

// Usage
const context = prepareBasicContext("Add Zod validation to the API endpoint", ".undercity");
const prompt = `${context}\n\nNow implement the following task...`;
```

**When to use:**
- Quick one-off tasks
- Exploratory work
- Testing knowledge queries
- Debugging

**When NOT to use:**
- Production workers (no outcome tracking)
- Critical tasks (no confidence feedback)
- Long-running processes (knowledge becomes stale)

---

## Formula 2: Full Worker Integration

**Use case**: Standard worker implementation with complete lifecycle tracking

**What it does**: Tracks which learnings were injected and updates their stats on success/failure

```typescript
import {
  findRelevantLearnings,
  formatLearningsForPrompt,
  markLearningsUsed,
  type Learning,
} from "./knowledge.js";

class KnowledgeAwareWorker {
  private injectedLearningIds: string[] = [];
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Phase 1: Query & Format
   * Prepare context with relevant learnings
   */
  prepareContext(task: string): { context: string; learningCount: number } {
    // Query: Find relevant learnings
    const learnings = findRelevantLearnings(task, 5, this.stateDir);

    // Track: Store IDs for later marking
    this.injectedLearningIds = learnings.map((l) => l.id);

    // Format: Convert to prompt text
    const context = formatLearningsForPrompt(learnings);
    return { context, learningCount: learnings.length };
  }

  /**
   * Phase 2: Execute task
   * Run the actual work (simulated here)
   */
  async executeTask(task: string, context: string): Promise<boolean> {
    // Your implementation here
    console.log(`Executing task with ${this.injectedLearningIds.length} learnings injected`);
    return Math.random() > 0.3; // 70% success rate for demo
  }

  /**
   * Phase 3a: Track Success
   * Record successful outcome
   */
  recordSuccess(): void {
    if (this.injectedLearningIds.length > 0) {
      // Mark: Update stats for successful use
      markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
      console.log(`Marked ${this.injectedLearningIds.length} learnings as successful`);
    }
  }

  /**
   * Phase 3b: Track Failure
   * Record failed outcome
   */
  recordFailure(): void {
    if (this.injectedLearningIds.length > 0) {
      // Mark: Update stats for failed use
      markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
      console.log(`Marked ${this.injectedLearningIds.length} learnings as unsuccessful`);
    }
  }

  /**
   * Full Lifecycle
   */
  async run(task: string): Promise<boolean> {
    const { context, learningCount } = this.prepareContext(task);
    console.log(`Prepared context with ${learningCount} learnings`);

    const success = await this.executeTask(task, context);

    if (success) {
      this.recordSuccess();
    } else {
      this.recordFailure();
    }

    return success;
  }
}

// Usage
const worker = new KnowledgeAwareWorker(".undercity");
await worker.run("Fix ESM import error in module");
```

**When to use:**
- Standard worker implementations
- Production code
- Tasks where learning feedback improves future execution
- Most use cases

**Key benefits:**
- Full tracking throughout lifecycle
- Confidence scores improve over time
- Learning patterns emerge from successful/failed usage
- Foundation for other formulas

---

## Formula 3: Category-Specific Filtering

**Use case**: Task-specific filtering (gotchas for bugs, patterns for features)

**What it does**: Queries only learnings from specific categories

```typescript
import { loadKnowledge, type Learning, type LearningCategory } from "./knowledge.js";
import { findRelevantLearnings } from "./knowledge.js";

function findByCategory(
  objective: string,
  category: LearningCategory,
  maxResults: number = 5,
  stateDir: string
): Learning[] {
  const kb = loadKnowledge(stateDir);

  // Extract keywords from objective
  const keywords = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  return kb.learnings
    .filter((l) => l.category === category) // Filter by category
    .map((l) => {
      const overlap = keywords.filter((kw) => l.keywords.includes(kw)).length;
      const score = (overlap / Math.max(keywords.length, 1)) * 0.7 + l.confidence * 0.3;
      return { learning: l, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.learning);
}

// Usage: Bug fixes (find gotchas)
const gotchas = findByCategory(
  "Fix shell command injection vulnerability",
  "gotcha",
  5,
  ".undercity"
);
console.log("Gotchas for bug fix:");
for (const g of gotchas) {
  console.log(`  - ${g.content}`);
}

// Usage: New features (find patterns)
const patterns = findByCategory(
  "Add file write functionality",
  "pattern",
  5,
  ".undercity"
);
console.log("Patterns for new feature:");
for (const p of patterns) {
  console.log(`  - ${p.content}`);
}
```

**When to use:**
- Bug fixes → query "gotcha" category
- New features → query "pattern" category
- Refactoring → query "preference" category
- Exploratory work → query "fact" category

**Category mapping:**
| Task Type | Category | Why |
|-----------|----------|-----|
| Bug fix | gotcha | Pitfalls and known issues |
| New feature | pattern | Codebase conventions |
| Refactoring | preference | Project preferences |
| Investigation | fact | Code discoveries |
| Any task | (all) | General knowledge |

---

## Formula 4: Confidence-Based Filtering

**Use case**: Quality-based filtering for critical tasks vs exploratory work

**What it does**: Filters learnings by confidence threshold before injection

```typescript
import { findRelevantLearnings, type Learning } from "./knowledge.js";

function findHighConfidenceLearnings(
  objective: string,
  minConfidence: number,
  maxResults: number = 5,
  stateDir: string
): Learning[] {
  // Query: Get more than needed
  const candidates = findRelevantLearnings(objective, maxResults * 2, stateDir);

  // Filter: Only return high-confidence learnings
  return candidates.filter((l) => l.confidence >= minConfidence).slice(0, maxResults);
}

// Usage: Critical task (only use proven learnings)
const criticalContext = findHighConfidenceLearnings(
  "Fix authentication vulnerability",
  0.7, // 70% confidence minimum
  5,
  ".undercity"
);
console.log(`Using ${criticalContext.length} high-confidence learnings for critical task`);

// Usage: Exploratory task (lower bar)
const exploratoryContext = findHighConfidenceLearnings(
  "Explore new API framework",
  0.3, // 30% confidence minimum
  5,
  ".undercity"
);
console.log(`Using ${exploratoryContext.length} learnings for exploration`);
```

**When to use:**
- Security-critical tasks
- High-risk changes
- Production deployments
- Tasks where accuracy matters more than learning

**Confidence thresholds:**
- **≥0.7**: Proven patterns (use for critical tasks)
- **0.5-0.7**: Established patterns (standard use)
- **0.3-0.5**: Emerging patterns (exploratory work)
- **<0.3**: Unreliable patterns (typically skip)

---

## Formula 5: Worktree-Safe Queries

**Use case**: Multi-worker parallel execution in isolated git worktrees

**What it does**: Queries knowledge from main repo, not worktree (shared across workers)

```typescript
import { findRelevantLearnings, markLearningsUsed, type Learning } from "./knowledge.js";
import { join } from "node:path";

class WorktreeWorker {
  private mainRepoStateDir: string;
  private worktreePath: string;
  private injectedLearningIds: string[] = [];

  constructor(mainRepoRoot: string, worktreePath: string) {
    // CRITICAL: Knowledge lives in main repo, not worktree
    // This ensures all workers share the same knowledge base
    this.mainRepoStateDir = join(mainRepoRoot, ".undercity");
    this.worktreePath = worktreePath;
  }

  /**
   * Query knowledge from main repo (shared across all workers)
   */
  queryKnowledge(task: string): Learning[] {
    // NOTE: Uses mainRepoStateDir, not worktree path
    return findRelevantLearnings(task, 5, this.mainRepoStateDir);
  }

  /**
   * Mark learnings in main repo (persists after worktree cleanup)
   */
  markOutcome(success: boolean): void {
    if (this.injectedLearningIds.length > 0) {
      // Uses main repo state directory
      markLearningsUsed(this.injectedLearningIds, success, this.mainRepoStateDir);
    }
  }
}

// Usage in task worker
const mainRepoRoot = process.cwd(); // Main repo root
const worktreePath = `/tmp/worktree-task-123`; // Isolated worktree

const worktreeWorker = new WorktreeWorker(mainRepoRoot, worktreePath);
const learnings = worktreeWorker.queryKnowledge("Add validation");
console.log(`Worktree worker queried ${learnings.length} learnings from main repo`);
```

**Why this matters:**
- Worktrees are temporary and isolated
- Knowledge must be in main repo to persist across workers
- All workers share same knowledge base
- Prevents knowledge loss after worktree cleanup

**Key rule**: Always pass `mainRepoStateDir`, never `worktreePath` to knowledge functions.

---

## Formula 6: Safe Error Handling

**Use case**: Production-ready, fault-tolerant code

**What it does**: Wraps knowledge operations in try/catch to never fail the task

```typescript
import { findRelevantLearnings, formatLearningsForPrompt, markLearningsUsed } from "./knowledge.js";
import { sessionLogger } from "./logger.js";

/**
 * Safe knowledge integration - errors don't fail the task
 */
async function safeKnowledgeIntegration(
  task: string,
  stateDir: string
): Promise<{ context: string; ids: string[] }> {
  let context = "";
  let ids: string[] = [];

  try {
    // Query & Format: Can fail if knowledge base is corrupted
    const learnings = findRelevantLearnings(task, 5, stateDir);
    context = formatLearningsForPrompt(learnings);
    ids = learnings.map((l) => l.id);
  } catch (error) {
    // Log but continue - task can proceed without knowledge
    sessionLogger.warn({ error: String(error) }, "Knowledge query failed, continuing without learnings");
  }

  return { context, ids };
}

/**
 * Safe marking - errors don't affect already-completed task
 */
function safeMarkUsed(ids: string[], success: boolean, stateDir: string): void {
  try {
    markLearningsUsed(ids, success, stateDir);
  } catch (error) {
    // Log but continue - task already completed
    sessionLogger.warn({ error: String(error) }, "Failed to mark learnings, continuing");
  }
}

// Usage
async function workerMain(task: string, stateDir: string): Promise<void> {
  // Query safely
  const { context, ids } = await safeKnowledgeIntegration(task, stateDir);

  // Execute task with context (may be empty if query failed)
  const success = await executeTask(task, context);

  // Mark safely (non-critical)
  safeMarkUsed(ids, success, stateDir);
}
```

**When to use:**
- All production code
- Tasks with strict SLAs
- Mission-critical operations
- Code where knowledge failure shouldn't block execution

**Pattern:**
- **Query phase**: Log and return empty
- **Mark phase**: Log and continue (task already done)

---

## Formula 7: Diagnostic Queries

**Use case**: Debugging empty or unexpected query results

**What it does**: Provides diagnostic tools to understand knowledge base state

```typescript
import { loadKnowledge, findRelevantLearnings, getKnowledgeStats } from "./knowledge.js";

/**
 * Diagnose overall knowledge base state
 */
function diagnoseKnowledgeBase(stateDir: string): void {
  const kb = loadKnowledge(stateDir);
  const stats = getKnowledgeStats(stateDir);

  console.log("Knowledge Base Diagnosis:");
  console.log(`  Total learnings: ${stats.totalLearnings}`);
  console.log(`  By category:`);
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    console.log(`    - ${cat}: ${count}`);
  }
  console.log(`  Average confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`);

  // Find low-confidence learnings
  const lowConf = kb.learnings.filter((l) => l.confidence < 0.4);
  if (lowConf.length > 0) {
    console.log(`  Low-confidence learnings (<40%): ${lowConf.length}`);
  }

  // Find unused learnings
  const unused = kb.learnings.filter((l) => l.usedCount === 0);
  if (unused.length > 0) {
    console.log(`  Never-used learnings: ${unused.length}`);
  }
}

/**
 * Diagnose why a specific query returns no results
 */
function diagnoseQueryResult(task: string, stateDir: string): void {
  const learnings = findRelevantLearnings(task, 10, stateDir);

  console.log(`\nQuery diagnosis for: "${task}"`);
  console.log(`  Results: ${learnings.length}`);

  if (learnings.length === 0) {
    console.log("  No results - check if keywords match stored learnings");
  } else {
    for (const l of learnings) {
      console.log(`  - [${l.category}] ${l.content.substring(0, 50)}...`);
      console.log(`    Keywords: ${l.keywords.slice(0, 5).join(", ")}`);
    }
  }
}

// Usage
diagnoseKnowledgeBase(".undercity");
diagnoseQueryResult("Add API validation", ".undercity");
diagnoseQueryResult("Deploy to Kubernetes", ".undercity"); // Should have no results
```

**When to use:**
- Troubleshooting empty results
- Auditing knowledge quality
- Understanding retrieval patterns
- Performance analysis

**Common diagnostics:**
- Empty query results → check knowledge base is populated
- Low confidence learnings → likely failed many times
- Unused learnings → extracting wrong types of knowledge
- High variance in confidence → inconsistent patterns

---

## Formula 8: Batch Processing

**Use case**: Processing multiple similar tasks efficiently

**What it does**: Caches queries to avoid redundant lookups

```typescript
import { findRelevantLearnings, type Learning } from "./knowledge.js";

class BatchProcessor {
  private stateDir: string;
  private queryCache = new Map<string, Learning[]>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Get cached or fresh query results
   */
  private getCachedLearnings(task: string): Learning[] {
    // Simple cache key based on task prefix (first 3 words)
    const cacheKey = task.toLowerCase().split(" ").slice(0, 3).join(" ");

    if (this.queryCache.has(cacheKey)) {
      return this.queryCache.get(cacheKey)!;
    }

    // Cache miss - query and store
    const results = findRelevantLearnings(task, 5, this.stateDir);
    this.queryCache.set(cacheKey, results);
    return results;
  }

  /**
   * Process batch of tasks
   */
  async processBatch(tasks: string[]): Promise<void> {
    console.log(`Processing ${tasks.length} tasks with cached queries...`);

    for (const task of tasks) {
      const learnings = this.getCachedLearnings(task);
      console.log(`  "${task.substring(0, 30)}..." → ${learnings.length} learnings`);
    }

    console.log(`Cache size: ${this.queryCache.size} entries`);
  }
}

// Usage
const batchProcessor = new BatchProcessor(".undercity");
await batchProcessor.processBatch([
  "Add validation to user API",
  "Add validation to product API", // Cache hit - same prefix
  "Fix import error in utils",
  "Fix import error in handlers", // Cache hit - same prefix
  "Add cache invalidation logic",
]);
```

**When to use:**
- Processing 5+ similar tasks
- Tasks with common keywords
- High-throughput scenarios
- Optimization-critical paths

**Cache strategy:**
- Cache key = first 3 words of task (lowercased)
- Shared prefix → cache hit
- Reduces query time by ~90%

---

## Formula 9: Learning Quality Assessment

**Use case**: Filtering low-quality learnings before injection

**What it does**: Assesses learning quality and makes inject/skip recommendations

```typescript
import { findRelevantLearnings, type Learning } from "./knowledge.js";

interface LearningQuality {
  learning: Learning;
  successRate: number;
  isProven: boolean;
  recommendation: "inject" | "skip" | "monitor";
}

/**
 * Assess learning quality
 */
function assessLearningQuality(learning: Learning): LearningQuality {
  const successRate = learning.usedCount > 0 ? learning.successCount / learning.usedCount : 0.5;

  // Proven: used 3+ times with 70%+ success rate
  const isProven = learning.usedCount >= 3 && successRate >= 0.7;

  let recommendation: "inject" | "skip" | "monitor";
  if (isProven) {
    // High confidence - inject
    recommendation = "inject";
  } else if (learning.usedCount > 5 && successRate < 0.4) {
    // Many failures - skip
    recommendation = "skip";
  } else {
    // Uncertain - monitor (inject but track carefully)
    recommendation = "monitor";
  }

  return { learning, successRate, isProven, recommendation };
}

/**
 * Get quality-filtered learnings
 */
function getQualityFilteredLearnings(task: string, stateDir: string): Learning[] {
  const learnings = findRelevantLearnings(task, 10, stateDir);
  const assessed = learnings.map(assessLearningQuality);

  // Only inject proven or monitor-worthy learnings
  return assessed
    .filter((a) => a.recommendation !== "skip")
    .map((a) => a.learning);
}

// Usage
const qualityFiltered = getQualityFilteredLearnings("Add API validation", ".undercity");
console.log(`Quality-filtered learnings: ${qualityFiltered.length}`);

for (const learning of findRelevantLearnings("Add API validation", 10, ".undercity")) {
  const quality = assessLearningQuality(learning);
  console.log(`  [${quality.recommendation}] ${learning.content.substring(0, 50)}...`);
  console.log(`    Success rate: ${(quality.successRate * 100).toFixed(0)}%`);
}
```

**When to use:**
- Preventing injection of unreliable learnings
- High-accuracy tasks
- Iterating on learning quality
- Advanced knowledge management

**Quality thresholds:**
- **Inject**: 3+ uses, 70%+ success rate
- **Skip**: 5+ uses, <40% success rate
- **Monitor**: Uncertain cases

---

## Decision Matrix

| Use Case | Formula | Key Benefit |
|----------|---------|------------|
| Quick POC | 1 | Minimal code |
| Standard worker | 2 | Full lifecycle tracking |
| Bug fixes | 3 (gotcha) | Focused on pitfalls |
| New features | 3 (pattern) | Focused on conventions |
| Critical tasks | 4 | Only proven learnings |
| Parallel workers | 5 | Shared knowledge base |
| Production code | 6 | Never fails |
| Debugging | 7 | Diagnostic tools |
| Batch processing | 8 | ~90% cache savings |
| Quality control | 9 | Filters unreliable |

---

## Common Patterns

### Combining Formulas

You can combine formulas for more sophisticated patterns:

```typescript
// Formula 2 (Full Integration) + Formula 6 (Error Handling)
// = Production-ready worker with safe knowledge integration
class RobustWorker {
  async run(task: string): Promise<boolean> {
    let context = "";
    let ids: string[] = [];

    // Safe query (Formula 6)
    try {
      const learnings = findRelevantLearnings(task, 5, this.stateDir);
      context = formatLearningsForPrompt(learnings);
      ids = learnings.map((l) => l.id);
    } catch (error) {
      sessionLogger.warn({ error: String(error) }, "Knowledge query failed");
    }

    // Execute task
    const success = await executeTask(task, context);

    // Safe mark (Formula 6)
    try {
      markLearningsUsed(ids, success, this.stateDir);
    } catch (error) {
      sessionLogger.warn({ error: String(error) }, "Failed to mark learnings");
    }

    return success;
  }
}
```

```typescript
// Formula 3 (Category Filtering) + Formula 4 (Confidence Filtering)
// = Task-specific high-quality learnings
function getTaskSpecificQualityLearnings(
  task: string,
  taskType: "bugfix" | "feature" | "refactor",
  stateDir: string
): Learning[] {
  const category = taskType === "bugfix" ? "gotcha" : taskType === "feature" ? "pattern" : "preference";

  // Category filter
  const filtered = findByCategory(task, category, 10, stateDir);

  // Confidence filter
  return filtered.filter((l) => l.confidence >= 0.6);
}
```

---

## Troubleshooting

### Empty Query Results

**Problem**: `findRelevantLearnings` returns empty array

**Solutions**:
1. Check knowledge base has learnings:
   ```typescript
   const kb = loadKnowledge(".undercity");
   console.log(`Total: ${kb.learnings.length}`);
   ```

2. Verify keywords match (use Formula 7 diagnostics):
   ```typescript
   diagnoseQueryResult("Your task", ".undercity");
   ```

3. Lower confidence threshold:
   ```typescript
   const lowConf = findRelevantLearnings(task, 10)
     .filter(l => l.confidence >= 0.3); // Lower threshold
   ```

### Learnings Not Helping

**Problem**: Injected learnings don't improve success

**Solutions**:
1. Assess learning quality (Formula 9):
   ```typescript
   const quality = getQualityFilteredLearnings(task, ".undercity");
   ```

2. Filter by category (Formula 3):
   ```typescript
   const gotchas = findByCategory(task, "gotcha");
   ```

3. Check placement in prompt (should be early)

4. Review learning content (too vague?)

### Knowledge Growing Too Large

**Problem**: Knowledge base has 1000+ learnings, queries slow down

**Solutions**:
1. Prune unused learnings:
   ```typescript
   import { pruneUnusedLearnings } from "./knowledge.js";
   pruneUnusedLearnings(30 * 24 * 60 * 60 * 1000, ".undercity"); // Older than 30 days
   ```

2. Use batch processing (Formula 8) to cache queries

3. Use confidence filtering (Formula 4) to reduce candidates

---

## Real-World Examples

### Example 1: Bug Fix Worker

```typescript
// Combine formulas: 3 (Category) + 6 (Error Handling)
async function bugFixWorker(bug: string, stateDir: string): Promise<boolean> {
  try {
    // Use gotchas category for bug fixes
    const gotchas = findByCategory(bug, "gotcha", 5, stateDir);
    const context = formatLearningsForPrompt(gotchas);

    const success = await executeBugFix(bug, context);

    if (gotchas.length > 0) {
      const ids = gotchas.map((g) => g.id);
      markLearningsUsed(ids, success, stateDir);
    }

    return success;
  } catch (error) {
    sessionLogger.error({ error: String(error) }, "Bug fix failed");
    return false;
  }
}
```

### Example 2: Batch Feature Implementation

```typescript
// Combine formulas: 2 (Full Integration) + 3 (Category) + 8 (Batch)
class FeatureBatchWorker {
  private batchProcessor: BatchProcessor;

  constructor(stateDir: string) {
    this.batchProcessor = new BatchProcessor(stateDir);
  }

  async implementFeatures(features: string[]): Promise<void> {
    // Use patterns category for features
    for (const feature of features) {
      const patterns = findByCategory(feature, "pattern", 5, ".undercity");
      const context = formatLearningsForPrompt(patterns);

      const success = await executeFeature(feature, context);

      if (patterns.length > 0) {
        const ids = patterns.map((p) => p.id);
        markLearningsUsed(ids, success, ".undercity");
      }
    }
  }
}
```

### Example 3: Critical Production Deploy

```typescript
// Combine formulas: 4 (Confidence) + 6 (Error Handling)
async function deployToProduction(changes: string, stateDir: string): Promise<boolean> {
  try {
    // Use only proven learnings (>70% confidence)
    const provenLearnings = findHighConfidenceLearnings(changes, 0.7, 5, stateDir);
    const context = formatLearningsForPrompt(provenLearnings);

    const success = await executeDeployment(changes, context);

    if (provenLearnings.length > 0) {
      const ids = provenLearnings.map((l) => l.id);
      markLearningsUsed(ids, success, stateDir);
    }

    return success;
  } catch (error) {
    sessionLogger.error({ error: String(error) }, "Deployment failed");
    return false;
  }
}
```

---

## API Reference

See [Knowledge System API](../API.md#knowledge-system) for complete API documentation.

### Key Functions

- `findRelevantLearnings(objective, maxResults?, stateDir?)`: Query relevant learnings
- `formatLearningsForPrompt(learnings)`: Format for prompt injection
- `markLearningsUsed(ids, success, stateDir?)`: Update stats
- `addLearning(learning, stateDir?)`: Store new learning
- `loadKnowledge(stateDir?)`: Load entire knowledge base
- `getKnowledgeStats(stateDir?)`: Get statistics

---

## Further Reading

- [Knowledge System Architecture](../knowledge-system.md)
- [Worker Integration Guide](../worker-knowledge-integration.md)
- [Example Implementations](../../examples/worker-knowledge-patterns.ts)
- [Query Examples](../../examples/knowledge-queries.ts)
