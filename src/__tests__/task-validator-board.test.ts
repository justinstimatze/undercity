/**
 * Tests for task board validation
 */
import { describe, expect, it } from "vitest";
import {
	type BoardValidationReport,
	formatBoardValidationReport,
	validateTaskBoard,
	validateTaskObject,
} from "../task-validator.js";

describe("task board validation", () => {
	describe("validateTaskObject", () => {
		it("should validate a valid task", () => {
			const task = {
				id: "task-123",
				objective: "Do something useful",
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues).toHaveLength(0);
		});

		it("should detect missing id", () => {
			const task = {
				objective: "Do something",
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "missing_field" && i.field === "id")).toBe(true);
		});

		it("should detect missing objective", () => {
			const task = {
				id: "task-123",
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "missing_field" && i.field === "objective")).toBe(true);
		});

		it("should detect empty objective", () => {
			const task = {
				id: "task-123",
				objective: "   ",
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "empty_value" && i.field === "objective")).toBe(true);
		});

		it("should detect invalid status", () => {
			const task = {
				id: "task-123",
				objective: "Do something",
				status: "invalid_status",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "invalid_enum" && i.field === "status")).toBe(true);
		});

		it("should detect invalid date", () => {
			const task = {
				id: "task-123",
				objective: "Do something",
				status: "pending",
				createdAt: "not-a-date",
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "invalid_date" && i.field === "createdAt")).toBe(true);
		});

		it("should detect orphaned subtask", () => {
			const task = {
				id: "task-123",
				objective: "Subtask",
				status: "pending",
				parentId: "task-nonexistent",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "orphaned_subtask")).toBe(true);
		});

		it("should detect invalid dependency reference", () => {
			const task = {
				id: "task-123",
				objective: "Do something",
				status: "pending",
				dependsOn: ["task-nonexistent"],
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(task, [task]);
			expect(issues.some((i) => i.category === "invalid_reference" && i.field === "dependsOn")).toBe(true);
		});

		it("should detect inconsistent parent-child relationship", () => {
			const parent = {
				id: "task-parent",
				objective: "Parent task",
				status: "pending",
				subtaskIds: [],
				createdAt: new Date().toISOString(),
			};
			const child = {
				id: "task-child",
				objective: "Child task",
				status: "pending",
				parentId: "task-parent",
				createdAt: new Date().toISOString(),
			};
			const issues = validateTaskObject(child, [parent, child]);
			expect(issues.some((i) => i.category === "inconsistent_state" && i.field === "parentId")).toBe(true);
		});
	});

	describe("validateTaskBoard", () => {
		it("should validate a valid task board", () => {
			const tasks = [
				{
					id: "task-1",
					objective: "Task 1",
					status: "pending",
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-2",
					objective: "Task 2",
					status: "complete",
					createdAt: new Date().toISOString(),
				},
			];
			const report = validateTaskBoard(tasks);
			expect(report.valid).toBe(true);
			expect(report.totalTasks).toBe(2);
			expect(report.validTasks).toBe(2);
			expect(report.invalidTasks).toBe(0);
		});

		it("should detect multiple issues across tasks", () => {
			const tasks = [
				{
					id: "task-1",
					objective: "",
					status: "pending",
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-2",
					objective: "Task 2",
					status: "invalid_status",
					createdAt: new Date().toISOString(),
				},
			];
			const report = validateTaskBoard(tasks);
			expect(report.valid).toBe(false);
			expect(report.issues.length).toBeGreaterThan(0);
			expect(report.statistics.bySeverity.error).toBeGreaterThan(0);
		});

		it("should detect circular dependencies", () => {
			const tasks = [
				{
					id: "task-1",
					objective: "Task 1",
					status: "pending",
					dependsOn: ["task-2"],
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-2",
					objective: "Task 2",
					status: "pending",
					dependsOn: ["task-1"],
					createdAt: new Date().toISOString(),
				},
			];
			const report = validateTaskBoard(tasks);
			expect(report.valid).toBe(false);
			expect(report.issues.some((i) => i.category === "circular_dependency")).toBe(true);
		});

		it("should provide statistics by category and severity", () => {
			const tasks = [
				{
					id: "task-1",
					objective: "",
					status: "invalid",
					createdAt: "not-a-date",
				},
			];
			const report = validateTaskBoard(tasks);
			expect(report.statistics.byCategory.empty_value).toBeGreaterThan(0);
			expect(report.statistics.byCategory.invalid_enum).toBeGreaterThan(0);
			expect(report.statistics.byCategory.invalid_date).toBeGreaterThan(0);
			expect(report.statistics.bySeverity.error).toBeGreaterThan(0);
		});
	});

	describe("formatBoardValidationReport", () => {
		it("should format valid board report", () => {
			const report: BoardValidationReport = {
				valid: true,
				totalTasks: 5,
				validTasks: 5,
				invalidTasks: 0,
				issues: [],
				statistics: {
					byCategory: {
						missing_field: 0,
						invalid_enum: 0,
						invalid_date: 0,
						invalid_reference: 0,
						orphaned_subtask: 0,
						circular_dependency: 0,
						inconsistent_state: 0,
						empty_value: 0,
					},
					bySeverity: {
						error: 0,
						warning: 0,
						info: 0,
					},
				},
			};
			const lines = formatBoardValidationReport(report);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toContain("valid");
		});

		it("should format invalid board report with errors", () => {
			const report: BoardValidationReport = {
				valid: false,
				totalTasks: 3,
				validTasks: 1,
				invalidTasks: 2,
				issues: [
					{
						taskId: "task-1",
						severity: "error",
						category: "missing_field",
						message: "Missing required field",
						field: "objective",
						suggestion: "Add a task objective",
					},
				],
				statistics: {
					byCategory: {
						missing_field: 1,
						invalid_enum: 0,
						invalid_date: 0,
						invalid_reference: 0,
						orphaned_subtask: 0,
						circular_dependency: 0,
						inconsistent_state: 0,
						empty_value: 0,
					},
					bySeverity: {
						error: 1,
						warning: 0,
						info: 0,
					},
				},
			};
			const lines = formatBoardValidationReport(report);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.some((line) => line.includes("failed"))).toBe(true);
			expect(lines.some((line) => line.includes("task-1"))).toBe(true);
		});
	});
});
