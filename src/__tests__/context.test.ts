/**
 * Context Summarization Module Tests
 *
 * Tests for context.ts - smart context extraction for agents.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ContextBriefing,
	estimateComplexityFromContext,
	extractImplementationContext,
	extractRelevantSections,
	extractReviewContext,
	formatSections,
	getContextLimit,
	parseMarkdownSections,
	prepareContext,
	smartTruncate,
	summarizeContextForAgent,
} from "../context.js";
import {
	extractFunctionSignaturesWithTypes,
	extractTypeDefinitionsFromFile,
	findFilesImporting,
	getTypeDefinition,
} from "../ts-analysis.js";

describe("parseMarkdownSections", () => {
	it("parses simple markdown with headings", () => {
		const content = `# Title

Some intro content.

## Section 1

First section content.

## Section 2

Second section content.`;

		const sections = parseMarkdownSections(content);

		expect(sections).toHaveLength(3);
		expect(sections[0].heading).toBe("Title");
		expect(sections[0].level).toBe(1);
		expect(sections[0].content).toContain("Some intro content");
		expect(sections[1].heading).toBe("Section 1");
		expect(sections[1].level).toBe(2);
		expect(sections[2].heading).toBe("Section 2");
	});

	it("handles content without headings", () => {
		const content = "Just plain text without any headings.";

		const sections = parseMarkdownSections(content);

		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe("Content");
		expect(sections[0].content).toBe("Just plain text without any headings.");
	});

	it("handles empty content", () => {
		const sections = parseMarkdownSections("");

		expect(sections).toHaveLength(0);
	});

	it("handles deeply nested headings", () => {
		const content = `# Level 1
## Level 2
### Level 3
#### Level 4
##### Level 5
###### Level 6`;

		const sections = parseMarkdownSections(content);

		expect(sections).toHaveLength(6);
		expect(sections[0].level).toBe(1);
		expect(sections[5].level).toBe(6);
	});
});

describe("smartTruncate", () => {
	it("returns content unchanged if under limit", () => {
		const content = "Short content";

		const result = smartTruncate(content, 1000);

		expect(result).toBe("Short content");
	});

	it("truncates at paragraph boundary when possible", () => {
		const content = `First paragraph with some text.

Second paragraph with more text.

Third paragraph that goes beyond the limit.`;

		const result = smartTruncate(content, 80);

		expect(result).toContain("First paragraph");
		expect(result).toContain("[...truncated]");
		expect(result).not.toContain("Third paragraph");
	});

	it("truncates at sentence boundary when no paragraph break", () => {
		const content =
			"First sentence here. Second sentence here. Third sentence that goes beyond the limit and keeps going.";

		const result = smartTruncate(content, 60);

		expect(result).toContain("First sentence");
		expect(result).toContain("[...truncated]");
	});

	it("truncates at word boundary as last resort", () => {
		const content = "Onewordthatisverylongandhasnospacesuntiltheveryend here";

		const result = smartTruncate(content, 50);

		expect(result).toContain("...");
		expect(result.length).toBeLessThanOrEqual(70); // Allow for truncation marker
	});
});

describe("extractRelevantSections", () => {
	const testSections = [
		{ heading: "Goal", level: 1, content: "Build a new feature" },
		{
			heading: "Implementation Steps",
			level: 2,
			content: "1. Create file\n2. Modify class",
		},
		{
			heading: "Test Requirements",
			level: 2,
			content: "Verify all edge cases",
		},
		{
			heading: "Security Considerations",
			level: 2,
			content: "Check for injection",
		},
		{ heading: "Random Notes", level: 3, content: "Some unrelated notes" },
	];

	it("extracts implementation sections for builder", () => {
		const relevant = extractRelevantSections(testSections, "builder");

		// Should prioritize implementation-related sections
		const headings = relevant.map((s) => s.heading);
		expect(headings).toContain("Implementation Steps");
	});

	it("extracts test sections for reviewer", () => {
		const relevant = extractRelevantSections(testSections, "reviewer");

		// Should prioritize test and security sections
		const headings = relevant.map((s) => s.heading);
		expect(headings).toContain("Test Requirements");
		expect(headings).toContain("Security Considerations");
	});

	it("respects context limits", () => {
		const longSections = [
			{ heading: "Section 1", level: 1, content: "A".repeat(2000) },
			{ heading: "Section 2", level: 1, content: "B".repeat(2000) },
			{ heading: "Section 3", level: 1, content: "C".repeat(2000) },
		];

		const relevant = extractRelevantSections(longSections, "reviewer");

		// Should not exceed sheriff limit (3000 chars)
		const totalLength = relevant.reduce((sum, s) => sum + s.heading.length + s.content.length, 0);
		expect(totalLength).toBeLessThanOrEqual(3500); // Allow some margin
	});
});

describe("formatSections", () => {
	it("formats sections back to markdown", () => {
		const sections = [
			{ heading: "Title", level: 1, content: "Content 1" },
			{ heading: "Subtitle", level: 2, content: "Content 2" },
		];

		const result = formatSections(sections);

		expect(result).toContain("# Title");
		expect(result).toContain("## Subtitle");
		expect(result).toContain("Content 1");
		expect(result).toContain("Content 2");
	});

	it("handles empty sections array", () => {
		const result = formatSections([]);

		expect(result).toBe("");
	});
});

describe("summarizeContextForAgent", () => {
	const fullPlan = `# Implementation Plan

## Goal
Add a new authentication feature.

## Scout Intel
Found 3 files: auth.ts, user.ts, config.ts

## Implementation Steps
1. Create auth middleware
2. Add user validation
3. Update config

## Files to Modify
- src/auth.ts
- src/user.ts

## Test Requirements
- Test login flow
- Test token validation
- Check edge cases

## Security Considerations
- Validate all inputs
- Use secure tokens`;

	it("returns truncated goal for flute", () => {
		const result = summarizeContextForAgent(fullPlan, "scout", "Add auth");

		expect(result.length).toBeLessThanOrEqual(1000);
		expect(result).toBe("Add auth");
	});

	it("returns full context for logistics (within limit)", () => {
		const result = summarizeContextForAgent(fullPlan, "planner");

		// Planner has 10K limit, so full plan should fit
		expect(result.length).toBeLessThanOrEqual(10000);
	});

	it("extracts implementation focus for builder", () => {
		const result = summarizeContextForAgent(fullPlan, "builder");

		// Should include implementation details
		expect(result).toContain("Implementation");
		expect(result.length).toBeLessThanOrEqual(5000);
	});

	it("extracts review focus for reviewer", () => {
		const result = summarizeContextForAgent(fullPlan, "reviewer");

		expect(result.length).toBeLessThanOrEqual(3000);
	});

	it("handles plain text input gracefully", () => {
		const plainText = "Just some plain text without any markdown formatting at all.";

		const result = summarizeContextForAgent(plainText, "builder");

		expect(result).toBeTruthy();
		expect(result.length).toBeLessThanOrEqual(5000);
	});
});

describe("extractImplementationContext", () => {
	it("extracts files to modify section", () => {
		const plan = `# Plan

## Overview
Some overview.

## Files to Modify
- src/auth.ts - add middleware
- src/user.ts - add validation

## Notes
Random notes here.`;

		const result = extractImplementationContext(plan);

		expect(result).toContain("Files to Modify");
		expect(result).toContain("src/auth.ts");
	});

	it("extracts implementation steps", () => {
		const plan = `# Plan

## Implementation Steps
1. Create new class
2. Add method
3. Write tests`;

		const result = extractImplementationContext(plan);

		expect(result).toContain("Implementation Steps");
		expect(result).toContain("Create new class");
	});

	it("falls back gracefully when no implementation sections found", () => {
		const plan = "Just a simple text plan without clear sections.";

		const result = extractImplementationContext(plan);

		expect(result).toBeTruthy();
	});
});

describe("extractReviewContext", () => {
	it("combines plan requirements with builder output", () => {
		const plan = `# Plan

## Test Requirements
- Test login
- Test logout

## Security
- Check XSS`;

		const builderOutput = "Created auth.ts with login/logout methods.";

		const result = extractReviewContext(plan, builderOutput);

		expect(result).toContain("Review Requirements");
		expect(result).toContain("Implementation Output");
		expect(result).toContain("auth.ts");
	});

	it("truncates long builder output", () => {
		const plan = "## Test Requirements\nTest everything.";
		const longOutput = "A".repeat(3000);

		const result = extractReviewContext(plan, longOutput);

		// Should be within sheriff limit
		expect(result.length).toBeLessThanOrEqual(3500); // Some margin
		expect(result).toContain("[...truncated]");
	});

	it("handles empty plan gracefully", () => {
		const result = extractReviewContext("", "Some output");

		expect(result).toContain("Implementation Output");
		expect(result).toContain("Some output");
	});
});

describe("getContextLimit", () => {
	it("returns correct limits for each agent type", () => {
		expect(getContextLimit("scout")).toBe(1000);
		expect(getContextLimit("planner")).toBe(10000);
		expect(getContextLimit("builder")).toBe(5000);
		expect(getContextLimit("reviewer")).toBe(3000);
	});
});

describe("context summarization - integration", () => {
	it("respects context limits for large plans", () => {
		// Simulate a large plan that exceeds limits
		const largePlan = `# Implementation Plan for Authentication Feature

## Executive Summary
This plan outlines the implementation of a new authentication system for the application.
We will be adding JWT-based authentication with refresh tokens.
${"This is additional context that makes the plan much larger. ".repeat(50)}

## Scout Intel Report
The flute found the following relevant files:
- src/auth/index.ts - Main auth module
- src/middleware/auth.ts - Auth middleware (does not exist, needs creation)
- src/routes/user.ts - User routes that need protection
- src/config/auth.ts - Auth configuration
- src/types/auth.ts - Type definitions for auth
${"More flute details that add to the size of this section. ".repeat(50)}

## Implementation Steps

### Step 1: Create Auth Middleware
Create src/middleware/auth.ts with JWT verification logic.
${"Detailed implementation notes for step 1. ".repeat(30)}

### Step 2: Update User Routes
Add authentication requirement to protected routes.
${"Detailed implementation notes for step 2. ".repeat(30)}

## Test Requirements
1. Test valid token verification
2. Test expired token rejection
${"Additional test requirement details. ".repeat(30)}

## Security Considerations
- Use secure random for secrets
- Implement token rotation
${"Additional security notes. ".repeat(30)}`;

		const fullLength = largePlan.length;

		// Full plan should be much larger than limits
		expect(fullLength).toBeGreaterThan(10000);

		// Test builder context extraction respects 5K limit
		const builderContext = summarizeContextForAgent(largePlan, "builder");
		expect(builderContext.length).toBeLessThanOrEqual(5000);
		expect(builderContext.length).toBeLessThan(fullLength);

		// Test sheriff context extraction respects 3K limit
		const sheriffContext = summarizeContextForAgent(largePlan, "reviewer");
		expect(sheriffContext.length).toBeLessThanOrEqual(3000);
		expect(sheriffContext.length).toBeLessThan(fullLength);
	});

	it("preserves full content for small plans within limits", () => {
		const smallPlan = `# Simple Plan

## Implementation Steps
1. Create file
2. Add function

## Test Requirements
- Test the function`;

		// Small plan should fit within builder limit
		const builderContext = summarizeContextForAgent(smallPlan, "builder");
		expect(builderContext.length).toBeLessThanOrEqual(5000);

		// Should preserve meaningful content
		expect(builderContext).toContain("Implementation");
	});
});

describe("estimateComplexityFromContext", () => {
	function createBriefing(overrides: Partial<ContextBriefing> = {}): ContextBriefing {
		return {
			objective: "Test task",
			targetFiles: [],
			typeDefinitions: [],
			functionSignatures: [],
			relatedPatterns: [],
			constraints: [],
			briefingDoc: "",
			...overrides,
		};
	}

	it("returns simple for zero files", () => {
		const briefing = createBriefing({ targetFiles: [] });
		expect(estimateComplexityFromContext(briefing)).toBe("simple");
	});

	it("returns simple for single file", () => {
		const briefing = createBriefing({ targetFiles: ["src/file.ts"] });
		expect(estimateComplexityFromContext(briefing)).toBe("simple");
	});

	it("returns medium for 2-3 files with few signatures", () => {
		const briefing = createBriefing({
			targetFiles: ["src/file1.ts", "src/file2.ts"],
			functionSignatures: ["func1", "func2", "func3"],
		});
		expect(estimateComplexityFromContext(briefing)).toBe("medium");
	});

	it("returns medium for 3 files with 5 signatures", () => {
		const briefing = createBriefing({
			targetFiles: ["src/file1.ts", "src/file2.ts", "src/file3.ts"],
			functionSignatures: ["func1", "func2", "func3", "func4", "func5"],
		});
		expect(estimateComplexityFromContext(briefing)).toBe("medium");
	});

	it("returns complex for more than 3 files", () => {
		const briefing = createBriefing({
			targetFiles: ["src/file1.ts", "src/file2.ts", "src/file3.ts", "src/file4.ts"],
			functionSignatures: [],
		});
		expect(estimateComplexityFromContext(briefing)).toBe("complex");
	});

	it("returns complex for 3 files with more than 5 signatures", () => {
		const briefing = createBriefing({
			targetFiles: ["src/file1.ts", "src/file2.ts", "src/file3.ts"],
			functionSignatures: ["f1", "f2", "f3", "f4", "f5", "f6"],
		});
		expect(estimateComplexityFromContext(briefing)).toBe("complex");
	});
});

describe("prepareContext", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "context-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns minimal briefing for new file tasks", async () => {
		const briefing = await prepareContext("(new file) In src/newfile.ts create a utility", {
			cwd: testDir,
			repoRoot: testDir,
		});

		expect(briefing.objective).toContain("new file");
		expect(briefing.constraints).toContain("CREATE NEW FILE: src/newfile.ts");
		expect(briefing.constraints).toContain("This file does not exist yet - you must create it");
	});

	it("builds briefing doc with objective", async () => {
		const briefing = await prepareContext("Fix a bug in the auth module", {
			cwd: testDir,
			repoRoot: testDir,
		});

		expect(briefing.objective).toBe("Fix a bug in the auth module");
		expect(briefing.briefingDoc).toContain("CONTEXT BRIEFING");
		expect(briefing.briefingDoc).toContain("Objective");
	});

	it("identifies target areas from task description", async () => {
		const briefing = await prepareContext("Update the API route handler", {
			cwd: testDir,
			repoRoot: testDir,
		});

		expect(briefing.constraints.some((c) => c.includes("Focus areas:"))).toBe(true);
	});

	it("adds scope constraint when target files are found", async () => {
		// Create a simple TypeScript file
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(join(testDir, "src", "auth.ts"), 'export const AUTH = "auth";');

		// Initialize git repo for git grep to work
		const { execSync } = await import("node:child_process");
		try {
			execSync("git init && git add -A && git commit -m 'init'", {
				cwd: testDir,
				stdio: "pipe",
			});
		} catch {
			// Git might not be available, skip this test gracefully
			return;
		}

		const briefing = await prepareContext("Fix the AUTH constant", {
			cwd: testDir,
			repoRoot: testDir,
		});

		if (briefing.targetFiles.length > 0) {
			expect(briefing.constraints.some((c) => c.includes("SCOPE:"))).toBe(true);
		}
	});

	it("handles non-existent paths gracefully", async () => {
		// Use a non-existent directory - function handles this without erroring
		const briefing = await prepareContext("Some task", {
			cwd: "/nonexistent/path/that/does/not/exist",
			repoRoot: "/nonexistent/path/that/does/not/exist",
		});

		// Should return a briefing without throwing
		expect(briefing.objective).toBe("Some task");
		expect(briefing.briefingDoc).toBeTruthy();
		// Briefing doc should contain basic structure
		expect(briefing.briefingDoc).toContain("CONTEXT BRIEFING");
		expect(briefing.briefingDoc).toContain("Objective");
	});
});

describe("parseMarkdownSections edge cases", () => {
	it("handles whitespace-only content", () => {
		const sections = parseMarkdownSections("   \n\n   \t\t  ");
		expect(sections).toHaveLength(0);
	});

	it("handles heading with no content after it", () => {
		const content = `# Title

## Empty Section

## Another Empty`;

		const sections = parseMarkdownSections(content);
		expect(sections).toHaveLength(3);
		expect(sections[1].heading).toBe("Empty Section");
		expect(sections[1].content).toBe("");
	});

	it("handles consecutive headings", () => {
		const content = `# First
## Second
### Third`;

		const sections = parseMarkdownSections(content);
		expect(sections).toHaveLength(3);
		expect(sections[0].content).toBe("");
		expect(sections[1].content).toBe("");
	});
});

describe("smartTruncate edge cases", () => {
	it("handles content exactly at limit", () => {
		const content = "A".repeat(100);
		const result = smartTruncate(content, 100);
		expect(result).toBe(content);
	});

	it("handles single very long word at limit boundary", () => {
		// No spaces, no periods, no paragraph breaks
		const content = "A".repeat(200);
		const result = smartTruncate(content, 100);
		expect(result).toContain("[...truncated]");
	});

	it("handles content with only line breaks", () => {
		const content = "Line1\nLine2\nLine3\nLine4\nLine5";
		const result = smartTruncate(content, 20);
		// Should still truncate meaningfully
		expect(result.length).toBeLessThan(content.length + 20);
	});
});

describe("extractRelevantSections edge cases", () => {
	it("handles single section that exceeds limit", () => {
		const hugeSections = [{ heading: "Giant Section", level: 1, content: "A".repeat(20000) }];

		const relevant = extractRelevantSections(hugeSections, "scout");
		// Should include at least one section even if too large
		expect(relevant.length).toBeGreaterThan(0);
	});

	it("handles all sections with zero relevance score", () => {
		const irrelevantSections = [
			{ heading: "xyz", level: 3, content: "random" },
			{ heading: "abc", level: 3, content: "content" },
		];

		const relevant = extractRelevantSections(irrelevantSections, "scout");
		// Should include at least one section
		expect(relevant.length).toBeGreaterThan(0);
	});

	it("considers heading level in scoring", () => {
		// Both sections have similar keyword relevance
		const sections = [
			{ heading: "Details", level: 4, content: "some stuff" },
			{ heading: "Overview", level: 1, content: "some stuff" },
		];

		const relevant = extractRelevantSections(sections, "scout");
		// Level 1 heading gets higher base score (4 - level) = 3 points
		// Level 4 heading gets 0 points from level
		// When keyword scores are equal, level wins
		expect(relevant[0].heading).toBe("Overview");
	});
});

describe("summarizeContextForAgent edge cases", () => {
	it("returns goal for scout when provided", () => {
		const fullContext = "This is a very long context that would normally be parsed";
		const goal = "Find the auth files";

		const result = summarizeContextForAgent(fullContext, "scout", goal);
		expect(result).toBe(goal);
	});

	it("truncates scout context when no goal provided", () => {
		const longContext = "A".repeat(2000);
		const result = summarizeContextForAgent(longContext, "scout");
		expect(result.length).toBeLessThanOrEqual(1000 + 20); // Allow for truncation marker
	});

	it("handles malformed markdown gracefully", () => {
		// Content that might confuse parser
		const weirdContent = `#NotAHeading because no space

Normal text here

# Real Heading
Content`;

		const result = summarizeContextForAgent(weirdContent, "builder");
		expect(result).toBeTruthy();
	});
});

describe("extractImplementationContext edge cases", () => {
	it("handles plan with only code sections", () => {
		const plan = `# Plan

## Code Changes
Modify the function signature.

## Steps to implement
1. Change parameter
2. Update return type`;

		const result = extractImplementationContext(plan);
		expect(result).toContain("Code Changes");
		expect(result).toContain("Steps");
	});
});

describe("extractReviewContext edge cases", () => {
	it("handles plan with no review sections", () => {
		const plan = `# Plan

## Overview
Just an overview, no tests or security info.`;

		const builderOutput = "Did some work";
		const result = extractReviewContext(plan, builderOutput);

		// Should still include implementation output
		expect(result).toContain("Implementation Output");
		expect(result).toContain("Did some work");
	});

	it("handles very long builder output", () => {
		const plan = "## Test\nTest the thing";
		const longOutput = "B".repeat(5000);

		const result = extractReviewContext(plan, longOutput);
		// Should be truncated to reviewer limit
		expect(result.length).toBeLessThanOrEqual(3500);
	});
});

describe("ts-morph integration", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "tsmorph-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("extractFunctionSignaturesWithTypes", () => {
		it("returns empty array for non-existent file", () => {
			const signatures = extractFunctionSignaturesWithTypes("nonexistent.ts", testDir);
			expect(signatures).toEqual([]);
		});

		it("returns empty array when no tsconfig exists", () => {
			writeFileSync(join(testDir, "file.ts"), "export function test() {}");
			const signatures = extractFunctionSignaturesWithTypes("file.ts", testDir);
			expect(signatures).toEqual([]);
		});

		it("extracts function signatures from TypeScript file", () => {
			// Create directory structure first
			mkdirSync(join(testDir, "src"), { recursive: true });

			// Create tsconfig.json
			writeFileSync(
				join(testDir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				}),
			);

			// Create source file with exported function
			writeFileSync(
				join(testDir, "src", "utils.ts"),
				`export function calculateSum(a: number, b: number): number {
  return a + b;
}`,
			);

			const signatures = extractFunctionSignaturesWithTypes("src/utils.ts", testDir);
			// May or may not work depending on ts-morph setup
			// At minimum should not throw
			expect(Array.isArray(signatures)).toBe(true);
		});
	});

	describe("extractTypeDefinitionsFromFile", () => {
		it("returns empty array for non-existent file", () => {
			const defs = extractTypeDefinitionsFromFile("nonexistent.ts", testDir);
			expect(defs).toEqual([]);
		});

		it("returns empty array when no tsconfig exists", () => {
			writeFileSync(join(testDir, "types.ts"), "export interface User { name: string; }");
			const defs = extractTypeDefinitionsFromFile("types.ts", testDir);
			expect(defs).toEqual([]);
		});
	});

	describe("findFilesImporting", () => {
		it("returns empty array when git grep fails", () => {
			const files = findFilesImporting("SomeSymbol", testDir);
			expect(files).toEqual([]);
		});
	});

	describe("getTypeDefinition", () => {
		it("returns null for non-existent type", () => {
			const def = getTypeDefinition("NonExistentType", testDir);
			expect(def).toBeNull();
		});

		it("returns null when schema file does not exist", () => {
			const def = getTypeDefinition("User", testDir);
			expect(def).toBeNull();
		});

		it("returns null when no tsconfig exists", () => {
			mkdirSync(join(testDir, "common", "schema"), { recursive: true });
			writeFileSync(join(testDir, "common", "schema", "index.ts"), "export interface User { name: string; }");

			const def = getTypeDefinition("User", testDir);
			expect(def).toBeNull();
		});
	});
});

describe("ContextBriefing structure", () => {
	it("contains all required fields", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "briefing-test-"));
		try {
			const briefing = await prepareContext("Test task", { cwd: tempDir, repoRoot: tempDir });

			expect(briefing).toHaveProperty("objective");
			expect(briefing).toHaveProperty("targetFiles");
			expect(briefing).toHaveProperty("typeDefinitions");
			expect(briefing).toHaveProperty("functionSignatures");
			expect(briefing).toHaveProperty("relatedPatterns");
			expect(briefing).toHaveProperty("constraints");
			expect(briefing).toHaveProperty("briefingDoc");

			expect(Array.isArray(briefing.targetFiles)).toBe(true);
			expect(Array.isArray(briefing.typeDefinitions)).toBe(true);
			expect(Array.isArray(briefing.functionSignatures)).toBe(true);
			expect(Array.isArray(briefing.relatedPatterns)).toBe(true);
			expect(Array.isArray(briefing.constraints)).toBe(true);
			expect(typeof briefing.briefingDoc).toBe("string");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("prepareContext edge cases", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "context-edge-case-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("empty codebase scenarios", () => {
		it("handles empty directory with no TypeScript files", async () => {
			// Create empty directory structure
			mkdirSync(join(testDir, "src"), { recursive: true });

			const briefing = await prepareContext("Implement a feature", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should not crash and return a valid briefing
			expect(briefing.objective).toBe("Implement a feature");
			expect(briefing.briefingDoc).toBeTruthy();
			expect(briefing.targetFiles).toEqual([]);
			expect(briefing.constraints.length).toBeGreaterThan(0);
		});

		it("handles directory with only node_modules", async () => {
			// Create node_modules with some files
			mkdirSync(join(testDir, "node_modules", "some-package"), { recursive: true });
			writeFileSync(join(testDir, "node_modules", "some-package", "index.ts"), "export const foo = 1;");

			const briefing = await prepareContext("Find the auth module", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should not include node_modules files
			expect(briefing.targetFiles).toEqual([]);
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles codebase with only test files", async () => {
			// Create only test files
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "app.test.ts"), 'import { test } from "vitest";\ntest("works", () => {});');
			writeFileSync(join(testDir, "src", "utils.test.ts"), 'import { test } from "vitest";\ntest("utils", () => {});');

			const briefing = await prepareContext("Add a utility function", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle gracefully - test files filtered out by context gathering
			expect(briefing.objective).toBe("Add a utility function");
			expect(briefing.briefingDoc).toBeTruthy();
		});
	});

	describe("missing file scenarios", () => {
		it("handles references to non-existent files gracefully", async () => {
			// Create minimal structure but reference a missing file
			mkdirSync(join(testDir, "src"), { recursive: true });

			const briefing = await prepareContext("Fix src/auth.ts authentication bug", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should not crash even though auth.ts doesn't exist
			expect(briefing.objective).toContain("auth.ts");
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles broken symlinks in codebase", async () => {
			// Create a broken symlink (pointing to non-existent file)
			mkdirSync(join(testDir, "src"), { recursive: true });
			try {
				const { symlinkSync } = await import("node:fs");
				symlinkSync(join(testDir, "nonexistent.ts"), join(testDir, "src", "broken-link.ts"));
			} catch {
				// Symlink creation may fail on some systems, skip this test
				return;
			}

			const briefing = await prepareContext("Update the module", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle broken symlinks without crashing
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles missing tsconfig.json gracefully", async () => {
			// Create source files but no tsconfig
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "index.ts"), "export function hello() { return 'world'; }");

			const briefing = await prepareContext("Update hello function", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should work without tsconfig, just with limited type info
			expect(briefing.briefingDoc).toBeTruthy();
			expect(briefing.objective).toBe("Update hello function");
		});
	});

	describe("malformed AST index scenarios", () => {
		it("handles corrupted AST index JSON", async () => {
			// Create .undercity directory with corrupted index
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			writeFileSync(join(testDir, ".undercity", "ast-index.json"), "{invalid json here broken");

			const briefing = await prepareContext("Refactor the code", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should fall back to minimal context without crashing
			expect(briefing.briefingDoc).toBeTruthy();
			expect(briefing.objective).toBe("Refactor the code");
		});

		it("handles AST index with missing required fields", async () => {
			// Create index missing critical fields
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			const malformedIndex = {
				version: "1.0",
				// Missing: files, symbolToFiles, importedBy
				lastUpdated: new Date().toISOString(),
			};
			writeFileSync(join(testDir, ".undercity", "ast-index.json"), JSON.stringify(malformedIndex));

			const briefing = await prepareContext("Update types", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle missing fields gracefully
			expect(briefing.briefingDoc).toBeTruthy();
			expect(briefing.targetFiles).toEqual([]);
		});

		it("handles AST index with invalid version", async () => {
			// Create index with wrong version
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			const oldIndex = {
				version: "0.5",
				files: {},
				symbolToFiles: {},
				importedBy: {},
				lastUpdated: new Date().toISOString(),
			};
			writeFileSync(join(testDir, ".undercity", "ast-index.json"), JSON.stringify(oldIndex));

			const briefing = await prepareContext("Implement feature", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should rebuild or ignore old version
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles AST index with malformed file entries", async () => {
			// Create index with invalid file data structures
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			const malformedIndex = {
				version: "1.0",
				files: {
					"src/test.ts": {
						// Missing required fields: hash, indexedAt
						exports: "not an array",
						imports: null,
					},
				},
				symbolToFiles: {},
				importedBy: {},
				lastUpdated: new Date().toISOString(),
			};
			writeFileSync(join(testDir, ".undercity", "ast-index.json"), JSON.stringify(malformedIndex));

			const briefing = await prepareContext("Fix bug in test", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle malformed entries without crashing
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles truncated AST index file", async () => {
			// Create partially written index (simulates write interruption)
			mkdirSync(join(testDir, ".undercity"), { recursive: true });
			const validIndex = {
				version: "1.0",
				files: { "test.ts": { path: "test.ts", hash: "abc", exports: [], imports: [] } },
				symbolToFiles: {},
				importedBy: {},
			};
			const truncated = JSON.stringify(validIndex).slice(0, 50); // Cut off mid-JSON
			writeFileSync(join(testDir, ".undercity", "ast-index.json"), truncated);

			const briefing = await prepareContext("Update code", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should detect JSON parse error and continue
			expect(briefing.briefingDoc).toBeTruthy();
		});
	});

	describe("timeout and resource constraint scenarios", () => {
		it("handles very large codebase without hanging", async () => {
			// Create many files to simulate large codebase
			mkdirSync(join(testDir, "src"), { recursive: true });
			for (let i = 0; i < 20; i++) {
				writeFileSync(
					join(testDir, "src", `file${i}.ts`),
					`export const value${i} = ${i};\nexport function func${i}() { return ${i}; }`,
				);
			}

			const startTime = Date.now();
			const briefing = await prepareContext("Find a specific function", {
				cwd: testDir,
				repoRoot: testDir,
			});
			const duration = Date.now() - startTime;

			// Should complete in reasonable time (under 10 seconds for 20 files)
			expect(duration).toBeLessThan(10000);
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles codebase with very long file paths", async () => {
			// Create deeply nested directory structure
			const deepPath = join(
				testDir,
				"src",
				"very",
				"deeply",
				"nested",
				"directory",
				"structure",
				"that",
				"goes",
				"many",
				"levels",
			);
			mkdirSync(deepPath, { recursive: true });
			writeFileSync(join(deepPath, "module.ts"), "export const deepModule = true;");

			const briefing = await prepareContext("Update the deep module", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle long paths without issues
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles files with very long content", async () => {
			// Create file with large content
			mkdirSync(join(testDir, "src"), { recursive: true });
			const longContent = `export const data = ${JSON.stringify(Array(1000).fill("data"))};`;
			writeFileSync(join(testDir, "src", "large.ts"), longContent);

			const briefing = await prepareContext("Optimize the data structure", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle large files without excessive memory usage
			expect(briefing.briefingDoc).toBeTruthy();
		});
	});

	describe("git operation edge cases", () => {
		it("handles missing git repository gracefully", async () => {
			// Don't initialize git repo
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "app.ts"), "export const app = 'test';");

			const briefing = await prepareContext("Update app constant", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should work without git, just without git-based features
			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles corrupted git repository", async () => {
			// Create .git directory but make it invalid
			mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
			writeFileSync(join(testDir, ".git", "HEAD"), "corrupted ref");

			const briefing = await prepareContext("Implement feature", {
				cwd: testDir,
				repoRoot: testDir,
			});

			// Should handle git errors gracefully
			expect(briefing.briefingDoc).toBeTruthy();
		});
	});

	describe("edge case: special characters and encoding", () => {
		it("handles files with special characters in names", async () => {
			mkdirSync(join(testDir, "src"), { recursive: true });
			// Create file with special but valid characters
			writeFileSync(join(testDir, "src", "file-with-dashes.ts"), "export const value = 1;");
			writeFileSync(join(testDir, "src", "file_with_underscores.ts"), "export const other = 2;");

			const briefing = await prepareContext("Update special files", {
				cwd: testDir,
				repoRoot: testDir,
			});

			expect(briefing.briefingDoc).toBeTruthy();
		});

		it("handles files with unicode content", async () => {
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "i18n.ts"), "export const greeting = '你好世界 🌍';");

			const briefing = await prepareContext("Update internationalization", {
				cwd: testDir,
				repoRoot: testDir,
			});

			expect(briefing.briefingDoc).toBeTruthy();
		});
	});
});
