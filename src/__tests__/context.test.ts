/**
 * Context Summarization Module Tests
 *
 * Tests for context.ts - smart context extraction for agents.
 */

import { describe, expect, it } from "vitest";
import {
	extractImplementationContext,
	extractRelevantSections,
	extractReviewContext,
	formatSections,
	getContextLimit,
	parseMarkdownSections,
	smartTruncate,
	summarizeContextForAgent,
} from "../context.js";

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

	it("extracts implementation sections for fabricator", () => {
		const relevant = extractRelevantSections(testSections, "fabricator");

		// Should prioritize implementation-related sections
		const headings = relevant.map((s) => s.heading);
		expect(headings).toContain("Implementation Steps");
	});

	it("extracts test sections for auditor", () => {
		const relevant = extractRelevantSections(testSections, "auditor");

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

		const relevant = extractRelevantSections(longSections, "auditor");

		// Should not exceed auditor limit (3000 chars)
		const totalLength = relevant.reduce(
			(sum, s) => sum + s.heading.length + s.content.length,
			0
		);
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

	it("returns truncated goal for scout", () => {
		const result = summarizeContextForAgent(fullPlan, "scout", "Add auth");

		expect(result.length).toBeLessThanOrEqual(1000);
		expect(result).toBe("Add auth");
	});

	it("returns full context for planner (within limit)", () => {
		const result = summarizeContextForAgent(fullPlan, "planner");

		// Planner has 10K limit, so full plan should fit
		expect(result.length).toBeLessThanOrEqual(10000);
	});

	it("extracts implementation focus for fabricator", () => {
		const result = summarizeContextForAgent(fullPlan, "fabricator");

		// Should include implementation details
		expect(result).toContain("Implementation");
		expect(result.length).toBeLessThanOrEqual(5000);
	});

	it("extracts review focus for auditor", () => {
		const result = summarizeContextForAgent(fullPlan, "auditor");

		expect(result.length).toBeLessThanOrEqual(3000);
	});

	it("handles plain text input gracefully", () => {
		const plainText =
			"Just some plain text without any markdown formatting at all.";

		const result = summarizeContextForAgent(plainText, "fabricator");

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
	it("combines plan requirements with fabricator output", () => {
		const plan = `# Plan

## Test Requirements
- Test login
- Test logout

## Security
- Check XSS`;

		const fabricatorOutput = "Created auth.ts with login/logout methods.";

		const result = extractReviewContext(plan, fabricatorOutput);

		expect(result).toContain("Review Requirements");
		expect(result).toContain("Implementation Output");
		expect(result).toContain("auth.ts");
	});

	it("truncates long fabricator output", () => {
		const plan = "## Test Requirements\nTest everything.";
		const longOutput = "A".repeat(3000);

		const result = extractReviewContext(plan, longOutput);

		// Should be within auditor limit
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
		expect(getContextLimit("fabricator")).toBe(5000);
		expect(getContextLimit("auditor")).toBe(3000);
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
The scout found the following relevant files:
- src/auth/index.ts - Main auth module
- src/middleware/auth.ts - Auth middleware (does not exist, needs creation)
- src/routes/user.ts - User routes that need protection
- src/config/auth.ts - Auth configuration
- src/types/auth.ts - Type definitions for auth
${"More scout details that add to the size of this section. ".repeat(50)}

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

		// Test fabricator context extraction respects 5K limit
		const fabricatorContext = summarizeContextForAgent(
			largePlan,
			"fabricator"
		);
		expect(fabricatorContext.length).toBeLessThanOrEqual(5000);
		expect(fabricatorContext.length).toBeLessThan(fullLength);

		// Test auditor context extraction respects 3K limit
		const auditorContext = summarizeContextForAgent(largePlan, "auditor");
		expect(auditorContext.length).toBeLessThanOrEqual(3000);
		expect(auditorContext.length).toBeLessThan(fullLength);
	});

	it("preserves full content for small plans within limits", () => {
		const smallPlan = `# Simple Plan

## Implementation Steps
1. Create file
2. Add function

## Test Requirements
- Test the function`;

		// Small plan should fit within fabricator limit
		const fabricatorContext = summarizeContextForAgent(smallPlan, "fabricator");
		expect(fabricatorContext.length).toBeLessThanOrEqual(5000);

		// Should preserve meaningful content
		expect(fabricatorContext).toContain("Implementation");
	});
});
