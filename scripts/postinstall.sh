#!/bin/bash
# Postinstall script to verify native modules are built correctly
# This handles cases where pnpm's build scripts were skipped

set -e

echo "Verifying native modules..."

# Check if sharp is working
if ! node -e "require('sharp')" 2>/dev/null; then
    echo "Building sharp native module..."
    # Find the sharp package location and rebuild
    SHARP_PATH=$(node -p "require.resolve('sharp').replace('/lib/index.js', '')" 2>/dev/null || echo "")
    if [ -n "$SHARP_PATH" ] && [ -d "$SHARP_PATH" ]; then
        cd "$SHARP_PATH"
        npm install --ignore-scripts=false 2>/dev/null || {
            echo "Warning: Could not rebuild sharp. RAG features may not work."
            echo "Try: cd $SHARP_PATH && npm install"
        }
        cd - > /dev/null
    else
        echo "Warning: sharp not found. RAG features may not work."
    fi
else
    echo "sharp: OK"
fi

# Check if sqlite-vec is working
if ! node -e "require('sqlite-vec')" 2>/dev/null; then
    echo "Warning: sqlite-vec not working. RAG features may not work."
else
    echo "sqlite-vec: OK"
fi

echo "Native module verification complete."
