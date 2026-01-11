# Claude Code Configuration

This directory contains Claude Code configuration for the Undercity project.

## Structure

```
.claude/
├── CLAUDE.team.md              # Main team config entry point
├── README.md                   # This file
├── settings.json               # Tool permissions and Claude Code settings
└── rules/                      # Auto-loaded rules
    ├── 00-critical.md          # Non-negotiable rules
    ├── 01-undercity.md         # Undercity concepts and workflows
    ├── 02-code-style.md        # TypeScript, Zod, logging
    ├── 03-git-workflow.md      # Commits and code review
    └── 04-development.md       # Commands and development workflows
```

## How It Works

Claude Code automatically loads:
1. `.claude/settings.json` - Tool permissions (allowedTools, disallowedTools)
2. `.claude/CLAUDE.team.md` - Main team config
3. All files in `.claude/rules/` (numbered for load order)

## Tool Permissions (settings.json)

The `settings.json` file enforces critical rules programmatically:

**Pre-approved commands** (no permission prompt):
- `pnpm *`, `npm *` - All package manager commands
- `git status`, `git diff`, `git log`, `git branch`, `git checkout`, `git fetch`, `git show`

**Blocked commands** (enforces rules from `00-critical.md`):
- `git add -A`, `git add .`, `git add --all` - Bulk staging
- `git stash -u`, `git stash --include-untracked` - Stash with untracked
- `git push`, `git push *` - Prevent accidental pushes (use orchestrator)

**Why blocking bulk staging matters**: The repository has runtime state, logs, and temporary files that should never be committed. Bulk staging has repeatedly caused these files to slip into commits.

## Memory Hierarchy

If you have an existing personal `CLAUDE.md` in the project root:

1. **Personal CLAUDE.md takes priority** (highest in hierarchy)
2. **`.claude/rules/*.md` auto-loads alongside**
3. Both are active; personal overrides team where they conflict

## Integration Options

Choose how to integrate team config with your setup:

### Option A: Use Team Config Only (Recommended)

Move or delete your personal CLAUDE.md:
```bash
mv CLAUDE.md ~/.claude/CLAUDE.backup-personal.md
```

Claude Code will use `.claude/CLAUDE.team.md` and `.claude/rules/` as primary config.

### Option B: Hybrid (Import team config in personal)

Create a minimal personal CLAUDE.md that imports team config:
```markdown
# My Personal CLAUDE.md
@.claude/CLAUDE.team.md

## My Additions
- Personal preferences here
```

### Option C: Personal Priority

Keep your personal CLAUDE.md. Team rules still auto-load from `.claude/rules/` as baseline, but your personal config takes priority where they conflict.

## Keeping Rules Current

Rules should be updated when significant changes merge:

| Pattern | Rule File | Trigger |
|---------|-----------|---------|
| Git workflow changes | `03-git-workflow.md` | Worktree or merge strategy changes |
| New commands | `04-development.md` | New CLI commands or scripts |
| Architecture changes | `01-undercity.md` | Changes to raid/grind/squad concepts |
| Code patterns | `02-code-style.md` | New linting rules or patterns |

**After merging foundation changes**: Update the corresponding rule files to document the new patterns. This keeps the rules accurate as the codebase evolves.

## Contributing

When updating team config:
1. Edit files in `.claude/`
2. Test that rules load correctly (`/memory` in Claude Code)
3. Submit PR for review
