#!/bin/bash
# Feed previous session analysis to Claude at session start
set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/justin/Documents/undercity}"
ANALYSIS_DIR="$HOME/.claude/undercity-analysis"

# Find most recent analysis
LATEST_SUMMARY=$(ls -t "$ANALYSIS_DIR"/session-summary-*.txt 2>/dev/null | head -1)

if [ -z "$LATEST_SUMMARY" ]; then
    exit 0
fi

TIMESTAMP="${LATEST_SUMMARY#$ANALYSIS_DIR/session-summary-}"
TIMESTAMP="${TIMESTAMP%.txt}"

echo "=== PREVIOUS SESSION ANALYSIS ==="
echo ""

# Show postmortem highlights (failures, recommendations)
if [ -f "$ANALYSIS_DIR/postmortem-$TIMESTAMP.json" ]; then
    echo "## Postmortem (Last Grind)"
    jq -r '
      "Success Rate: \(.successRate // "N/A")",
      "Failed Tasks: \(.failedCount // 0)",
      "",
      "Failure Breakdown:",
      ((.failureBreakdown // {}) | to_entries[] | "  - \(.key): \(.value)"),
      "",
      "Recommendations:",
      ((.recommendations // [])[:3][] | "  - \(.)")
    ' "$ANALYSIS_DIR/postmortem-$TIMESTAMP.json" 2>/dev/null || echo "  (no postmortem data)"
    echo ""
fi

# Show metrics highlights
if [ -f "$ANALYSIS_DIR/metrics-$TIMESTAMP.json" ]; then
    echo "## Metrics"
    jq -r '
      "Total Tasks: \(.totalTasks // 0)",
      "Completed: \(.completed // 0)",
      "Failed: \(.failed // 0)",
      "Avg Duration: \(.avgDurationMs // 0)ms"
    ' "$ANALYSIS_DIR/metrics-$TIMESTAMP.json" 2>/dev/null || echo "  (no metrics data)"
    echo ""
fi

# Show introspection highlights (model routing, escalation)
if [ -f "$ANALYSIS_DIR/introspect-$TIMESTAMP.json" ]; then
    echo "## Introspection"
    jq -r '
      "Model Usage:",
      ((.modelUsage // {}) | to_entries[] | "  - \(.key): \(.value)"),
      "",
      "Escalation Rate: \(.escalationRate // "N/A")",
      "Avg Retries: \(.avgRetries // "N/A")"
    ' "$ANALYSIS_DIR/introspect-$TIMESTAMP.json" 2>/dev/null || echo "  (no introspection data)"
    echo ""
fi

# Show effectiveness highlights
if [ -f "$ANALYSIS_DIR/effectiveness-$TIMESTAMP.json" ]; then
    echo "## Learning Effectiveness"
    jq -r '
      "File Prediction Accuracy: \(.filePredictionAccuracy // "N/A")",
      "Knowledge Correlation: \(.knowledgeCorrelation // "N/A")",
      "Pattern Match Rate: \(.patternMatchRate // "N/A")"
    ' "$ANALYSIS_DIR/effectiveness-$TIMESTAMP.json" 2>/dev/null || echo "  (no effectiveness data)"
    echo ""
fi

# Check for doc update reminders
if [ -f "$HOME/.claude/docs-update-needed.log" ]; then
    echo "## Documentation Updates Needed"
    tail -20 "$HOME/.claude/docs-update-needed.log"
    echo ""
fi

echo "=== END PREVIOUS SESSION ANALYSIS ==="
