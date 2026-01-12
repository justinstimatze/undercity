#!/usr/bin/env bash
# Cleanup script for Undercity state files
# Run this before starting a fresh grind to clear stale state
#
# Usage:
#   pnpm cleanup       - Light cleanup (session state)
#   pnpm cleanup --deep - Deep cleanup (old dirs, caches, backups)

set -euo pipefail

UNDERCITY_DIR=".undercity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEEP_CLEAN=false

# Parse arguments
if [[ "${1:-}" == "--deep" ]]; then
    DEEP_CLEAN=true
fi

cd "$REPO_ROOT"

if [[ "$DEEP_CLEAN" == true ]]; then
    echo "🧹 Undercity Deep Cleanup"
else
    echo "🧹 Undercity State Cleanup"
fi
echo "=========================="
echo

# Check if .undercity exists
if [[ ! -d "$UNDERCITY_DIR" ]]; then
    echo "❌ $UNDERCITY_DIR directory not found"
    exit 1
fi

# Function to backup a file
backup_file() {
    local file=$1
    if [[ -f "$file" ]]; then
        local backup="${file}.backup-$(date +%Y%m%d-%H%M%S)"
        cp "$file" "$backup"
        echo "  📦 Backed up to: $backup"
    fi
}

# 1. Clear parallel recovery state
echo "1. Clearing parallel recovery state..."
if [[ -f "$UNDERCITY_DIR/parallel-recovery.json" ]]; then
    backup_file "$UNDERCITY_DIR/parallel-recovery.json"
    echo '{}' > "$UNDERCITY_DIR/parallel-recovery.json"
    echo "  ✓ Cleared parallel-recovery.json"
else
    echo "  ℹ No parallel-recovery.json found"
fi
echo

# 2. Clear file tracking
echo "2. Clearing file tracking..."
if [[ -f "$UNDERCITY_DIR/file-tracking.json" ]]; then
    backup_file "$UNDERCITY_DIR/file-tracking.json"
    echo "{\"entries\":{},\"lastUpdated\":\"$(date -Iseconds)\"}" > "$UNDERCITY_DIR/file-tracking.json"
    echo "  ✓ Cleared file-tracking.json"
else
    echo "  ℹ No file-tracking.json found"
fi
echo

# 3. Clear worktree state
echo "3. Clearing worktree state..."
if [[ -f "$UNDERCITY_DIR/worktree-state.json" ]]; then
    backup_file "$UNDERCITY_DIR/worktree-state.json"
    echo "{\"worktrees\":{},\"lastUpdated\":\"$(date -Iseconds)\"}" > "$UNDERCITY_DIR/worktree-state.json"
    echo "  ✓ Cleared worktree-state.json"
else
    echo "  ℹ No worktree-state.json found"
fi
echo

# 4. Check for orphaned git worktrees
echo "4. Checking for orphaned git worktrees..."
orphaned_worktrees=$(git worktree list --porcelain | grep -c "^worktree.*undercity" || true)
if [[ $orphaned_worktrees -gt 1 ]]; then
    echo "  ⚠️  Found $((orphaned_worktrees - 1)) worktree(s) (excluding main)"
    echo "  📋 Run 'git worktree list' to inspect"
    echo "  🗑️  Run 'git worktree remove <path>' to clean up manually"
else
    echo "  ✓ No orphaned worktrees"
fi
echo

# 5. Archive old grind events (if large)
echo "5. Checking grind event log..."
if [[ -f "$UNDERCITY_DIR/grind-events.jsonl" ]]; then
    line_count=$(wc -l < "$UNDERCITY_DIR/grind-events.jsonl")
    echo "  📊 Current size: $line_count lines"

    if [[ $line_count -gt 1000 ]]; then
        echo "  ⚠️  Event log is large (>1000 lines)"
        read -p "  Archive old events? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            archive_path="$UNDERCITY_DIR/grind-events-$(date +%Y%m%d-%H%M%S).jsonl"
            mv "$UNDERCITY_DIR/grind-events.jsonl" "$archive_path"
            echo "  ✓ Archived to: $archive_path"
            touch "$UNDERCITY_DIR/grind-events.jsonl"
        else
            echo "  ℹ Skipped archiving"
        fi
    else
        echo "  ✓ Event log size is reasonable"
    fi
else
    echo "  ℹ No grind-events.jsonl found"
fi
echo

# 6. Clear grind progress (if exists)
echo "6. Clearing grind progress..."
if [[ -f "$UNDERCITY_DIR/grind-progress.json" ]]; then
    backup_file "$UNDERCITY_DIR/grind-progress.json"
    rm "$UNDERCITY_DIR/grind-progress.json"
    echo "  ✓ Cleared grind-progress.json"
else
    echo "  ℹ No grind-progress.json found"
fi
echo

# 7. Deep cleanup (optional)
if [[ "$DEEP_CLEAN" == true ]]; then
    echo "7. Deep cleanup - removing old directories and caches..."
    echo

    # Remove old agent state directories
    if [[ -d "$UNDERCITY_DIR/squad" ]]; then
        count=$(find "$UNDERCITY_DIR/squad" -type f 2>/dev/null | wc -l || echo 0)
        echo "  🗑️  Removing squad/ ($count files)"
        rm -rf "$UNDERCITY_DIR/squad"
    fi

    if [[ -d "$UNDERCITY_DIR/raids" ]]; then
        echo "  🗑️  Removing raids/"
        rm -rf "$UNDERCITY_DIR/raids"
    fi

    if [[ -d "$UNDERCITY_DIR/logs" ]]; then
        count=$(find "$UNDERCITY_DIR/logs" -type f 2>/dev/null | wc -l || echo 0)
        echo "  🗑️  Removing logs/ ($count files)"
        rm -rf "$UNDERCITY_DIR/logs"
    fi

    # Remove old cache and state files
    for file in stash.json efficiency-outcomes.json flute-cache.json scout-cache.json pocket.json intel.txt inventory.json; do
        if [[ -f "$UNDERCITY_DIR/$file" ]]; then
            echo "  🗑️  Removing $file"
            rm "$UNDERCITY_DIR/$file"
        fi
    done

    # Remove all backup files
    backup_count=$(find "$UNDERCITY_DIR" -maxdepth 1 -name "*.backup-*" 2>/dev/null | wc -l || echo 0)
    if [[ $backup_count -gt 0 ]]; then
        echo "  🗑️  Removing $backup_count backup file(s)"
        find "$UNDERCITY_DIR" -maxdepth 1 -name "*.backup-*" -delete
    fi

    echo "  ✓ Deep cleanup complete"
    echo
fi

# Summary
echo "=========================="
echo "✅ Cleanup complete!"
echo

if [[ "$DEEP_CLEAN" == true ]]; then
    echo "Deep cleanup performed:"
    echo "  • Removed old directories (squad/, raids/, logs/)"
    echo "  • Removed old caches and state files"
    echo "  • Removed all backup files"
    echo
fi

echo "Session state cleaned:"
echo "  • parallel-recovery.json"
echo "  • file-tracking.json"
echo "  • worktree-state.json"
echo "  • grind-progress.json"
echo
echo "Backups saved with .backup-* suffix"
echo "Ready for fresh grind!"
