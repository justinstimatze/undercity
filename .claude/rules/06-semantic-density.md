# Semantic Density Analysis

Tool for measuring and optimizing semantic density across code and documentation.

## What is Semantic Density?

**Semantic density = facts per 1000 tokens**

Facts are atomic, actionable pieces of information:
- Type definitions
- Function signatures
- Constants/enums
- Configuration values
- Decision tree branches
- Table rows
- Command descriptions
- Mappings (file → purpose)
- Constraints (must/never/always)

## Commands

```bash
pnpm semantic-check           # Analyze codebase (JSON output)
pnpm semantic-check:fix       # Auto-fix issues
undercity semantic-check --human   # Human-readable report
```

## Output Format

Default: Machine-readable JSON for agent consumption

```json
{
  "files": [
    {
      "path": "src/file.ts",
      "type": "code",
      "tokens": 1000,
      "facts": 50,
      "density": 50.0,
      "issues": [
        {
          "type": "redundant_comment",
          "line": 45,
          "severity": "medium",
          "message": "Comment repeats what code says"
        }
      ]
    }
  ],
  "redundancies": [
    {
      "fact": "Definition of TaskStatus",
      "locations": ["src/types.ts:15", "src/task.ts:8"],
      "action": "consolidate"
    }
  ],
  "actions": [
    {
      "priority": "high",
      "type": "remove_lines",
      "file": "src/file.ts",
      "data": {"lines": [45, 67]},
      "description": "Remove redundant comments"
    }
  ],
  "metrics": {
    "totalTokens": 156789,
    "totalFacts": 8432,
    "avgDensity": 0.054,
    "potentialSavings": 8234,
    "savingsPercent": 5.2
  }
}
```

## Issue Types

| Type | Description | Severity |
|------|-------------|----------|
| `redundant_comment` | Comment restates code | medium |
| `unclear_naming` | Generic variable names (foo, tmp, data) | low |
| `low_density` | Prose that should be structured | medium |
| `duplicate_definition` | Same type/interface defined multiple times | high |
| `prose_vs_table` | Narrative text better as table | medium |

## Action Types

| Type | What it does | Auto-fixable |
|------|--------------|--------------|
| `remove_lines` | Delete redundant comments | Yes |
| `rename_symbol` | Clarify unclear names | Partial |
| `convert_to_table` | Prose → structured format | No |
| `consolidate_definition` | Merge duplicate definitions | No |

## Usage in Agent Workflow

```typescript
// Agent reads semantic report
const report = await runSemanticCheck({rootDir: process.cwd()});

// Process actions
for (const action of report.actions.filter(a => a.priority === 'high')) {
  switch (action.type) {
    case 'remove_lines':
      await removeLines(action.file, action.data.lines);
      break;
    case 'consolidate_definition':
      await consolidateDefinition(action.data);
      break;
  }
}
```

## File Type Detection

| Pattern | Type | Facts Extracted |
|---------|------|-----------------|
| `.claude/rules/**/*.md` | claude_rules | Mappings, constraints, decision branches, commands |
| `*.md` | docs | Commands, table rows, decision branches |
| `*.ts` | code | Types, functions, constants, enums |
| `__tests__/**` | test | Function signatures |
| `*.json` | config | Key-value pairs |

## Density Targets

| File Type | Good Density | Excellent Density |
|-----------|--------------|-------------------|
| claude_rules | >0.10 | >0.15 |
| docs | >0.08 | >0.12 |
| code | >0.03 | >0.05 |
| config | >0.05 | >0.10 |

## What Gets Flagged

**Redundant comments:**
```typescript
// BAD: Comment repeats code
// Set status to complete
status = 'complete';

// GOOD: Comment adds context
// Mark complete to trigger downstream notifications
status = 'complete';
```

**Low-density prose:**
```markdown
<!-- BAD: Narrative explanation -->
Undercity is a powerful tool that helps you manage tasks efficiently.
It provides robust features for handling complex workflows.

<!-- GOOD: Structured facts -->
| Feature | Purpose |
|---------|---------|
| Task board | Queue work items |
| Grind | Autonomous execution |
| Worktrees | Parallel isolation |
```

**Unclear naming:**
```typescript
// BAD
const tmp = items.find(item => item.data);

// GOOD
const matchingItem = items.find(item => item.hasData);
```

## Integration with CI

```yaml
# .github/workflows/semantic-check.yml
- name: Check semantic density
  run: pnpm semantic-check
  # Exits 1 if high-priority issues found
```

## Optimization Strategy

1. Run `pnpm semantic-check` to identify issues
2. Address high-priority items first (duplicates, major redundancy)
3. Use `--fix` for auto-fixable items (comments)
4. Manually convert low-density prose to tables/lists
5. Track density improvements over time

## Goals

- Reduce token usage for agent comprehension
- Increase fact density across codebase
- Eliminate redundancy
- Optimize for agent navigation speed
- Make information instantly actionable
