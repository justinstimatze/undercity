# Sample Quest Scenarios for Testing Parallel Quest Matchmaking

This file contains sample quest scenarios to test the quest matchmaking system.

## Scenario 1: Compatible Quests (Different Packages)

### Quest 1: Authentication Bug Fix
**Objective**: Fix authentication token validation bug in src/auth/tokenValidator.ts
**Package Hints**: ["auth"]
**Estimated Files**: ["src/auth/tokenValidator.ts", "src/auth/types.ts"]
**Tags**: ["bugfix", "security"]

### Quest 2: UI Component Update
**Objective**: Update the user profile component to show last login date
**Package Hints**: ["components", "ui"]
**Estimated Files**: ["src/components/UserProfile.tsx", "src/components/UserProfile.css"]
**Tags**: ["feature", "ui"]

### Quest 3: API Documentation
**Objective**: Add OpenAPI documentation for user management endpoints
**Package Hints**: ["docs", "api"]
**Estimated Files**: ["docs/api/users.yml", "src/api/users/routes.ts"]
**Tags**: ["documentation", "api"]

**Expected**: These should be highly compatible for parallel execution (different packages, no file overlap)

## Scenario 2: Package Overlap (Warning Level)

### Quest 4: Authentication Middleware
**Objective**: Add rate limiting to authentication middleware
**Package Hints**: ["auth", "middleware"]
**Estimated Files**: ["src/auth/middleware/rateLimiter.ts"]
**Tags**: ["feature", "security"]

### Quest 5: Authentication Tests
**Objective**: Add comprehensive unit tests for authentication service
**Package Hints**: ["auth", "test"]
**Estimated Files**: ["src/auth/__tests__/authService.test.ts"]
**Tags**: ["testing"]

**Expected**: Compatible with reduced score due to package overlap (both touch "auth")

## Scenario 3: File Conflict (Blocking)

### Quest 6: Login Form Validation
**Objective**: Add client-side validation to login form
**Package Hints**: ["auth", "ui"]
**Estimated Files**: ["src/components/LoginForm.tsx"]
**Tags**: ["feature", "validation"]

### Quest 7: Login Form Styling
**Objective**: Update login form styles for better mobile experience
**Package Hints**: ["ui", "styles"]
**Estimated Files**: ["src/components/LoginForm.tsx", "src/styles/auth.css"]
**Tags**: ["ui", "mobile"]

**Expected**: Not compatible due to file conflict (both modify LoginForm.tsx)

## Scenario 4: Explicit Dependencies

### Quest 8: Database Schema Migration
**Objective**: Create migration for new user preferences table
**Package Hints**: ["database", "migration"]
**Estimated Files**: ["migrations/002_user_preferences.sql"]
**Tags**: ["database"]
**Dependencies**: []

### Quest 9: User Preferences API
**Objective**: Implement REST API for user preferences management
**Package Hints**: ["api", "preferences"]
**Estimated Files**: ["src/api/preferences/routes.ts", "src/api/preferences/controller.ts"]
**Tags**: ["api", "feature"]
**Dependencies**: ["quest-8"]

**Expected**: Quest 9 depends on Quest 8, so they cannot run in parallel

## Scenario 5: High Risk Quests

### Quest 10: Payment System Refactor
**Objective**: Refactor payment processing system to use new Stripe API
**Package Hints**: ["payments", "billing"]
**Estimated Files**: ["src/payments/stripe.ts", "src/billing/processor.ts"]
**Tags**: ["refactor", "critical"]
**Risk Score**: 0.9

### Quest 11: Security Audit Implementation
**Objective**: Implement security audit logging for all financial transactions
**Package Hints**: ["security", "audit", "payments"]
**Estimated Files**: ["src/security/auditLogger.ts", "src/payments/hooks.ts"]
**Tags**: ["security", "critical"]
**Risk Score**: 0.8

**Expected**: Both high-risk, should not run in parallel (conservative mode)

## Scenario 6: Mixed Complexity

### Quest 12: Simple Typo Fix
**Objective**: Fix typo in README.md file
**Package Hints**: ["docs"]
**Estimated Files**: ["README.md"]
**Tags**: ["documentation", "typo"]
**Risk Score**: 0.1

### Quest 13: Performance Optimization
**Objective**: Optimize database query performance in user search
**Package Hints**: ["database", "performance"]
**Estimated Files**: ["src/database/queries/userSearch.ts", "src/services/userService.ts"]
**Tags**: ["performance", "optimization"]
**Risk Score**: 0.4

### Quest 14: Feature Implementation
**Objective**: Add two-factor authentication support
**Package Hints**: ["auth", "security", "2fa"]
**Estimated Files**: ["src/auth/2fa.ts", "src/components/TwoFactorSetup.tsx"]
**Tags**: ["feature", "security"]
**Risk Score**: 0.6

**Expected**: All compatible, good parallelization opportunity with mixed benefits

## Scenario 7: Integration Tests

### Quest 15: End-to-End Auth Flow
**Objective**: Add E2E tests for complete authentication flow
**Package Hints**: ["test", "e2e", "auth"]
**Estimated Files**: ["tests/e2e/auth.spec.ts"]
**Tags**: ["testing", "e2e"]

### Quest 16: Integration Test Suite
**Objective**: Set up integration test infrastructure with test containers
**Package Hints**: ["test", "infrastructure"]
**Estimated Files**: ["tests/integration/setup.ts", "docker-compose.test.yml"]
**Tags**: ["testing", "infrastructure"]

### Quest 17: Unit Test Coverage
**Objective**: Improve unit test coverage for utility functions
**Package Hints**: ["test", "utils"]
**Estimated Files**: ["src/utils/__tests__/helpers.test.ts"]
**Tags**: ["testing", "coverage"]

**Expected**: All testing-related, should have good compatibility

## Usage Instructions

To test these scenarios:

1. **Add quests to the board**:
   ```bash
   # Add individual quests
   npx undercity add "Fix authentication token validation bug in src/auth/tokenValidator.ts"
   npx undercity add "Update the user profile component to show last login date"
   # ... etc
   ```

2. **Analyze quest board**:
   ```bash
   npx undercity quest-analyze --compatibility --suggestions
   ```

3. **Test dry run**:
   ```bash
   npx undercity quest-batch --dry-run -n 3
   ```

4. **Test analysis only**:
   ```bash
   npx undercity quest-batch --analyze-only -n 3
   ```

5. **Run parallel execution (when ready)**:
   ```bash
   npx undercity quest-batch -n 3 --verbose --stream
   ```

## Expected Outcomes

- **Scenario 1**: Should be selected as optimal parallel set (high compatibility score)
- **Scenario 2**: Should be compatible with warning about package overlap
- **Scenario 3**: Should be detected as incompatible due to file conflict
- **Scenario 4**: Quest 8 should be ready, Quest 9 should be blocked
- **Scenario 5**: Should not be selected for parallel execution in conservative mode
- **Scenario 6**: Should show mixed risk levels and good parallelization potential
- **Scenario 7**: Should demonstrate good testing workflow parallelization