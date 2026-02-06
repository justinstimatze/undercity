# ADR-0001: Worktree Isolation for Parallel Tasks

## Status
Accepted

## Context
Undercity runs multiple tasks in parallel. Each task needs a working directory to edit files, run builds, and commit. The two main options were:
1. **Branch switching** in a single repo (serialize all file operations)
2. **Git worktrees** (each task gets its own directory)

Branch switching serializes everything since only one branch can be checked out at a time. Stashing is fragile and doesn't scale beyond 2-3 concurrent tasks.

## Decision
Each task gets an isolated git worktree created by `WorktreeManager.createWorktree(taskId)`. Worktrees are placed in `<repo>-worktrees/task-<id>/` outside the main repo directory. Tasks branch from the current local main HEAD.

## Consequences
**Benefits:**
- True parallelism: N tasks can edit files simultaneously
- No git conflicts during execution (each has its own index)
- Clean rollback: delete the worktree directory
- Verification runs in isolation (one task's test failure doesn't affect another)

**Tradeoffs:**
- Disk space: each worktree is a full checkout (~100MB for large repos)
- Merge conflicts surface later (at merge time, not edit time)
- Worktree cleanup required on crash (handled by recovery system)

**What breaks if violated:**
- Running two tasks in the same directory causes file corruption and git index conflicts
- Branch switching mid-task loses uncommitted changes

## Code Locations
- `src/worktree-manager.ts` - WorktreeManager class (create, cleanup, list)
- `src/orchestrator.ts:993` - `createWorktree(taskId)` call per task
- `src/worker.ts` - Receives `workingDirectory` (the worktree path) as constructor param
