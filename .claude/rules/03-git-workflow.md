# Git Workflow

## Staging and Committing

**CRITICAL**: Never bulk-stage files. Always stage specific files relevant to the change.

**Blocked in `.claude/settings.json`**: `git add -A`, `git add .`, `git add --all`, `git stash -u`.

```bash
# GOOD - stage only the files you changed
git add src/types.ts src/persistence.ts
```

**Before every commit:**
1. `git status` to see what changed
2. Stage only relevant files
3. `git diff --staged` to review
4. Commit with a focused message

## Commit Messages

- Concise and descriptive
- Focus on what and why
- **No Claude attribution lines**

```bash
# GOOD
Add status command with active worker visibility
```

## Code Review Process

When reviewing PRs, checkout the branch and read actual files (not parsed diffs). `gh pr diff` is often truncated for large PRs.

```bash
git fetch origin pull/PR_NUMBER/head:pr-PR_NUMBER
git checkout pr-PR_NUMBER
```

Use extended thinking (ultrathink) for thorough reviews.

## Review Focus

Prioritize critical analysis over praise:
- Security vulnerabilities?
- Error handling gaps?
- Edge cases not handled?
- Performance concerns?
- Missing validation or tests?
- Breaking changes?
