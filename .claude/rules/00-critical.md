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

## Git Rules

### No Bulk Staging

**NEVER use `git add -A` or `git add .`** - Stage specific files instead.

```bash
# BAD
git add -A
git add .

# GOOD
git add src/specific-file.ts
```

### No Attribution Lines in Commits

**Do NOT add Claude attribution to commit messages.** Skip these lines entirely:
- `Generated with [Claude Code]`
- `Co-Authored-By: Claude`

Just write a normal commit message describing the change.

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
