# Architecture Decision Records

Decisions that shaped undercity's architecture. Each captures *why*, not *what* (code shows what).

| ADR | Decision | Impact |
|-----|----------|--------|
| [0001](0001-worktree-isolation.md) | Worktrees over branch switching | Core parallelism model |
| [0002](0002-serial-merge-queue.md) | Serial merge with automatic retry | Merge correctness |
| [0003](0003-external-verification.md) | Verification outside agent loop | Quality assurance |
| [0004](0004-storage-topology.md) | SQLite (WAL) + JSON (file-lock) split | Concurrency model |
| [0005](0005-rebase-merging.md) | Rebase + fast-forward, no merge commits | Linear history |
| [0006](0006-review-tier-capping.md) | Cap review at sonnet for simple tasks | Token economy |
| [0007](0007-three-state-error-learning.md) | Pending/fixed/permanent error states | Auto-remediation |

**Format**: Status, Context, Decision, Consequences, Code Locations.
