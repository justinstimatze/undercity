/**
 * Tests for ticket-loader.ts
 *
 * Tests YAML/JSON ticket parsing and validation.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTicketFile, loadTicketFromFile, TicketFileSchema } from "../ticket-loader.js";

describe("ticket-loader.ts", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "ticket-test-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("TicketFileSchema", () => {
		it("should validate minimal ticket with only objective", () => {
			const result = TicketFileSchema.safeParse({ objective: "Fix the bug" });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.objective).toBe("Fix the bug");
			}
		});

		it("should reject empty objective", () => {
			const result = TicketFileSchema.safeParse({ objective: "" });
			expect(result.success).toBe(false);
		});

		it("should reject missing objective", () => {
			const result = TicketFileSchema.safeParse({ description: "Some description" });
			expect(result.success).toBe(false);
		});

		it("should validate full ticket with all fields", () => {
			const fullTicket = {
				objective: "Add retry logic to API client",
				description: "The current API client lacks retry logic",
				acceptanceCriteria: ["fetchWithRetry retries on 5xx", "Max 3 retries"],
				testPlan: "Unit test with mocked fetch",
				implementationNotes: "Use existing sleep helper",
				source: "pm" as const,
				researchFindings: ["Best practice is exponential backoff"],
				rationale: "Improves reliability",
				suggestedPriority: 500,
				tags: ["reliability", "api"],
			};

			const result = TicketFileSchema.safeParse(fullTicket);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual(fullTicket);
			}
		});

		it("should validate all source values", () => {
			const sources = ["pm", "user", "research", "codebase_gap", "pattern_analysis"] as const;
			for (const source of sources) {
				const result = TicketFileSchema.safeParse({ objective: "Test", source });
				expect(result.success).toBe(true);
			}
		});

		it("should reject invalid source value", () => {
			const result = TicketFileSchema.safeParse({ objective: "Test", source: "invalid" });
			expect(result.success).toBe(false);
		});
	});

	describe("loadTicketFromFile", () => {
		describe("YAML parsing", () => {
			it("should load minimal YAML ticket", () => {
				const filePath = join(testDir, "ticket.yaml");
				writeFileSync(filePath, "objective: Fix the bug\n");

				const result = loadTicketFromFile(filePath);

				expect(result.objective).toBe("Fix the bug");
				expect(result.ticket).toEqual({});
			});

			it("should load YAML ticket with .yml extension", () => {
				const filePath = join(testDir, "ticket.yml");
				writeFileSync(filePath, "objective: Fix the bug\n");

				const result = loadTicketFromFile(filePath);

				expect(result.objective).toBe("Fix the bug");
			});

			it("should load full YAML ticket", () => {
				const filePath = join(testDir, "ticket.yaml");
				const yaml = `objective: Add retry logic
description: |
  The current API client lacks retry logic.
  This task adds exponential backoff.
acceptanceCriteria:
  - fetchWithRetry retries on 5xx
  - Max 3 retries with exponential backoff
testPlan: |
  Unit test with mocked fetch
implementationNotes: Use existing sleep helper
source: pm
researchFindings:
  - Best practice is exponential backoff
  - Jitter prevents thundering herd
rationale: Improves reliability
suggestedPriority: 500
tags:
  - reliability
  - api
`;
				writeFileSync(filePath, yaml);

				const result = loadTicketFromFile(filePath);

				expect(result.objective).toBe("Add retry logic");
				expect(result.priority).toBe(500);
				expect(result.tags).toEqual(["reliability", "api"]);
				expect(result.ticket.description).toContain("API client lacks retry logic");
				expect(result.ticket.acceptanceCriteria).toHaveLength(2);
				expect(result.ticket.source).toBe("pm");
				expect(result.ticket.researchFindings).toHaveLength(2);
			});
		});

		describe("JSON parsing", () => {
			it("should load minimal JSON ticket", () => {
				const filePath = join(testDir, "ticket.json");
				writeFileSync(filePath, JSON.stringify({ objective: "Fix the bug" }));

				const result = loadTicketFromFile(filePath);

				expect(result.objective).toBe("Fix the bug");
				expect(result.ticket).toEqual({});
			});

			it("should load full JSON ticket", () => {
				const filePath = join(testDir, "ticket.json");
				const data = {
					objective: "Add retry logic",
					description: "The current API client lacks retry logic",
					acceptanceCriteria: ["fetchWithRetry retries on 5xx"],
					testPlan: "Unit test",
					implementationNotes: "Use sleep helper",
					source: "research",
					researchFindings: ["Exponential backoff is best"],
					rationale: "Improves reliability",
					suggestedPriority: 700,
					tags: ["api"],
				};
				writeFileSync(filePath, JSON.stringify(data));

				const result = loadTicketFromFile(filePath);

				expect(result.objective).toBe("Add retry logic");
				expect(result.priority).toBe(700);
				expect(result.tags).toEqual(["api"]);
				expect(result.ticket.source).toBe("research");
			});
		});

		describe("error handling", () => {
			it("should throw for non-existent file", () => {
				const filePath = join(testDir, "nonexistent.yaml");

				expect(() => loadTicketFromFile(filePath)).toThrow("Ticket file not found");
			});

			it("should throw for unsupported extension", () => {
				const filePath = join(testDir, "ticket.txt");
				writeFileSync(filePath, "objective: Test");

				expect(() => loadTicketFromFile(filePath)).toThrow("Unsupported file extension");
			});

			it("should throw for invalid YAML syntax", () => {
				const filePath = join(testDir, "invalid.yaml");
				writeFileSync(filePath, "objective: [invalid: yaml:");

				expect(() => loadTicketFromFile(filePath)).toThrow();
			});

			it("should throw for invalid JSON syntax", () => {
				const filePath = join(testDir, "invalid.json");
				writeFileSync(filePath, "{ invalid json }");

				expect(() => loadTicketFromFile(filePath)).toThrow("Failed to parse");
			});

			it("should throw for validation errors", () => {
				const filePath = join(testDir, "invalid.yaml");
				writeFileSync(filePath, "description: Missing objective\n");

				expect(() => loadTicketFromFile(filePath)).toThrow("Invalid ticket file");
			});

			it("should include field path in validation error", () => {
				const filePath = join(testDir, "invalid.yaml");
				writeFileSync(filePath, "objective: Test\nsource: invalid_source\n");

				expect(() => loadTicketFromFile(filePath)).toThrow("source");
			});
		});

		describe("ticket content extraction", () => {
			it("should only include present fields in ticket", () => {
				const filePath = join(testDir, "ticket.yaml");
				writeFileSync(
					filePath,
					`objective: Test task
description: A description
rationale: Why this matters
`,
				);

				const result = loadTicketFromFile(filePath);

				expect(result.ticket).toEqual({
					description: "A description",
					rationale: "Why this matters",
				});
				// Should not have undefined fields
				expect("acceptanceCriteria" in result.ticket).toBe(false);
				expect("testPlan" in result.ticket).toBe(false);
			});

			it("should extract priority and tags separately from ticket", () => {
				const filePath = join(testDir, "ticket.yaml");
				writeFileSync(
					filePath,
					`objective: Test task
suggestedPriority: 100
tags:
  - tag1
  - tag2
`,
				);

				const result = loadTicketFromFile(filePath);

				expect(result.priority).toBe(100);
				expect(result.tags).toEqual(["tag1", "tag2"]);
				// Priority and tags should not be in ticket
				expect("suggestedPriority" in result.ticket).toBe(false);
				expect("tags" in result.ticket).toBe(false);
			});
		});
	});

	describe("Markdown parsing", () => {
		it("should load markdown with frontmatter and body as description", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `---
objective: Add retry logic
suggestedPriority: 500
tags:
  - reliability
  - api
---

# Add retry logic

The API client needs retry logic for transient failures.

## Details

- Use exponential backoff
- Max 3 retries
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Add retry logic");
			expect(result.priority).toBe(500);
			expect(result.tags).toEqual(["reliability", "api"]);
			expect(result.ticket.description).toContain("API client needs retry logic");
			expect(result.ticket.description).toContain("exponential backoff");
		});

		it("should use first heading as objective if not in frontmatter", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `---
suggestedPriority: 100
---

# Fix authentication bug

Users are getting logged out randomly.
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Fix authentication bug");
			expect(result.priority).toBe(100);
			expect(result.ticket.description).toBe("Users are getting logged out randomly.");
		});

		it("should load markdown without frontmatter using heading as objective", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `# Simple task objective

This is the description of the task.

With multiple paragraphs.
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Simple task objective");
			expect(result.ticket.description).toContain("description of the task");
		});

		it("should prefer frontmatter description over body", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `---
objective: Task with explicit description
description: This is the explicit description from frontmatter.
---

This body content should be ignored since description is in frontmatter.
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.ticket.description).toBe("This is the explicit description from frontmatter.");
		});

		it("should parse all frontmatter fields", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `---
objective: Full featured ticket
suggestedPriority: 750
tags:
  - feature
  - v2
acceptanceCriteria:
  - Feature works correctly
  - Tests pass
testPlan: Run integration tests
implementationNotes: Check existing patterns
rationale: Users requested this
source: user
dependsOn:
  - task-123
relatedTo:
  - task-456
---

## Implementation Guide

Follow the existing patterns.
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Full featured ticket");
			expect(result.priority).toBe(750);
			expect(result.tags).toEqual(["feature", "v2"]);
			expect(result.dependsOn).toEqual(["task-123"]);
			expect(result.relatedTo).toEqual(["task-456"]);
			expect(result.ticket.acceptanceCriteria).toEqual(["Feature works correctly", "Tests pass"]);
			expect(result.ticket.testPlan).toBe("Run integration tests");
			expect(result.ticket.implementationNotes).toBe("Check existing patterns");
			expect(result.ticket.rationale).toBe("Users requested this");
			expect(result.ticket.source).toBe("user");
			expect(result.ticket.description).toContain("Implementation Guide");
		});

		it("should throw for markdown without heading or frontmatter", () => {
			const filePath = join(testDir, "ticket.md");
			writeFileSync(filePath, "Just some text without a heading.");

			expect(() => loadTicketFromFile(filePath)).toThrow("must have YAML frontmatter or a # heading");
		});

		it("should handle Windows-style line endings", () => {
			const filePath = join(testDir, "ticket.md");
			const content = "---\r\nobjective: Windows line endings\r\n---\r\n\r\nDescription here.";
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Windows line endings");
		});

		it("should handle empty body after frontmatter", () => {
			const filePath = join(testDir, "ticket.md");
			const content = `---
objective: Ticket with no body
rationale: Just metadata
---
`;
			writeFileSync(filePath, content);

			const result = loadTicketFromFile(filePath);

			expect(result.objective).toBe("Ticket with no body");
			expect(result.ticket.rationale).toBe("Just metadata");
			expect(result.ticket.description).toBeUndefined();
		});
	});

	describe("isTicketFile", () => {
		it("should return true for .yaml files", () => {
			expect(isTicketFile("task.yaml")).toBe(true);
		});

		it("should return true for .yml files", () => {
			expect(isTicketFile("task.yml")).toBe(true);
		});

		it("should return true for .json files", () => {
			expect(isTicketFile("task.json")).toBe(true);
		});

		it("should return true for .md files", () => {
			expect(isTicketFile("task.md")).toBe(true);
		});

		it("should return false for other extensions", () => {
			expect(isTicketFile("task.txt")).toBe(false);
			expect(isTicketFile("task.ts")).toBe(false);
			expect(isTicketFile("task.html")).toBe(false);
		});

		it("should handle uppercase extensions", () => {
			expect(isTicketFile("task.YAML")).toBe(true);
			expect(isTicketFile("task.JSON")).toBe(true);
			expect(isTicketFile("task.MD")).toBe(true);
		});

		it("should handle paths with directories", () => {
			expect(isTicketFile("/path/to/task.yaml")).toBe(true);
			expect(isTicketFile("./tickets/task.json")).toBe(true);
			expect(isTicketFile("~/.claude/plans/task.md")).toBe(true);
		});
	});
});
