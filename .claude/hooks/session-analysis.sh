#!/bin/bash
# Comprehensive session analysis for undercity
set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/justin/Documents/undercity}"
OUTPUT_DIR="$HOME/.claude/undercity-analysis"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUTPUT_DIR"

cd "$PROJECT_DIR"

# Run all analysis commands and save to files
echo "Running session analysis..."

# 1. Postmortem (if grind was run)
if [ -f ".undercity/grind-events.jsonl" ]; then
    ./bin/undercity.js postmortem --json 2>/dev/null > "$OUTPUT_DIR/postmortem-$TIMESTAMP.json" || true
fi

# 2. Quick metrics snapshot
./bin/undercity.js metrics --json 2>/dev/null > "$OUTPUT_DIR/metrics-$TIMESTAMP.json" || true

# 3. Introspection (success rates, routing)
./bin/undercity.js introspect --json 2>/dev/null > "$OUTPUT_DIR/introspect-$TIMESTAMP.json" || true

# 4. Learning effectiveness (if enough data)
./bin/undercity.js effectiveness --json 2>/dev/null > "$OUTPUT_DIR/effectiveness-$TIMESTAMP.json" || true

# Create summary
cat > "$OUTPUT_DIR/session-summary-$TIMESTAMP.txt" << EOF
Undercity Session Analysis - $TIMESTAMP

Metrics: $OUTPUT_DIR/metrics-$TIMESTAMP.json
Postmortem: $OUTPUT_DIR/postmortem-$TIMESTAMP.json
Introspect: $OUTPUT_DIR/introspect-$TIMESTAMP.json
Effectiveness: $OUTPUT_DIR/effectiveness-$TIMESTAMP.json
EOF

# Keep only last 10 session analyses
cd "$OUTPUT_DIR"
ls -t session-summary-*.txt 2>/dev/null | tail -n +11 | while read f; do
    base="${f#session-summary-}"
    base="${base%.txt}"
    rm -f "postmortem-$base.json" "metrics-$base.json" "introspect-$base.json" "effectiveness-$base.json" "$f" 2>/dev/null || true
done

echo "Analysis saved to $OUTPUT_DIR"
exit 0
