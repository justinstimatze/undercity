#!/bin/bash
# Security scanning script for pre-commit
# Runs available security tools to catch issues before commit

set -e

echo "Running security scans..."

# Track if any tool found issues
ISSUES_FOUND=0

# 1. Gitleaks - Check for secrets in staged files
if command -v gitleaks &> /dev/null; then
    echo ""
    echo "==> Checking for secrets with gitleaks..."
    if ! gitleaks protect --staged --no-banner --redact 2>/dev/null; then
        echo "ERROR: Secrets detected in staged files! Please remove them before committing."
        ISSUES_FOUND=1
    else
        echo "No secrets found in staged files."
    fi
else
    echo "WARNING: gitleaks not installed, skipping secrets detection"
    echo "Install: brew install gitleaks (macOS) or see https://github.com/gitleaks/gitleaks"
fi

# 2. Semgrep - Static analysis for security vulnerabilities (if installed)
if command -v semgrep &> /dev/null; then
    echo ""
    echo "==> Running semgrep security scan..."
    # Run with JavaScript/TypeScript security rules
    if ! semgrep scan --config auto --error --quiet ./src 2>/dev/null; then
        echo "ERROR: Semgrep found security issues!"
        ISSUES_FOUND=1
    else
        echo "Semgrep: No security issues found."
    fi
else
    echo ""
    echo "INFO: semgrep not installed, skipping static security analysis"
    echo "Install: pip install semgrep or brew install semgrep"
fi

# Exit with error if any issues found
if [ $ISSUES_FOUND -ne 0 ]; then
    echo ""
    echo "Security scan failed! Please fix the issues above."
    exit 1
fi

echo ""
echo "Security scans complete - no issues found."
