# ADR-0005: Rebase + Fast-Forward Merging

## Status
Accepted

## Context
When merging task branches back to main, three strategies exist:
1. **Merge commits**: `git merge --no-ff` (creates merge bubbles)
2. **Squash merge**: `git merge --squash` (one commit per task)
3. **Rebase + fast-forward**: rebase onto main, then `git merge --ff-only`

## Decision
Use rebase + fast-forward. Each task branch is rebased onto current main HEAD, verified post-rebase, then fast-forward merged. This produces linear history where each commit represents a completed, verified task.

## Consequences
**Benefits:**
- Linear git history: `git log --oneline` shows clean task progression
- Each commit is independently verified (built and tested post-rebase)
- Bisect works reliably (no merge commits to skip)
- Simple rollback: revert a single commit to undo a task

**Tradeoffs:**
- Rebase rewrites history (task branch SHAs change) - acceptable since branches are ephemeral
- Rebase conflicts require resolution (handled by MergeQueue retry strategies)
- Cannot preserve original branch topology for debugging

**What breaks if violated:**
- Merge commits create non-linear history that complicates bisect and revert
- Without post-rebase verification, rebased code may not compile (rebase can introduce conflicts)
- Skipping fast-forward (using `--no-ff`) creates unnecessary merge commits

## Code Locations
- `src/merge-queue.ts` - Rebase + verify + fast-forward pipeline
- `src/git.ts` - `rebase()`, `merge()` functions
