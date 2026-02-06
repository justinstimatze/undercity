/**
 * Tests for prompt-builder.ts ticket-related functionality
 *
 * Tests formatTicketContext and ticket injection into prompts.
 */

import { describe, expect, it } from "vitest";
import type { TicketContent } from "../types.js";
import { formatTicketContext } from "../worker/prompt-builder.js";

describe("prompt-builder ticket functionality", () => {
	describe("formatTicketContext", () => {
		it("should return empty string for empty ticket", () => {
			const ticket: TicketContent = {};
			const result = formatTicketContext(ticket);
			expect(result).toBe("");
		});

		it("should format description", () => {
			const ticket: TicketContent = {
				description: "This is the task description.",
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Task Description");
			expect(result).toContain("This is the task description.");
		});

		it("should format acceptance criteria as checklist", () => {
			const ticket: TicketContent = {
				acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Acceptance Criteria");
			expect(result).toContain("- [ ] Criterion 1");
			expect(result).toContain("- [ ] Criterion 2");
			expect(result).toContain("- [ ] Criterion 3");
		});

		it("should format test plan", () => {
			const ticket: TicketContent = {
				testPlan: "1. Unit test X\n2. Integration test Y",
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Test Plan");
			expect(result).toContain("1. Unit test X");
		});

		it("should format implementation notes", () => {
			const ticket: TicketContent = {
				implementationNotes: "Use the existing utility function.",
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Implementation Notes");
			expect(result).toContain("Use the existing utility function.");
		});

		it("should format rationale", () => {
			const ticket: TicketContent = {
				rationale: "This improves reliability and user experience.",
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Why This Matters");
			expect(result).toContain("This improves reliability and user experience.");
		});

		it("should format research findings as list", () => {
			const ticket: TicketContent = {
				researchFindings: ["Finding 1", "Finding 2"],
			};
			const result = formatTicketContext(ticket);
			expect(result).toContain("## Research Findings");
			expect(result).toContain("- Finding 1");
			expect(result).toContain("- Finding 2");
		});

		it("should format full ticket with all fields", () => {
			const ticket: TicketContent = {
				description: "Full description",
				acceptanceCriteria: ["AC1", "AC2"],
				testPlan: "Test plan here",
				implementationNotes: "Notes here",
				rationale: "Rationale here",
				researchFindings: ["Research 1"],
				source: "pm",
			};

			const result = formatTicketContext(ticket);

			expect(result).toContain("## Task Description");
			expect(result).toContain("## Acceptance Criteria");
			expect(result).toContain("## Test Plan");
			expect(result).toContain("## Implementation Notes");
			expect(result).toContain("## Why This Matters");
			expect(result).toContain("## Research Findings");
		});

		it("should separate sections with double newlines", () => {
			const ticket: TicketContent = {
				description: "Description",
				rationale: "Rationale",
			};
			const result = formatTicketContext(ticket);
			// Sections should be separated by double newline
			expect(result).toContain("Description\n\n## Why This Matters");
		});

		it("should skip empty acceptanceCriteria array", () => {
			const ticket: TicketContent = {
				description: "Description",
				acceptanceCriteria: [],
			};
			const result = formatTicketContext(ticket);
			expect(result).not.toContain("## Acceptance Criteria");
		});

		it("should skip empty researchFindings array", () => {
			const ticket: TicketContent = {
				description: "Description",
				researchFindings: [],
			};
			const result = formatTicketContext(ticket);
			expect(result).not.toContain("## Research Findings");
		});

		it("should not include source field in output", () => {
			const ticket: TicketContent = {
				source: "pm",
			};
			const result = formatTicketContext(ticket);
			// Source is metadata, not displayed in context
			expect(result).toBe("");
		});
	});
});
