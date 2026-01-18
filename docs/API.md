# Undercity API Reference

## Table of Contents
- [Knowledge System](#knowledge-system)
- [Semantic Analyzer](#semantic-analyzer)
- [Task Analyzer](#task-analyzer)
- [Complexity Utilities](#complexity-utilities)
- [Context Management](#context-management)
- [Output Utilities](#output-utilities)
- [Rate Limit Management](#rate-limit-management)

## Knowledge System

The knowledge system enables learning from completed tasks. For comprehensive documentation, see:
- [Knowledge System Guide](./knowledge-system.md) - Architecture, categories, confidence scoring
- [Worker Integration Guide](./worker-knowledge-integration.md) - How workers use knowledge
- [Examples](../examples/knowledge-queries.ts) - Executable TypeScript examples

### Quick API Reference

#### `findRelevantLearnings(objective: string, maxResults?: number, stateDir?: string): Learning[]`
- **Purpose**: Find learnings relevant to a task objective
- **Parameters**:
  - `objective`: Task description to match against
  - `maxResults`: Maximum learnings to return (default: 5)
  - `stateDir`: State directory path (default: ".undercity")
- **Returns**: Array of relevant `Learning` objects sorted by relevance score
- **Example**:
```typescript
import { findRelevantLearnings } from "./knowledge.js";

const learnings = findRelevantLearnings("Add API validation", 5);
```

#### `formatLearningsForPrompt(learnings: Learning[]): string`
- **Purpose**: Format learnings for injection into agent prompts
- **Parameters**:
  - `learnings`: Array of Learning objects
- **Returns**: Formatted string for prompt inclusion
- **Example**:
```typescript
import { formatLearningsForPrompt } from "./knowledge.js";

const promptSection = formatLearningsForPrompt(learnings);
// Adds to agent context
```

#### `markLearningsUsed(learningIds: string[], taskSuccess: boolean, stateDir?: string): void`
- **Purpose**: Update learning stats after task completion
- **Parameters**:
  - `learningIds`: IDs of learnings that were used
  - `taskSuccess`: Whether the task succeeded
  - `stateDir`: State directory path
- **Example**:
```typescript
import { markLearningsUsed } from "./knowledge.js";

// After task completes
markLearningsUsed(injectedLearningIds, true);
```

#### `addLearning(learning: Partial<Learning>, stateDir?: string): Learning`
- **Purpose**: Add a new learning to the knowledge base
- **Parameters**:
  - `learning`: Learning data (taskId, category, content, keywords required)
  - `stateDir`: State directory path
- **Returns**: Complete Learning object with generated ID
- **Example**:
```typescript
import { addLearning } from "./knowledge.js";

const learning = addLearning({
  taskId: "task-123",
  category: "gotcha",
  content: "ESM requires .js extension",
  keywords: ["esm", "import"]
});
```

#### `getKnowledgeStats(stateDir?: string): KnowledgeStats`
- **Purpose**: Get knowledge base statistics
- **Returns**: Stats including totalLearnings, byCategory, avgConfidence, mostUsed
- **Example**:
```typescript
import { getKnowledgeStats } from "./knowledge.js";

const stats = getKnowledgeStats();
console.log(`Total: ${stats.totalLearnings}`);
```

### Learning Categories

| Category | Description |
|----------|-------------|
| `pattern` | Codebase conventions |
| `gotcha` | Pitfalls and fixes |
| `fact` | Code discoveries |
| `preference` | Project preferences |

## Semantic Analyzer

### `SemanticAnalyzer.analyze(options: AnalyzerOptions): Promise<SemanticReport>`
- **Purpose**: Analyze codebase for semantic density
- **Parameters**:
  - `options.rootDir`: Base directory to analyze (string)
  - `options.include?`: Optional array of file globs to include
  - `options.exclude?`: Optional array of file globs to exclude
- **Returns**: Promise resolving to comprehensive `SemanticReport`
- **Error Handling**:
  - Silently handles file read errors
  - Returns partial report if some files cannot be read
  - Logs warnings for inaccessible files
  - Will return an empty report if root directory is invalid
- **Example Usage**:
```typescript
const analyzer = new SemanticAnalyzer();
const report = await analyzer.analyze({
  rootDir: './src',
  include: ['**/*.ts'],
  exclude: ['**/*.test.ts']
});
```

## Task Analyzer

### `TaskAnalyzer.analyzeTask(task: Task): Promise<TaskAnalysis>`
- **Purpose**: Perform in-depth analysis of a task
- **Parameters**:
  - `task`: Task object containing objective and metadata
- **Returns**: Task analysis with complexity, packages, risk score
- **Example Usage**:
```typescript
const analyzer = new TaskAnalyzer();
const analysis = await analyzer.analyzeTask({
  id: 'task-123',
  objective: 'Implement user authentication'
});
```

### `TaskAnalyzer.assessComplexity(objective: string): "low" | "medium" | "high"`
- **Purpose**: Quick complexity assessment of task
- **Parameters**:
  - `objective`: Task description string
- **Returns**: Complexity level
- **Example Usage**:
```typescript
const complexity = analyzer.assessComplexity(
  'Add new API endpoint for user registration'
);
```

## Complexity Utilities

### `assessComplexityFast(task: string): ComplexityAssessment`
- **Purpose**: Rapid complexity estimation
- **Parameters**:
  - `task`: Task description string
- **Returns**: Complexity assessment with confidence
- **Example Usage**:
```typescript
const assessment = assessComplexityFast(
  'Refactor authentication middleware'
);
```

### `assessComplexityDeep(task: string): Promise<ComplexityAssessment>`
- **Purpose**: In-depth complexity analysis with LLM
- **Parameters**:
  - `task`: Task description string
- **Returns**: Detailed complexity assessment
- **Error Handling**:
  - Falls back to fast assessment on LLM failure
  - Returns `{ complexity: 'unknown', confidence: 0 }` if all assessment methods fail
  - Logs warning when fallback occurs
  - Timeout set to 10 seconds for deep assessment
- **Example Usage**:
```typescript
const deepAssessment = await assessComplexityDeep(
  'Design distributed caching system'
);
```

## Context Management

### `prepareContext(task: string, options?: { cwd?: string; repoRoot?: string }): Promise<ContextBriefing>`
- **Purpose**: Prepare comprehensive task context
- **Parameters**:
  - `task`: Task description
  - `options.cwd?`: Current working directory
  - `options.repoRoot?`: Repository root path
- **Returns**: Context briefing with file/type details
- **Error Handling**:
  - Logs warnings for context preparation failures
  - Returns minimal context if critical files are inaccessible
  - Timeout set to 15 seconds for context gathering
  - Skips processing for unreadable or malformed files
  - Will return an empty context if no relevant files found
- **Example Usage**:
```typescript
const context = await prepareContext(
  'Add authentication to REST API',
  { cwd: process.cwd() }
);
```

## Output Utilities

### `output.info(message: string, data?: Record<string, unknown>): void`
- **Purpose**: Log informational message
- **Parameters**:
  - `message`: Information to log
  - `data?`: Optional metadata
- **Example Usage**:
```typescript
output.info('Task started', { taskId: '123' });
```

### `output.error(message: string, data?: Record<string, unknown>): void`
- **Purpose**: Log error message
- **Parameters**:
  - `message`: Error description
  - `data?`: Optional error metadata
- **Example Usage**:
```typescript
output.error('Task processing failed', {
  taskId: '123',
  reason: 'Unauthorized'
});
```

## Rate Limit Management

### `RateLimitTracker.recordTask(taskId: string, model: ModelType, inputTokens: number, outputTokens: number): void`
- **Purpose**: Record token usage for a specific task
- **Parameters**:
  - `taskId`: Unique task identifier
  - `model`: Model used ('haiku', 'sonnet', 'opus')
  - `inputTokens`: Number of input tokens
  - `outputTokens`: Number of output tokens
- **Example Usage**:
```typescript
rateLimitTracker.recordTask(
  'task-123',
  'sonnet',
  1500,
  2000
);
```

### `RateLimitTracker.getUsageSummary(): UsageSummary`
- **Purpose**: Get comprehensive usage report
- **Returns**: Detailed usage statistics
- **Example Usage**:
```typescript
const usageSummary = rateLimitTracker.getUsageSummary();
console.log(usageSummary.current);
```

## Notes
- All functions are typed and follow TypeScript strict mode
- Error handling varies by function - check individual method documentation
- Prefer using provided utility functions over direct manipulation

## Conventions
- Use `output.*` methods for logging instead of `console.*`
- Respect rate limit tracking for AI model usage
- Handle complexity assessment before task execution

## Best Practices
1. Always prepare context before task execution
2. Use appropriate complexity assessment
3. Log tasks and errors using output utilities
4. Track token usage via RateLimitTracker