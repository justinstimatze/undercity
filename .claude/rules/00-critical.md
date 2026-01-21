# Critical Rules

These rules are non-negotiable.

## Avoid Scope Creep

**CRITICAL**: When fixing bugs or implementing features, stay focused on the specific task at hand.

**Guidelines:**
1. **Fix Only What's Broken**: Address only the specific issue or feature requested
2. **Resist Temptation**: Even if you notice other improvements, don't include them
3. **Separate Concerns**: Each change should have a single, clear purpose
4. **Ask Before Expanding**: If you believe additional changes are necessary, ask first

**The best PR does exactly what was asked—nothing more, nothing less.**

## Update Documentation After Code Changes

**CRITICAL**: When making code changes, always check if documentation needs updating.

**Update `.claude/rules/01-undercity.md` when:**
- Adding new CLI commands → Add to "Basic Commands" section
- Adding new analysis commands → Add to "Analysis & Post-Mortem" section
- Changing command behavior → Update relevant command descriptions
- Adding new persistence files → Update "Persistence Files" table

**Update `.claude/rules/05-codebase-map.md` when:**
- Adding new source files → Add to "File → Purpose" table
- Adding new exported functions → Add to "Task → File Mapping" section
- Adding new state files → Add to "State Files" table
- Changing file responsibilities → Update file descriptions

**Checklist after implementation:**
1. Did you add a new command? → Update 01-undercity.md
2. Did you add a new file? → Update 05-codebase-map.md
3. Did you add new exported functions? → Update 05-codebase-map.md
4. Did you change how a feature works? → Update relevant rule file

**Why**: Stale documentation causes agents to make incorrect assumptions and miss available tools.

## Git Rules

### Never Push Automatically

**NEVER push to remote without explicit user request.** Always stop after committing and let the user verify the repo state locally before pushing.

```bash
# BAD - pushing without user verification
git commit -m "Add feature" && git push

# GOOD - commit, then wait for user to push
git commit -m "Add feature"
# Stop here - user will push when ready
```

### No Bulk Staging

**NEVER use `git add -A` or `git add .`** - Stage specific files instead.

```bash
# BAD
git add -A
git add .

# GOOD
git add src/specific-file.ts
```

### No Destructive Git Resets

**NEVER use broad git reset/checkout commands that discard uncommitted work:**

```bash
# BAD: Destroys all uncommitted changes
git checkout -- .
git reset --hard HEAD
git clean -fd  # on the whole repo

# GOOD: Reset specific files only
git checkout -- path/to/specific/file.ts
git restore path/to/specific/file.ts
```

**Why**: Broad resets can destroy hours of uncommitted implementation work. Always target specific files, or commit your work before resetting.

### No Attribution Lines in Commits

**Do NOT add Claude attribution to commit messages.** Skip these lines entirely:
- `Generated with [Claude Code]`
- `Co-Authored-By: Claude`

Just write a normal commit message describing the change.

## Use CLI Commands, Not Direct JSON Edits

**NEVER edit `.undercity/tasks.json` directly.** Use CLI commands instead:

```bash
# BAD - directly editing JSON
cat .undercity/tasks.json | jq '...' > tasks.json

# GOOD - use CLI commands
undercity add "task description"    # Add task
undercity complete <task-id>        # Mark complete
undercity reconcile                 # Clean up duplicates
undercity tasks --all               # View tasks
```

**Why**: Direct JSON edits bypass validation, can corrupt state, and don't trigger proper status updates.

## Never Use `any` Types

**CRITICAL: Never use `any` types** - they eliminate TypeScript's safety benefits.

```typescript
// BAD
const data = response as any;

// GOOD
const data = response as ExpectedType;
```

## Language Preferences

Avoid corporate jargon:
- Never use "quick wins" — say "small standalone PRs"
- Avoid buzzwords like "leverage", "synergy", "align"

Avoid excessive validation:
- Never use "you're absolutely right" or "you're correct"
- Avoid superlatives like "excellent point", "great question"
- State facts directly without emotional validation
