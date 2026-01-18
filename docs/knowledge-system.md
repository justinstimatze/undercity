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

## Related Systems

| System | Integration |
|--------|-------------|
| Task File Patterns | Records which files are modified for task types |
| Error Fix Patterns | Records error→fix mappings for reuse |
| Decision Tracker | Captures and resolves agent decisions |
| Automated PM | Uses knowledge for task generation |
