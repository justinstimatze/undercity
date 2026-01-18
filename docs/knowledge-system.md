# Knowledge System

The knowledge system enables automatic learning from completed tasks. Learnings are extracted, stored, and injected into future task prompts to improve worker performance over time.

## Architecture

```
Task Completion → Knowledge Extraction → Storage → Retrieval → Prompt Injection
                        ↓                   ↓         ↓
                 Pattern Matching    knowledge.json  Worker Prompt
                 + Model (Haiku)
```

**Storage**: `.undercity/knowledge.json`

## Learning Categories

| Category | Description | Examples |
|----------|-------------|----------|
| `pattern` | Codebase conventions and structures | "This project uses Zod for validation schemas" |
| `gotcha` | Pitfalls, fixes, and workarounds | "The issue was missing .js extension in ESM imports" |
| `fact` | Discoveries about code behavior | "The cache invalidates after 5 minutes" |
| `preference` | User/project preferences | "Always use execFileSync over execSync for git commands" |

## Learning Structure

```typescript
interface Learning {
  id: string;              // Unique ID (learn-{timestamp}-{random})
  taskId: string;          // Source task that produced this learning
  category: LearningCategory;
  content: string;         // Natural language description
  keywords: string[];      // Keywords for retrieval (max 20)
  structured?: {
    file?: string;         // Related file path
    pattern?: string;      // Code pattern
    approach?: string;     // Implementation approach
  };
  confidence: number;      // 0-1, starts at 0.5
  usedCount: number;       // Times injected into prompts
  successCount: number;    // Times led to task success
  createdAt: string;       // ISO timestamp
  lastUsedAt?: string;     // Last injection timestamp
}
```

## Confidence Scoring

Confidence evolves based on learning reuse outcomes:

| Event | Confidence Change |
|-------|------------------|
| Initial creation | 0.5 (50%) |
| Successful reuse | +0.05 (max 0.95) |
| Failed reuse | -0.10 (min 0.10) |

**Retrieval scoring formula**: `score = (keyword_overlap * 0.7) + (confidence * 0.3)`

## Keyword Extraction

Keywords are extracted from learning content by:
1. Converting to lowercase
2. Removing punctuation
3. Filtering stop words (the, a, an, is, are, etc.)
4. Keeping words with length > 2
5. Deduplicating and limiting to top 20

## Duplicate Detection

New learnings are checked against existing ones using Jaccard similarity:

```
similarity = intersection(words) / union(words)
```

Learnings with >80% similarity are considered duplicates and not stored.

## Extraction Methods

### Model-Based Extraction (Primary)

Uses Haiku to analyze agent conversation and extract structured learnings:

**Extraction prompt focuses on:**
- Codebase patterns discovered
- Gotchas and fixes (problems + solutions)
- Facts learned
- User/project preferences

### Pattern Matching (Fallback)

Regex patterns detect learning indicators:

| Pattern Type | Examples |
|--------------|----------|
| Discovery | "I found that...", "I discovered that...", "It turns out..." |
| Problem Resolution | "The issue was...", "The fix is to...", "This failed because..." |
| Codebase Patterns | "This codebase uses...", "The convention here is..." |
| Important Notes | "Note:", "Important:", "Be careful to..." |

## Pruning

Unused learnings are automatically pruned after 30 days if they:
- Have never been used (`usedCount = 0`)
- Have low confidence (`confidence < 0.7`)
- Are older than the max age threshold

## API Reference

### loadKnowledge(stateDir?)

Load the knowledge base from disk.

```typescript
import { loadKnowledge } from "./knowledge.js";

const kb = loadKnowledge();
// Returns: { learnings: Learning[], version: string, lastUpdated: string }
```

### findRelevantLearnings(objective, maxResults?, stateDir?)

Find learnings relevant to a task objective.

```typescript
import { findRelevantLearnings } from "./knowledge.js";

const learnings = findRelevantLearnings(
  "Add authentication to the API",
  5  // max results (default: 5)
);
// Returns: Learning[] sorted by relevance score
```

### addLearning(learning, stateDir?)

Add a new learning to the knowledge base.

```typescript
import { addLearning } from "./knowledge.js";

const learning = addLearning({
  taskId: "task-abc123",
  category: "gotcha",
  content: "ESM imports require .js extension even for .ts files",
  keywords: ["esm", "import", "extension", "typescript"],
});
```

### markLearningsUsed(learningIds, taskSuccess, stateDir?)

Update learning stats after task completion.

```typescript
import { markLearningsUsed } from "./knowledge.js";

// After successful task
markLearningsUsed(["learn-xxx-yyy"], true);

// After failed task
markLearningsUsed(["learn-xxx-yyy"], false);
```

### formatLearningsForPrompt(learnings)

Format learnings for injection into agent prompts.

```typescript
import { formatLearningsForPrompt } from "./knowledge.js";

const prompt = formatLearningsForPrompt(learnings);
// Returns formatted string with learning content
```

### getKnowledgeStats(stateDir?)

Get statistics about the knowledge base.

```typescript
import { getKnowledgeStats } from "./knowledge.js";

const stats = getKnowledgeStats();
// Returns: { totalLearnings, byCategory, avgConfidence, mostUsed }
```

### pruneUnusedLearnings(maxAge?, stateDir?)

Remove old, unused, low-confidence learnings.

```typescript
import { pruneUnusedLearnings } from "./knowledge.js";

const prunedCount = pruneUnusedLearnings(
  30 * 24 * 60 * 60 * 1000  // 30 days in ms
);
```

## CLI Access

```bash
# Search knowledge base
undercity knowledge "authentication"

# View statistics
undercity knowledge --stats
```

## Storage File Format

```json
{
  "version": "1.0",
  "lastUpdated": "2024-01-15T10:30:00.000Z",
  "learnings": [
    {
      "id": "learn-lx2abc-def123",
      "taskId": "task-123",
      "category": "pattern",
      "content": "This project uses Zod schemas for all API validation",
      "keywords": ["zod", "schema", "validation", "api"],
      "confidence": 0.75,
      "usedCount": 5,
      "successCount": 4,
      "createdAt": "2024-01-10T08:00:00.000Z",
      "lastUsedAt": "2024-01-14T15:30:00.000Z"
    }
  ]
}
```

## Best Practices

1. **Let extraction happen automatically** - Knowledge extraction runs on every task completion
2. **Check relevance before use** - Use `findRelevantLearnings` with specific objectives
3. **Track outcomes** - Always call `markLearningsUsed` after using learnings
4. **Periodic pruning** - Run pruning to remove stale learnings
5. **Review stats** - Monitor `getKnowledgeStats` to understand learning effectiveness

## Advanced Patterns

### Bulk Querying with Custom Limits

Query more learnings for complex tasks:

```typescript
// Simple task: 3-5 learnings
const basicLearnings = findRelevantLearnings("Fix typo", 3);

// Complex task: 10-15 learnings
const complexLearnings = findRelevantLearnings("Refactor authentication system", 15);

// Review/analysis task: 20+ learnings
const analysisLearnings = findRelevantLearnings("Review codebase patterns", 20);
```

**Trade-off**: More learnings = more context but higher token cost.

### Category-Specific Filtering

Filter learnings by category for targeted queries:

```typescript
function findByCategoryAndRelevance(
  objective: string,
  category: LearningCategory,
  maxResults: number = 5
): Learning[] {
  const kb = loadKnowledge();
  const keywords = extractKeywordsFromObjective(objective);

  return kb.learnings
    .filter(l => l.category === category)
    .map(l => ({
      learning: l,
      score: calculateScore(l, keywords)
    }))
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.learning);
}

// Only inject gotchas for bug fix tasks
const gotchas = findByCategoryAndRelevance("Fix import error", "gotcha", 5);

// Only inject patterns for new features
const patterns = findByCategoryAndRelevance("Add authentication", "pattern", 5);
```

### Confidence Thresholds

Filter learnings by confidence before injection:

```typescript
function findHighConfidenceLearnings(
  objective: string,
  minConfidence: number = 0.6,
  maxResults: number = 5
): Learning[] {
  return findRelevantLearnings(objective, maxResults * 2) // Query more
    .filter(l => l.confidence >= minConfidence)
    .slice(0, maxResults); // Trim to max
}

// Only inject proven learnings
const proven = findHighConfidenceLearnings("Add validation", 0.7);
```

**Use cases**:
- Critical tasks: `minConfidence = 0.8` (only battle-tested learnings)
- Standard tasks: `minConfidence = 0.6` (moderately proven)
- Exploratory tasks: `minConfidence = 0.4` (include experimental learnings)

### Custom Relevance Weighting

Adjust keyword vs confidence weighting:

```typescript
function findWithCustomWeighting(
  objective: string,
  keywordWeight: number = 0.7,
  confidenceWeight: number = 0.3,
  maxResults: number = 5
): Learning[] {
  const kb = loadKnowledge();
  const keywords = extractKeywordsFromObjective(objective);

  return kb.learnings
    .map(l => {
      const keywordOverlap = calculateOverlap(keywords, l.keywords);
      const score = keywordOverlap * keywordWeight + l.confidence * confidenceWeight;
      return { learning: l, score };
    })
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.learning);
}

// Prioritize keyword match (for specific technical queries)
const keywordFocused = findWithCustomWeighting("ESM import error", 0.9, 0.1);

// Prioritize confidence (for general guidance)
const confidenceFocused = findWithCustomWeighting("best practices", 0.3, 0.7);
```

### Learning Lifecycle Management

Track and manage learning evolution:

```typescript
interface LearningHealth {
  learning: Learning;
  healthScore: number;
  status: "healthy" | "declining" | "stale";
  recommendation: string;
}

function assessLearningHealth(learning: Learning): LearningHealth {
  const successRate = learning.usedCount > 0
    ? learning.successCount / learning.usedCount
    : 0.5;

  const daysSinceCreated = (Date.now() - new Date(learning.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const daysSinceUsed = learning.lastUsedAt
    ? (Date.now() - new Date(learning.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24)
    : daysSinceCreated;

  let healthScore = 0;
  let status: "healthy" | "declining" | "stale" = "healthy";
  let recommendation = "";

  // Health scoring
  if (successRate > 0.7 && learning.usedCount > 5) {
    healthScore = 0.9;
    status = "healthy";
    recommendation = "Keep - proven valuable";
  } else if (successRate < 0.3 && learning.usedCount > 3) {
    healthScore = 0.2;
    status = "declining";
    recommendation = "Review - low success rate";
  } else if (daysSinceUsed > 60 && learning.usedCount === 0) {
    healthScore = 0.1;
    status = "stale";
    recommendation = "Prune - never used";
  } else {
    healthScore = 0.5;
    status = "healthy";
    recommendation = "Monitor";
  }

  return { learning, healthScore, status, recommendation };
}

// Assess all learnings
const kb = loadKnowledge();
const assessments = kb.learnings.map(assessLearningHealth);

// Find candidates for pruning
const pruneTargets = assessments.filter(a => a.status === "stale");
console.log(`Prune candidates: ${pruneTargets.length}`);
```

### Temporal Relevance

Prefer recently successful learnings:

```typescript
function findRecentSuccessful(
  objective: string,
  maxAgeDays: number = 30,
  maxResults: number = 5
): Learning[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return findRelevantLearnings(objective, maxResults * 2)
    .filter(l => l.lastUsedAt && new Date(l.lastUsedAt).getTime() > cutoff)
    .filter(l => l.confidence > 0.6)
    .slice(0, maxResults);
}

// Inject only recently proven learnings
const recent = findRecentSuccessful("API validation", 14); // Last 2 weeks
```

## Performance and Maintenance

### Pruning Strategy

Run periodic pruning to maintain knowledge base health:

```bash
# Manual pruning (30 days)
undercity knowledge --prune

# Custom age threshold
undercity knowledge --prune --max-age 60
```

**Pruning criteria**:
- Never used (`usedCount = 0`)
- Low confidence (`confidence < 0.7`)
- Older than threshold (default 30 days)

**When to prune**:
- Weekly for active projects (>50 tasks/week)
- Monthly for moderate projects (10-50 tasks/week)
- Quarterly for maintenance projects (<10 tasks/week)

### Monitoring Knowledge Base Size

Track knowledge base growth:

```typescript
import { getKnowledgeStats } from "./knowledge.js";

const stats = getKnowledgeStats();

if (stats.totalLearnings > 1000) {
  console.warn("Knowledge base exceeds 1000 learnings - consider aggressive pruning");
}

// Check category distribution
const categoryRatio = stats.byCategory.gotcha / stats.totalLearnings;
if (categoryRatio > 0.5) {
  console.warn("Gotchas dominate knowledge base - may indicate quality issues");
}
```

**Size targets**:
- Small projects: <100 learnings
- Medium projects: 100-500 learnings
- Large projects: 500-1000 learnings
- Enterprise: >1000 learnings (requires indexing optimization)

### Query Performance Optimization

For large knowledge bases (>500 learnings):

**1. Limit query scope**:
```typescript
// BAD: Query all learnings
const all = findRelevantLearnings(task, 50);

// GOOD: Query targeted subset
const targeted = findRelevantLearnings(task, 10);
```

**2. Cache frequent queries**:
```typescript
const queryCache = new Map<string, Learning[]>();

function findWithCache(objective: string, maxResults: number): Learning[] {
  const key = `${objective}:${maxResults}`;
  if (queryCache.has(key)) {
    return queryCache.get(key)!;
  }

  const results = findRelevantLearnings(objective, maxResults);
  queryCache.set(key, results);
  return results;
}
```

**3. Pre-filter by category**:
```typescript
// Load once, filter multiple times
const kb = loadKnowledge();
const patterns = kb.learnings.filter(l => l.category === "pattern");
const gotchas = kb.learnings.filter(l => l.category === "gotcha");
```

### Quality Maintenance

Monitor learning quality metrics:

```typescript
function analyzeQuality(): void {
  const kb = loadKnowledge();
  const stats = getKnowledgeStats();

  // Low success rate learnings
  const lowSuccess = kb.learnings.filter(l =>
    l.usedCount > 5 && (l.successCount / l.usedCount) < 0.4
  );
  console.log(`Low success rate: ${lowSuccess.length} learnings`);

  // Never used learnings
  const unused = kb.learnings.filter(l => l.usedCount === 0);
  console.log(`Unused: ${unused.length} learnings`);

  // High-value learnings
  const highValue = kb.learnings.filter(l =>
    l.usedCount > 10 && l.confidence > 0.8
  );
  console.log(`High-value: ${highValue.length} learnings`);
}
```

**Quality indicators**:
- High success rate (>70%) indicates valuable learnings
- Never used (after 30+ days) indicates poor keyword extraction
- Declining confidence indicates outdated or wrong learnings

## Related Systems

| System | Integration |
|--------|-------------|
| Task File Patterns | Records which files are modified for task types |
| Error Fix Patterns | Records error→fix mappings for reuse |
| Decision Tracker | Captures and resolves agent decisions |
| Automated PM | Uses knowledge for task generation |
