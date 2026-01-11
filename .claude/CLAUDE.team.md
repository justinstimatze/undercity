# Undercity - Team Configuration

This is the shared Claude Code configuration for the Undercity project.

## How This Works

Claude Code automatically loads:
1. This file (`.claude/CLAUDE.team.md`)
2. All files in `.claude/rules/` (numbered for load order)

## Quick Reference

**Start development:**
```bash
pnpm build                              # Compile TypeScript
pnpm dev                                # Watch mode
pnpm test                               # Run tests
```

**Format and lint:**
```bash
pnpm check                              # Format + lint
pnpm check:fix                          # Auto-fix issues
```

**Undercity operations:**
```bash
undercity slingshot "goal"              # Start raid (or resume)
undercity status                        # Check status
undercity approve                       # Approve plan
undercity extract                       # Complete raid
undercity surrender                     # Abort raid

undercity grind -n 10                   # Process 10 tasks
undercity watch                         # Live metrics dashboard
```

**PM2 daemon:**
```bash
pnpm daemon:start                       # Start daemon
pnpm daemon:status                      # Check status
pnpm daemon:logs                        # View logs
pnpm daemon:stop                        # Stop daemon
```

## Project Structure

```
src/
├── cli.ts                  # CLI entry point
├── commands/               # Command implementations
├── squad/                  # Agent definitions
├── types.ts                # Type definitions
├── persistence.ts          # State management
├── worktree-manager.ts     # Git worktree isolation
├── parallel-solo.ts        # Parallel task orchestration
├── solo.ts                 # Single task orchestration
└── __tests__/              # Vitest tests
```

## Key Rules

See `.claude/rules/00-critical.md` for non-negotiable rules:
- No scope creep
- No `git add -A` or `git stash -u` (enforced in settings.json)
- No `any` types
- Specific file staging for commits
- No automatic pushes (orchestrator controls)

For full documentation, see `.claude/README.md`.

## Undercity Concepts

**Session** - A single unit of work (replaces "raid" in codebase)
- Persisted in `.undercity/pocket.json`
- Has waypoints (plan steps) and squad members (agents)
- Can resume after crashes

**Grind** - Autonomous task board processing
- Reads from `.undercity/tasks.json`
- Runs tasks in parallel worktrees
- Routes by complexity (haiku → sonnet → opus)

**Worktrees** - Git worktree isolation for parallel work
- Each task runs in `.undercity/worktrees/<task-id>/`
- Branches from **local main** (includes unpushed work)
- Rebases onto **local main** before merging
- No automatic pushes to origin
