#!/bin/bash
# Push to remote and watch CI status
# If CI fails, automatically add a task to fix it

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Pass all arguments to git push
echo -e "${YELLOW}Pushing to remote...${NC}"
git push "$@"

if [ $? -ne 0 ]; then
    echo -e "${RED}Push failed${NC}"
    exit 1
fi

echo -e "${GREEN}Push successful${NC}"
echo -e "${YELLOW}Waiting for CI to start...${NC}"

# Wait for CI to register the new commit
sleep 5

# Get the latest run ID for the current branch
BRANCH=$(git branch --show-current)
RUN_ID=$(gh run list --branch "$BRANCH" --limit 1 --json databaseId -q '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    echo -e "${RED}Could not find CI run${NC}"
    exit 1
fi

echo -e "${YELLOW}Watching CI run $RUN_ID...${NC}"

# Watch the run (this blocks until completion)
gh run watch "$RUN_ID" --exit-status

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}CI passed!${NC}"
else
    echo -e "${RED}CI failed!${NC}"

    # Get failure details
    FAILED_JOBS=$(gh run view "$RUN_ID" --json jobs -q '.jobs[] | select(.conclusion == "failure") | .name' | tr '\n' ', ' | sed 's/,$//')

    # Get the failed logs summary
    FAILURE_SUMMARY=$(gh run view "$RUN_ID" --log-failed 2>/dev/null | head -50 | tail -20)

    # Create a task to fix the CI failure
    TASK_DESC="[fix] CI failure in: ${FAILED_JOBS:-unknown jobs}"

    echo -e "${YELLOW}Adding task to fix CI failure...${NC}"

    # Check if undercity is available
    if command -v undercity &> /dev/null; then
        undercity add "$TASK_DESC" --priority 0
    elif [ -f "./bin/undercity.js" ]; then
        node ./bin/undercity.js add "$TASK_DESC" --priority 0
    else
        echo -e "${RED}Could not find undercity CLI to add task${NC}"
        echo -e "${YELLOW}Manual task: $TASK_DESC${NC}"
    fi

    echo -e "${RED}CI failure details:${NC}"
    echo "$FAILURE_SUMMARY"

    exit 1
fi
