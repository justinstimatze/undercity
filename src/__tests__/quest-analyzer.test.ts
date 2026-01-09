/**
 * Tests for QuestAnalyzer module
 */

import type { Quest } from "../quest.js";
import { QuestAnalyzer } from "../quest-analyzer.js";

describe("QuestAnalyzer", () => {
	let analyzer: QuestAnalyzer;

	beforeEach(() => {
		analyzer = new QuestAnalyzer();
	});

	describe("analyzeQuest", () => {
		it("should analyze a simple bug fix quest", async () => {
			const quest: Quest = {
				id: "quest-1",
				objective: "Fix the typo in the login component src/auth/LoginForm.tsx",
				status: "pending",
				createdAt: new Date(),
			};

			const analysis = await analyzer.analyzeQuest(quest);

			expect(analysis.complexity).toBe("low");
			expect(analysis.packages).toContain("auth");
			expect(analysis.estimatedFiles).toContain("src/auth/LoginForm.tsx");
			expect(analysis.tags).toContain("bugfix");
			expect(analysis.tags).toContain("low");
			expect(analysis.riskScore).toBeLessThan(0.3);
		});

		it("should analyze a complex refactor quest", async () => {
			const quest: Quest = {
				id: "quest-2",
				objective: "Refactor the auth system to use OAuth2 instead of JWT tokens across multiple components",
				status: "pending",
				createdAt: new Date(),
			};

			const analysis = await analyzer.analyzeQuest(quest);

			expect(analysis.complexity).toBe("high");
			expect(analysis.packages).toContain("auth");
			expect(analysis.tags).toContain("refactor");
			expect(analysis.tags).toContain("high");
			expect(analysis.riskScore).toBeGreaterThan(0.5);
		});

		it("should detect UI components", async () => {
			const quest: Quest = {
				id: "quest-3",
				objective: "Add a new React component for user profile settings in src/components/Profile.tsx",
				status: "pending",
				createdAt: new Date(),
			};

			const analysis = await analyzer.analyzeQuest(quest);

			expect(analysis.packages).toContain("react");
			expect(analysis.packages).toContain("user");
			expect(analysis.estimatedFiles).toContain("**/components/**/*");
		});

		it("should detect API endpoints", async () => {
			const quest: Quest = {
				id: "quest-4",
				objective: "Implement new REST API endpoint for user registration",
				status: "pending",
				createdAt: new Date(),
			};

			const analysis = await analyzer.analyzeQuest(quest);

			expect(analysis.packages).toContain("api");
			expect(analysis.estimatedFiles).toContain("**/api/**/*");
			expect(analysis.tags).toContain("api");
		});

		it("should handle database operations", async () => {
			const quest: Quest = {
				id: "quest-5",
				objective: "Create database migration for new user preferences table",
				status: "pending",
				createdAt: new Date(),
			};

			const analysis = await analyzer.analyzeQuest(quest);

			expect(analysis.packages).toContain("database");
			expect(analysis.estimatedFiles).toContain("**/migrations/**/*");
			expect(analysis.tags).toContain("database");
			expect(analysis.riskScore).toBeGreaterThan(0.3); // Database changes are risky
		});
	});

	describe("detectPackageBoundaries", () => {
		it("should extract package names from file paths", () => {
			const objective = "Update the login form in src/auth/components/LoginForm.tsx";
			const packages = analyzer.detectPackageBoundaries(objective);

			expect(packages).toContain("auth");
			expect(packages).toContain("components");
		});

		it("should detect framework patterns", () => {
			const objective = "Update the React user auth service";
			const packages = analyzer.detectPackageBoundaries(objective);

			expect(packages).toContain("react");
			expect(packages).toContain("user");
			expect(packages).toContain("auth");
		});

		it("should filter out common words", () => {
			const objective = "Update the test file in src/utils/helpers.ts";
			const packages = analyzer.detectPackageBoundaries(objective);

			expect(packages).not.toContain("the");
			expect(packages).not.toContain("test");
			expect(packages).toContain("utils");
		});
	});

	describe("estimateFilesTouched", () => {
		it("should detect test files", () => {
			const objective = "Add unit tests for the user service";
			const files = analyzer.estimateFilesTouched(objective);

			expect(files).toContain("**/*.test.{ts,js,tsx,jsx}");
			expect(files).toContain("**/*.spec.{ts,js,tsx,jsx}");
		});

		it("should detect style files", () => {
			const objective = "Update the CSS styles for the header component";
			const files = analyzer.estimateFilesTouched(objective);

			expect(files).toContain("**/*.{css,scss,less,styl}");
		});

		it("should detect config files", () => {
			const objective = "Update the webpack configuration settings";
			const files = analyzer.estimateFilesTouched(objective);

			expect(files).toContain("**/*.{json,yaml,yml,toml}");
			expect(files).toContain("**/config/**/*");
		});
	});

	describe("assessComplexity", () => {
		it("should identify low complexity waypoints", () => {
			const complexity = analyzer.assessComplexity("Fix typo in README");
			expect(complexity).toBe("low");
		});

		it("should identify medium complexity waypoints", () => {
			const complexity = analyzer.assessComplexity("Implement new user feature");
			expect(complexity).toBe("medium");
		});

		it("should identify high complexity waypoints", () => {
			const complexity = analyzer.assessComplexity("Refactor the entire authentication architecture");
			expect(complexity).toBe("high");
		});

		it("should handle detailed descriptions", () => {
			const longDescription =
				"This is a very detailed waypoint description that explains exactly what needs to be done in multiple sentences with lots of specific requirements";
			const complexity = analyzer.assessComplexity(longDescription);
			expect(complexity).toBe("high"); // Long descriptions tend to be complex
		});
	});

	describe("calculateRiskScore", () => {
		it("should give low risk to simple bug fixes", () => {
			const quest: Quest = {
				id: "quest-1",
				objective: "Fix typo",
				status: "pending",
				createdAt: new Date(),
			};

			const score = analyzer.calculateRiskScore(quest, ["utils"], ["file1.ts"], "low");
			expect(score).toBeLessThan(0.3);
		});

		it("should give high risk to security changes", () => {
			const quest: Quest = {
				id: "quest-2",
				objective: "Update authentication security encryption",
				status: "pending",
				createdAt: new Date(),
			};

			const score = analyzer.calculateRiskScore(quest, ["auth", "security"], ["auth.ts", "crypto.ts"], "high");
			expect(score).toBeGreaterThan(0.5);
		});

		it("should penalize many packages", () => {
			const quest: Quest = {
				id: "quest-3",
				objective: "Cross-cutting change",
				status: "pending",
				createdAt: new Date(),
			};

			const manyPackages = ["pkg1", "pkg2", "pkg3", "pkg4", "pkg5"];
			const score = analyzer.calculateRiskScore(quest, manyPackages, ["file1.ts"], "medium");
			expect(score).toBeGreaterThan(0.4);
		});

		it("should cap risk score at 1.0", () => {
			const quest: Quest = {
				id: "quest-4",
				objective: "Critical production security migration with payment transactions",
				status: "pending",
				createdAt: new Date(),
				conflicts: ["quest-other-1", "quest-other-2"],
				dependsOn: ["quest-dep-1"],
			};

			const manyPackages = Array.from({ length: 10 }, (_, i) => `pkg${i}`);
			const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
			const score = analyzer.calculateRiskScore(quest, manyPackages, manyFiles, "high");
			expect(score).toBeLessThanOrEqual(1.0);
		});
	});

	describe("generateTags", () => {
		it("should tag bug fixes", () => {
			const tags = analyzer.generateTags("Fix the login bug", "low");
			expect(tags).toContain("bugfix");
			expect(tags).toContain("low");
		});

		it("should tag features", () => {
			const tags = analyzer.generateTags("Implement new user dashboard", "medium");
			expect(tags).toContain("feature");
			expect(tags).toContain("medium");
		});

		it("should tag refactoring", () => {
			const tags = analyzer.generateTags("Refactor the payment processing code", "high");
			expect(tags).toContain("refactor");
			expect(tags).toContain("high");
		});

		it("should tag multiple categories", () => {
			const tags = analyzer.generateTags("Fix API endpoint performance issue", "medium");
			expect(tags).toContain("bugfix");
			expect(tags).toContain("api");
			expect(tags).toContain("performance");
			expect(tags).toContain("medium");
		});

		it("should tag documentation", () => {
			const tags = analyzer.generateTags("Update README with new setup instructions", "low");
			expect(tags).toContain("documentation");
			expect(tags).toContain("low");
		});
	});
});
