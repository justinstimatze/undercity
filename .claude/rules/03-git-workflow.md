# Git Workflow

## Staging and Committing

**CRITICAL**: Never bulk-stage files. Always stage specific files relevant to the change.

**NOTE**: The following commands are **blocked in `.claude/settings.json`**:
- `git add -A`
- `git add .`
- `git add --all`
- `git stash -u` / `git stash --include-untracked`

If you attempt to use these commands, Claude Code should prevent them. If this enforcement fails, it indicates a configuration issue that must be fixed.

```bash
# BAD - stages everything including untracked research data, experiments, etc.
git add .
git add -A
git add --all

# GOOD - stage only the files you changed intentionally
git add src/types.ts src/persistence.ts
git add specific-file.ts

# GOOD - review what you're staging
git status
git diff --staged
```

**Before every commit:**
1. Run `git status` to see what's changed
2. Stage only files relevant to the current change
3. Review staged changes with `git diff --staged`
4. Commit with a focused message

**Swarm workflow (Rule of Five):**
- Sheriff reviews staged changes, not committed changes
- Quester and sheriff iterate on staged work before commit
- Multiple review passes happen pre-commit, not post-commit
- Only commit after sheriff approval

**Why this matters**: Bulk staging leads to accidentally committing local experiments, notes, and other files that shouldn't be in the repo. Review before commit catches issues earlier.

## Commit Messages

- Keep commit messages concise and descriptive
- Focus on what changed and why
- **Do NOT add Claude attribution lines**

```bash
# BAD
feat: Add feature

Co-Authored-By: Claude <noreply@anthropic.com>

# GOOD
Add raid status command with squad visibility
```

## Code Review Process

**CRITICAL**: When reviewing PRs, work with complete file content.

**Use extended thinking (ultrathink)** for thorough code reviews.

**Required steps:**
```bash
# 1. Checkout PR branch first
git fetch origin pull/PR_NUMBER/head:pr-PR_NUMBER
git checkout pr-PR_NUMBER

# 2. Read actual files, not parsed diffs
```

**Why**: `gh pr diff` is often truncated for large PRs. Reading actual files guarantees complete context.

**Avoid:**
```markdown
# BAD: Asserting unused based on truncated diff
"This constant appears unused"
(When it's used later in the file you didn't see)

# GOOD: Qualified statement
"In the visible portion of the diff, this appears unused -
please verify if it's used elsewhere"
```

## Review Focus

Prioritize critical analysis over praise:

- **Identify real issues**: bugs, edge cases, security, maintainability
- **Be specific**: Point to concrete technical issues
- **Avoid excessive praise**: Skip superlatives and cheerleading
- **No emojis in reviews**: Keep feedback professional

**Review checklist:**
- Security vulnerabilities?
- Error handling gaps?
- Edge cases not handled?
- Performance concerns?
- Missing validation or tests?
- Breaking changes?

## GitHub CLI

**PR management:**
```bash
gh pr view <number>      # Details
gh pr diff <number>      # Changes
gh pr checks <number>    # CI status
gh pr list               # Open PRs
```

**Workflow debugging:**
```bash
gh run list              # Recent runs
gh run view <run-id>     # Run details
gh run view <run-id> --log-failed  # Failed job logs
```

## Error Interpretation

**Don't assume file truncation** when error line numbers don't match file lengths.

**Debugging order:**
1. Assume error is stale/cached - check if it reproduces locally
2. Consider build artifacts or source maps
3. Check environment differences (CI vs local)
4. Only then consider file integrity issues

**Key insight**: Error messages can be stale, especially in CI. Line numbers often refer to built code, not source files.
