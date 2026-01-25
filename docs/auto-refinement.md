# Auto-Refinement

Automatic task enrichment during grind execution.

## What is Auto-Refinement?

Auto-refinement automatically enriches tasks that lack rich ticket content before execution. When a task has only a minimal objective and no detailed context, the orchestrator calls the PM to generate:

- **Description**: Expanded explanation of the task
- **Acceptance criteria**: Specific conditions for "done"
- **Test plan**: How to verify completion
- **Implementation notes**: Approach hints, patterns to follow
- **Rationale**: Why the task matters

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ Task Board                                                   │
│ - Task 1: "Add rate limiting" (no ticket)                   │
│ - Task 2: "Fix auth bug" (no ticket)                        │
│ - Task 3: "Update docs" (already has rich ticket)           │
└─────────────────────────────────────────────────────────────┘
                          ↓
                    undercity grind
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator: extractObjectivesAndContexts()                │
│                                                              │
│  For each task:                                              │
│  1. Check if task.ticket exists and has description          │
│  2. If missing → pmRefineTask(objective)                     │
│  3. If successful → updateTaskTicket(id, enrichedTicket)     │
│  4. Store enriched ticket for worker use                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Workers execute with rich context                           │
│ - Task 1: Now has detailed guidance                         │
│ - Task 2: Now has detailed guidance                         │
│ - Task 3: Uses existing rich ticket                         │
└─────────────────────────────────────────────────────────────┘
```

## When Auto-Refinement Happens

Auto-refinement triggers when a task from the database:
- Has no `ticket` field, OR
- Has a `ticket` field but no `description`

**No refinement needed:**
- Tasks with existing rich tickets (already refined)
- Direct `runSolo()` calls with string objectives (not from database)

## Token Cost

Auto-refinement adds an LLM call per task that needs enrichment:
- **Cost**: ~500-1000 tokens per refinement
- **Benefit**: Better first-attempt success rates, fewer retries
- **Net effect**: Often saves tokens by reducing rework

## Implementation Location

| File | Function | Purpose |
|------|----------|---------|
| `orchestrator.ts` | `extractObjectivesAndContexts()` | Auto-refines tasks before execution |
| `automated-pm.ts` | `pmRefineTask()` | Generates rich ticket content |
| `task.ts` | `updateTaskTicket()` | Persists enriched ticket to database |

## Workflow Example

```bash
# Add tasks with minimal context
undercity add "Add rate limiting to API"
undercity add "Fix authentication bug"

# Start grind - auto-refinement happens automatically
undercity grind

# Logs show auto-refinement:
# [info] Task lacks ticket content, auto-refining
#        taskId: task-abc123
#        objective: "Add rate limiting to API"
#
# [info] Task auto-refined successfully
#        taskId: task-abc123
#        tokensUsed: 847
#        hasDescription: true
#        hasAcceptanceCriteria: true
```

## Manual Refinement (Optional)

You can still manually refine tasks if you want to review enrichments before grind:

```bash
# Manually refine before grind
undercity refine --all     # Enrich all tasks
undercity refine -n 10     # Enrich up to 10 tasks

# Then grind with pre-enriched tasks (no auto-refinement needed)
undercity grind
```

## Validation via Experiments

To validate that auto-refinement improves task outcomes, use the experimentation framework:

```bash
# Create experiment
undercity experiment create "auto-refine-validation" \
  --variants control,treatment

# Control: Skip auto-refinement
# Treatment: Auto-refine before execution

# Run 30-50 tasks
undercity grind -n 50

# Analyze results
undercity experiment results
undercity experiment recommend

# Metrics to check:
# - Success rate (does rich context reduce failures?)
# - Total tokens per task (refinement cost + execution cost)
# - Rework count (fewer retries with better guidance?)
```

## Error Handling

Auto-refinement failures are non-fatal:
- Logs warning if refinement fails
- Task proceeds with minimal context (original objective only)
- Worker gets baseline prompt without enriched ticket

```typescript
try {
  const refineResult = await pmRefineTask(t.objective, this.repoRoot);
  if (refineResult.success) {
    ticket = refineResult.ticket;
    updateTaskTicket(t.id, ticket);
  }
} catch (error) {
  sessionLogger.warn(
    { error: String(error), taskId: t.id },
    "Auto-refinement failed, proceeding with minimal context"
  );
}
```

## Performance Considerations

**Serial refinement**: Auto-refinement happens serially during task extraction, before workers spawn. For large batches, this adds latency upfront.

**Future optimization**: Could batch refinements in parallel if performance becomes an issue:
```typescript
// Potential optimization (not implemented):
const refinements = await Promise.allSettled(
  tasksNeedingRefinement.map(t => pmRefineTask(t.objective))
);
```

## Integration with Other Systems

Auto-refinement integrates with existing undercity systems:

| System | Integration Point |
|--------|-------------------|
| **Knowledge Base** | `pmRefineTask()` uses `findRelevantLearnings()` |
| **Task-File Patterns** | `pmRefineTask()` uses `findRelevantFiles()` |
| **RAG Search** | `pmRefineTask()` searches for similar past work |
| **Task Board** | Enriched tickets persisted via `updateTaskTicket()` |
| **Worker Context** | Workers inject ticket via `formatTicketContext()` |

## Disabling Auto-Refinement

Currently auto-refinement is always-on for tasks from the database. To disable:

**Option 1**: Pre-refine all tasks manually
```bash
undercity refine --all
```

**Option 2**: Add minimal placeholder tickets
```bash
# Add task with minimal ticket to skip auto-refinement
echo 'objective: Do something
description: "TBD"' > task.yaml
undercity add "x" --from-file task.yaml
```

**Option 3**: Use direct worker calls (bypasses orchestrator)
```typescript
import { runSolo } from "./worker.js";
await runSolo(["Fix the bug"], options);
```

## See Also

- [Rich Task Tickets](../templates/SKILL.md) - Ticket file format
- [Automated PM](./API.md#automated-pm) - PM task generation
- [Knowledge System](./knowledge-system.md) - Learning integration
- [Experiments](../.undercity/experiments/README.md) - A/B testing framework
