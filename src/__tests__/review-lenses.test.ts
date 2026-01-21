/**
 * Tests for review-lenses.ts
 *
 * Tests the deterministic review lens system that provides
 * focused code review perspectives.
 */

import { describe, expect, it } from "vitest";
import {
	formatLens,
	getAllLenses,
	getLensesByPriority,
	getQuickReviewLenses,
	REVIEW_LENSES,
	type ReviewLens,
} from "../review-lenses.js";

describe("review-lenses", () => {
	describe("REVIEW_LENSES constant", () => {
		it("contains all expected lenses", () => {
			const ids = REVIEW_LENSES.map((l) => l.id);
			expect(ids).toContain("security");
			expect(ids).toContain("error-handling");
			expect(ids).toContain("correctness");
			expect(ids).toContain("edge-cases");
			expect(ids).toContain("performance");
			expect(ids).toContain("maintainability");
		});

		it("has valid structure for all lenses", () => {
			for (const lens of REVIEW_LENSES) {
				expect(lens.id).toBeTruthy();
				expect(lens.name).toBeTruthy();
				expect(["critical", "high", "medium"]).toContain(lens.priority);
				expect(lens.prompt).toBeTruthy();
				expect(lens.prompt.length).toBeGreaterThan(50);
			}
		});

		it("has critical lenses first in order", () => {
			const firstTwo = REVIEW_LENSES.slice(0, 2);
			expect(firstTwo.every((l) => l.priority === "critical")).toBe(true);
		});
	});

	describe("getLensesByPriority", () => {
		it("returns only critical lenses when priority is critical", () => {
			const critical = getLensesByPriority("critical");
			expect(critical.length).toBeGreaterThan(0);
			expect(critical.every((l) => l.priority === "critical")).toBe(true);
		});

		it("returns only high lenses when priority is high", () => {
			const high = getLensesByPriority("high");
			expect(high.length).toBeGreaterThan(0);
			expect(high.every((l) => l.priority === "high")).toBe(true);
		});

		it("returns only medium lenses when priority is medium", () => {
			const medium = getLensesByPriority("medium");
			expect(medium.length).toBeGreaterThan(0);
			expect(medium.every((l) => l.priority === "medium")).toBe(true);
		});

		it("returns security and error-handling as critical", () => {
			const critical = getLensesByPriority("critical");
			const ids = critical.map((l) => l.id);
			expect(ids).toContain("security");
			expect(ids).toContain("error-handling");
		});

		it("returns correctness and edge-cases as high", () => {
			const high = getLensesByPriority("high");
			const ids = high.map((l) => l.id);
			expect(ids).toContain("correctness");
			expect(ids).toContain("edge-cases");
		});

		it("returns performance and maintainability as medium", () => {
			const medium = getLensesByPriority("medium");
			const ids = medium.map((l) => l.id);
			expect(ids).toContain("performance");
			expect(ids).toContain("maintainability");
		});
	});

	describe("getQuickReviewLenses", () => {
		it("returns critical and high priority lenses only", () => {
			const quick = getQuickReviewLenses();
			expect(quick.every((l) => l.priority === "critical" || l.priority === "high")).toBe(true);
		});

		it("excludes medium priority lenses", () => {
			const quick = getQuickReviewLenses();
			expect(quick.some((l) => l.priority === "medium")).toBe(false);
		});

		it("returns more lenses than critical alone", () => {
			const quick = getQuickReviewLenses();
			const critical = getLensesByPriority("critical");
			expect(quick.length).toBeGreaterThan(critical.length);
		});

		it("returns fewer lenses than getAllLenses", () => {
			const quick = getQuickReviewLenses();
			const all = getAllLenses();
			expect(quick.length).toBeLessThan(all.length);
		});
	});

	describe("getAllLenses", () => {
		it("returns all lenses", () => {
			const all = getAllLenses();
			expect(all.length).toBe(REVIEW_LENSES.length);
		});

		it("returns a copy, not the original array", () => {
			const all = getAllLenses();
			expect(all).not.toBe(REVIEW_LENSES);
			expect(all).toEqual(REVIEW_LENSES);
		});

		it("modifications to returned array do not affect original", () => {
			const all = getAllLenses();
			const originalLength = REVIEW_LENSES.length;
			all.push({
				id: "test",
				name: "Test",
				priority: "medium",
				prompt: "test prompt",
			});
			expect(REVIEW_LENSES.length).toBe(originalLength);
		});
	});

	describe("formatLens", () => {
		it("formats critical lens with red circle", () => {
			const lens: ReviewLens = {
				id: "security",
				name: "Security",
				priority: "critical",
				prompt: "test",
			};
			expect(formatLens(lens)).toBe("🔴 Security");
		});

		it("formats high priority lens with yellow circle", () => {
			const lens: ReviewLens = {
				id: "correctness",
				name: "Correctness",
				priority: "high",
				prompt: "test",
			};
			expect(formatLens(lens)).toBe("🟡 Correctness");
		});

		it("formats medium priority lens with green circle", () => {
			const lens: ReviewLens = {
				id: "performance",
				name: "Performance",
				priority: "medium",
				prompt: "test",
			};
			expect(formatLens(lens)).toBe("🟢 Performance");
		});

		it("formats all actual lenses correctly", () => {
			for (const lens of REVIEW_LENSES) {
				const formatted = formatLens(lens);
				expect(formatted).toContain(lens.name);
				if (lens.priority === "critical") {
					expect(formatted).toContain("🔴");
				} else if (lens.priority === "high") {
					expect(formatted).toContain("🟡");
				} else {
					expect(formatted).toContain("🟢");
				}
			}
		});
	});

	describe("lens prompts", () => {
		it("security lens checks for injection vulnerabilities", () => {
			const security = REVIEW_LENSES.find((l) => l.id === "security");
			expect(security?.prompt).toContain("Injection");
		});

		it("error-handling lens checks for unhandled exceptions", () => {
			const errorHandling = REVIEW_LENSES.find((l) => l.id === "error-handling");
			expect(errorHandling?.prompt).toContain("Unhandled exceptions");
		});

		it("correctness lens checks for off-by-one errors", () => {
			const correctness = REVIEW_LENSES.find((l) => l.id === "correctness");
			expect(correctness?.prompt).toContain("Off-by-one");
		});

		it("edge-cases lens checks for empty arrays", () => {
			const edgeCases = REVIEW_LENSES.find((l) => l.id === "edge-cases");
			expect(edgeCases?.prompt).toContain("Empty arrays");
		});

		it("performance lens checks for N+1 queries", () => {
			const performance = REVIEW_LENSES.find((l) => l.id === "performance");
			expect(performance?.prompt).toContain("N+1");
		});

		it("maintainability lens checks for unclear names", () => {
			const maintainability = REVIEW_LENSES.find((l) => l.id === "maintainability");
			expect(maintainability?.prompt).toContain("Unclear");
		});
	});
});
