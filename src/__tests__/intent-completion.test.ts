/**
 * Tests for intent-completion module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractPartialIntent,
	formatPredictionDisplay,
	isAmbiguous,
	predictFullIntent,
	shouldSkipIntentCompletion,
} from "../intent-completion.js";

describe("intent-completion", () => {
	describe("isAmbiguous", () => {
		it("should flag empty objective as ambiguous", () => {
			expect(isAmbiguous("")).toBe(true);
			expect(isAmbiguous("   ")).toBe(true);
		});

		it("should flag single ambiguous keywords as ambiguous", () => {
			expect(isAmbiguous("auth")).toBe(true);
			expect(isAmbiguous("performance")).toBe(true);
			expect(isAmbiguous("testing")).toBe(true);
			expect(isAmbiguous("refactor")).toBe(true);
			expect(isAmbiguous("security")).toBe(true);
		});

		it("should flag very short objectives without domain keywords as ambiguous", () => {
			expect(isAmbiguous("fix it")).toBe(true);
			expect(isAmbiguous("add x")).toBe(true);
		});

		it("should flag vague verb + short objective as ambiguous", () => {
			expect(isAmbiguous("add logging")).toBe(true);
			expect(isAmbiguous("fix errors")).toBe(true);
			expect(isAmbiguous("improve code")).toBe(true);
		});

		it("should NOT flag detailed objectives as ambiguous", () => {
			expect(isAmbiguous("Add JWT-based authentication with refresh token support")).toBe(false);
			expect(isAmbiguous("Fix the login form validation error in src/components/LoginForm.tsx")).toBe(false);
			expect(isAmbiguous("Implement rate limiting using Redis for API endpoints")).toBe(false);
		});

		it("should NOT flag objectives with domain-specific keywords as ambiguous", () => {
			expect(isAmbiguous("Add JWT auth")).toBe(false);
			expect(isAmbiguous("Use Redis caching")).toBe(false);
			expect(isAmbiguous("Add vitest tests")).toBe(false);
		});

		it("should NOT flag medium-length objectives with context", () => {
			expect(isAmbiguous("Add form validation to user registration")).toBe(false);
			expect(isAmbiguous("Implement pagination for the product list endpoint")).toBe(false);
		});
	});

	describe("shouldSkipIntentCompletion", () => {
		it("should skip for long detailed objectives with domain keywords", () => {
			expect(
				shouldSkipIntentCompletion(
					"Implement JWT-based authentication with refresh tokens, session management, and proper error handling for the REST API",
				),
			).toBe(true);
		});

		it("should skip for objectives with file paths", () => {
			expect(shouldSkipIntentCompletion("Fix bug in src/components/Button.tsx")).toBe(true);
			expect(shouldSkipIntentCompletion("Update config/settings.json")).toBe(true);
		});

		it("should skip for objectives with task prefixes", () => {
			expect(shouldSkipIntentCompletion("[meta:triage] Analyze board")).toBe(true);
			expect(shouldSkipIntentCompletion("[plan] Create implementation plan")).toBe(true);
		});

		it("should NOT skip for short ambiguous objectives", () => {
			expect(shouldSkipIntentCompletion("auth")).toBe(false);
			expect(shouldSkipIntentCompletion("fix bugs")).toBe(false);
		});
	});

	describe("extractPartialIntent", () => {
		it("should extract keywords from objective", () => {
			const result = extractPartialIntent("add authentication");
			expect(result.keywords).toContain("authentication");
			expect(result.hasVerb).toBe(true);
			expect(result.verb).toBe("add");
		});

		it("should identify target after vague verb", () => {
			const result = extractPartialIntent("fix validation errors");
			expect(result.hasTarget).toBe(true);
			expect(result.target).toBe("validation");
		});

		it("should handle objectives without vague verbs", () => {
			const result = extractPartialIntent("JWT authentication system");
			expect(result.hasVerb).toBe(false);
			expect(result.verb).toBeNull();
		});

		it("should filter stop words from keywords", () => {
			const result = extractPartialIntent("add the user to the database");
			expect(result.keywords).not.toContain("the");
			expect(result.keywords).not.toContain("to");
			expect(result.keywords).toContain("user");
			expect(result.keywords).toContain("database");
		});
	});

	describe("predictFullIntent", () => {
		it("should return non-ambiguous objectives unchanged", () => {
			const objective = "Implement JWT-based authentication with refresh token support";
			const result = predictFullIntent(objective);

			expect(result.isAmbiguous).toBe(false);
			expect(result.predictedObjective).toBe(objective);
			expect(result.originalObjective).toBe(objective);
		});

		it("should predict for ambiguous objectives", () => {
			const result = predictFullIntent("auth");

			expect(result.isAmbiguous).toBe(true);
			expect(result.originalObjective).toBe("auth");
			// Prediction may or may not differ based on historical data
			expect(result.confidence).toMatch(/^(high|medium|low)$/);
			expect(result.reasoning).toBeTruthy();
		});

		it("should include similar tasks array", () => {
			const result = predictFullIntent("performance");

			expect(result.similarTasks).toBeDefined();
			expect(Array.isArray(result.similarTasks)).toBe(true);
		});

		it("should include inferred details array", () => {
			const result = predictFullIntent("testing");

			expect(result.inferredDetails).toBeDefined();
			expect(Array.isArray(result.inferredDetails)).toBe(true);
		});
	});

	describe("formatPredictionDisplay", () => {
		it("should return empty string for non-ambiguous predictions", () => {
			const result = predictFullIntent("Implement detailed feature with specific requirements");
			const display = formatPredictionDisplay(result);

			expect(display).toBe("");
		});

		it("should format ambiguous prediction display", () => {
			const result = predictFullIntent("auth");
			// Manually set values for testing
			const testResult = {
				...result,
				isAmbiguous: true,
				originalObjective: "auth",
				predictedObjective: "Add JWT authentication",
				confidence: "medium" as const,
				reasoning: "Found similar tasks",
				similarTasks: [{ objective: "Add OAuth auth", success: true, model: "sonnet" as const, similarity: 0.7 }],
				inferredDetails: [{ detail: "jwt", supportCount: 3, prevalence: 0.8 }],
			};

			const display = formatPredictionDisplay(testResult);

			expect(display).toContain("Intent Completion Suggestion");
			expect(display).toContain("auth");
			expect(display).toContain("JWT");
			expect(display).toContain("medium");
		});
	});
});
