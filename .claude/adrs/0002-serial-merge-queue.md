# ADR-0002: Serial Merge Queue

## Status
Accepted

## Context
With N tasks completing in parallel (each in its own worktree), their branches need to be merged back to main. Two options:
1. **Parallel merge**: merge all branches concurrently
2. **Serial merge**: process one merge at a time via a queue

Parallel merging causes stale-base race conditions: task A and task B both rebase against the same main HEAD, but after A merges, B's rebase target is outdated. This produces silent conflicts or broken builds on main.

## Decision
`MergeQueue.processAll()` processes merges sequentially. Each merge: rebase onto current main HEAD, run verification, fast-forward merge. If a merge fails, retry with escalating strategies (default, theirs, ours). After each success, previously failed items are retried (conflicts may now be resolvable).

## Consequences
**Benefits:**
- Each merge sees the true current state of main
- Verification catches conflicts before they land on main
- Automatic retry resolves transient conflicts (file ordering issues)

**Tradeoffs:**
- Merge throughput is O(N) not O(1) - serialization adds wall-clock time
- A single stuck merge blocks the queue (mitigated by max retry + skip)

**What breaks if violated:**
- Parallel merges produce stale rebases where both tasks think main is at commit X, but after the first merge main is at X+1
- Silent merge conflicts pass verification in the worktree but fail on main

## Code Locations
- `src/merge-queue.ts` - MergeQueue class, `processAll()` method
- `src/orchestrator/merge-helpers.ts` - `processMerge()`, `queueForMerge()`
