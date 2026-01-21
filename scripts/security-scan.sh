#!/bin/bash
# Security scanning script for pre-commit
# Runs security tools to catch issues before commit
#
# REQUIRED tools: gitleaks, semgrep
# These are mandatory - commits will be blocked if tools are missing.
# Given undercity's autonomous nature, security scanning is non-negotiable.

set -e

echo "Running security scans..."

# Track if any tool found issues
ISSUES_FOUND=0

# 1. Gitleaks - Check for secrets in staged files (REQUIRED)
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
    echo ""
    echo "ERROR: gitleaks not installed!"
    echo "Install: https://github.com/gitleaks/gitleaks#installing"
    echo ""
    echo "Security tools are REQUIRED for undercity development."
    ISSUES_FOUND=1
fi

# 2. Semgrep - Static analysis for security vulnerabilities (REQUIRED)
if command -v semgrep &> /dev/null; then
    echo ""
    echo "==> Running semgrep security scan..."
    # Run with specific JavaScript/TypeScript security rules
    # p/javascript: General JS security rules
    # p/typescript: TypeScript-specific rules
    # p/nodejs: Node.js security patterns (command injection, path traversal, etc.)
    if ! semgrep scan \
        --config p/javascript \
        --config p/typescript \
        --config p/nodejs \
        --error \
        --quiet \
        ./src 2>/dev/null; then
        echo "ERROR: Semgrep found security issues!"
        ISSUES_FOUND=1
    else
        echo "Semgrep: No security issues found."
    fi
else
    echo ""
    echo "ERROR: semgrep not installed!"
    echo "Install: pip install semgrep"
    echo ""
    echo "Security tools are REQUIRED for undercity development."
    ISSUES_FOUND=1
fi

# Exit with error if any issues found
if [ $ISSUES_FOUND -ne 0 ]; then
    echo ""
    echo "Security scan failed! Please fix the issues above."
    exit 1
fi

echo ""
echo "Security scans complete - no issues found."
