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
      "Success Rate: \(.summary.successRate // "N/A")",
      "Tasks Completed: \(.summary.tasksCompleted // 0)",
      "Tasks Failed: \(.summary.tasksFailed // 0)",
      "Duration: \(.summary.duration // "N/A")",
      "",
      "Failure Breakdown:",
      ((.failureAnalysis.breakdown // {}) | to_entries | map(select(.value > 0)) | if length == 0 then ["  (none)"] else map("  - \(.key): \(.value)") end | .[]),
      "",
      "Escalations: \(.escalations.total // 0) (\(.escalations.escalationRate // "0%"))",
      "",
      "Recommendations:",
      ((.recommendations // [])[:3][] | "  - \(.)")
    ' "$ANALYSIS_DIR/postmortem-$TIMESTAMP.json" 2>/dev/null || echo "  (no postmortem data)"
    echo ""
fi

# Show introspection highlights (model routing, escalation)
if [ -f "$ANALYSIS_DIR/introspect-$TIMESTAMP.json" ]; then
    echo "## Introspection"
    jq -r '
      "Model Performance:",
      ((.modelPerformance // {}) | to_entries[:3][] | "  - \(.key): \(.value.successRate // "N/A") success, \(.value.avgTokens // 0) avg tokens"),
      "",
      "Top Failure Patterns:",
      ((.failurePatterns // [])[:3][] | "  - \(.pattern // .category): \(.count // 0) occurrences")
    ' "$ANALYSIS_DIR/introspect-$TIMESTAMP.json" 2>/dev/null || echo "  (no introspection data)"
    echo ""
fi

# Show effectiveness highlights
if [ -f "$ANALYSIS_DIR/effectiveness-$TIMESTAMP.json" ]; then
    echo "## Learning Effectiveness"
    jq -r '
      "File Prediction: \(.filePrediction.accuracy // "N/A")% accuracy (\(.filePrediction.sampleSize // 0) samples)",
      "Knowledge Impact: \(.knowledgeImpact.correlation // "N/A")",
      "Error Fix Patterns: \(.errorPatterns.matchRate // "N/A")% match rate"
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
