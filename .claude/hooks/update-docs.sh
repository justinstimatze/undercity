#!/bin/bash
# Hook to detect when documentation might need updating
set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/justin/Documents/undercity}"

# Check for new source files added in recent commits
NEW_SRC_FILES=$(cd "$PROJECT_DIR" && git diff --name-only HEAD~1..HEAD 2>/dev/null | grep '^src/.*\.ts$' | grep -v '\.test\.ts$' || true)

if [ -n "$NEW_SRC_FILES" ]; then
    echo "New source files detected - consider updating .claude/rules/05-codebase-map.md:"
    echo "$NEW_SRC_FILES" | sed 's/^/  - /'
fi

# Check for new command patterns in commit messages
RECENT_COMMIT=$(cd "$PROJECT_DIR" && git log --oneline -1 2>/dev/null || true)
if echo "$RECENT_COMMIT" | grep -qiE "(add.*command|new.*command|cli:)"; then
    echo "Potential new CLI command - consider updating .claude/rules/01-undercity.md"
fi

# Check for new exported functions in changed files
CHANGED_FILES=$(cd "$PROJECT_DIR" && git diff --name-only HEAD~1..HEAD 2>/dev/null | grep '^src/.*\.ts$' | grep -v '\.test\.ts$' || true)
if [ -n "$CHANGED_FILES" ]; then
    for file in $CHANGED_FILES; do
        if [ -f "$PROJECT_DIR/$file" ]; then
            NEW_EXPORTS=$(cd "$PROJECT_DIR" && git diff HEAD~1..HEAD -- "$file" 2>/dev/null | grep '^+export' | grep -v '^+++' || true)
            if [ -n "$NEW_EXPORTS" ]; then
                echo "New exports in $file - consider updating 05-codebase-map.md"
            fi
        fi
    done
fi

exit 0
