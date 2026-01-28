#!/bin/bash
# Check that all peer dependencies are satisfied
# Run before removing any dependency that seems "unused"

set -e

echo "Checking peer dependency satisfaction..."

# Get list of unmet peer deps
UNMET=$(pnpm ls --depth=1 2>&1 | grep "WARN.*peer" || true)

if [ -n "$UNMET" ]; then
    echo ""
    echo "WARNING: Unmet peer dependencies detected:"
    echo "$UNMET"
    echo ""
    echo "These packages may need dependencies that appear 'unused' in source code."
    exit 1
fi

echo "All peer dependencies satisfied."
