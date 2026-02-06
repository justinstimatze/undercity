/**
 * Tests for validation.ts
 *
 * Tests validation middleware for command outputs including edge cases
 * like empty output, malformed input, Buffer handling, and encoding issues.
 */

import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../errors.js";
import {
	validateCommandOutput,
	validateGitDiffOutput,
	validateGitStatusOutput,
	validateLintOutput,
	validateSpellCheckOutput,
	validateTestOutput,
	validateTypecheckOutput,
} from "../validation.js";

describe("validation.ts", () => {
	describe("validateCommandOutput", () => {
		it("should accept valid string output", () => {
			const output = "valid output";
			expect(validateCommandOutput(output, "test")).toBe(output);
		});

		it("should accept empty string output", () => {
			const output = "";
			expect(validateCommandOutput(output, "test")).toBe(output);
		});

		it("should convert Buffer to string", () => {
			const buffer = Buffer.from("buffer output", "utf-8");
			const result = validateCommandOutput(buffer, "test");
			expect(result).toBe("buffer output");
		});

		it("should throw on null output", () => {
			expect(() => validateCommandOutput(null, "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput(null, "test")).toThrow("output is null or undefined");
		});

		it("should throw on undefined output", () => {
			expect(() => validateCommandOutput(undefined, "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput(undefined, "test")).toThrow("output is null or undefined");
		});

		it("should throw on non-string, non-Buffer output", () => {
			expect(() => validateCommandOutput(123, "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput(123, "test")).toThrow("must be string or Buffer");
		});

		it("should throw on object output", () => {
			expect(() => validateCommandOutput({ foo: "bar" }, "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput({ foo: "bar" }, "test")).toThrow("must be string or Buffer");
		});

		it("should throw on array output", () => {
			expect(() => validateCommandOutput(["item"], "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput(["item"], "test")).toThrow("must be string or Buffer");
		});

		it("should throw on output exceeding size limit", () => {
			const largeOutput = "x".repeat(11 * 1024 * 1024); // 11MB
			expect(() => validateCommandOutput(largeOutput, "test")).toThrow(InvalidInputError);
			expect(() => validateCommandOutput(largeOutput, "test")).toThrow("exceeds size limit");
		});

		it("should handle output at size limit", () => {
			const maxOutput = "x".repeat(10 * 1024 * 1024); // Exactly 10MB
			const result = validateCommandOutput(maxOutput, "test");
			expect(result).toBe(maxOutput);
		});

		it("should include command name in error messages", () => {
			expect(() => validateCommandOutput(null, "my-command")).toThrow("my-command");
		});
	});

	describe("validateGitDiffOutput", () => {
		it("should accept valid git diff output", () => {
			const validDiff = `diff --git a/src/file.ts b/src/file.ts
index abc123..def456 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
+new line
 existing line`;
			expect(validateGitDiffOutput(validDiff)).toBe(validDiff);
		});

		it("should accept empty diff (no changes)", () => {
			expect(validateGitDiffOutput("")).toBe("");
			expect(validateGitDiffOutput("   \n  ")).toBe("   \n  ");
		});

		it("should accept diff stat output", () => {
			const diffStat = " src/file.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)";
			expect(validateGitDiffOutput(diffStat)).toBe(diffStat);
		});

		it("should throw on merge conflict markers (<<<<<<<)", () => {
			const conflictDiff = `diff --git a/src/file.ts
<<<<<<< HEAD
local change
=======
remote change
>>>>>>> branch`;
			expect(() => validateGitDiffOutput(conflictDiff)).toThrow(InvalidInputError);
			expect(() => validateGitDiffOutput(conflictDiff)).toThrow("merge conflict markers");
		});

		it("should throw on ======= conflict marker", () => {
			const conflict = "some content\n=======\nmore content";
			expect(() => validateGitDiffOutput(conflict)).toThrow(InvalidInputError);
			expect(() => validateGitDiffOutput(conflict)).toThrow("merge conflict markers");
		});

		it("should throw on >>>>>>> conflict marker", () => {
			const conflict = "some content\n>>>>>>> branch-name";
			expect(() => validateGitDiffOutput(conflict)).toThrow(InvalidInputError);
			expect(() => validateGitDiffOutput(conflict)).toThrow("merge conflict markers");
		});

		it("should handle diff with added files", () => {
			const newFileDiff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/new-file.ts`;
			expect(validateGitDiffOutput(newFileDiff)).toBe(newFileDiff);
		});

		it("should handle diff with deleted files", () => {
			const deletedDiff = `diff --git a/old-file.ts b/old-file.ts
deleted file mode 100644
index abc123..0000000`;
			expect(validateGitDiffOutput(deletedDiff)).toBe(deletedDiff);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from("diff --git a/file.ts b/file.ts\nvalid diff", "utf-8");
			const result = validateGitDiffOutput(buffer);
			expect(result).toBe("diff --git a/file.ts b/file.ts\nvalid diff");
		});
	});

	describe("validateGitStatusOutput", () => {
		it("should accept valid porcelain status output", () => {
			const status = "?? untracked-file.ts\n M modified-file.ts\nA  added-file.ts";
			expect(validateGitStatusOutput(status)).toBe(status);
		});

		it("should accept empty status (clean working tree)", () => {
			expect(validateGitStatusOutput("")).toBe("");
			expect(validateGitStatusOutput("  \n  ")).toBe("  \n  ");
		});

		it("should accept status with untracked files", () => {
			const status = "?? src/new-file.ts\n?? dist/output.js";
			expect(validateGitStatusOutput(status)).toBe(status);
		});

		it("should accept status with modified files", () => {
			const status = " M src/modified.ts\nMM src/staged-and-modified.ts";
			expect(validateGitStatusOutput(status)).toBe(status);
		});

		it("should throw on malformed short line", () => {
			const malformed = "?? valid-line.ts\nAB\n M another-valid.ts";
			expect(() => validateGitStatusOutput(malformed)).toThrow(InvalidInputError);
			expect(() => validateGitStatusOutput(malformed)).toThrow("malformed line");
		});

		it("should throw on line with only status code", () => {
			const malformed = "??";
			expect(() => validateGitStatusOutput(malformed)).toThrow(InvalidInputError);
			expect(() => validateGitStatusOutput(malformed)).toThrow("too short");
		});

		it("should accept status with renamed files", () => {
			const status = "R  old-name.ts -> new-name.ts";
			expect(validateGitStatusOutput(status)).toBe(status);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from("?? file.ts", "utf-8");
			const result = validateGitStatusOutput(buffer);
			expect(result).toBe("?? file.ts");
		});
	});

	describe("validateTypecheckOutput", () => {
		it("should accept valid TypeScript error output", () => {
			const tsError = `src/file.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/other.ts(20,15): error TS2345: Argument of type 'boolean' is not assignable to parameter of type 'string'.`;
			expect(validateTypecheckOutput(tsError)).toBe(tsError);
		});

		it("should accept empty output (no errors)", () => {
			expect(validateTypecheckOutput("")).toBe("");
			expect(validateTypecheckOutput("  \n  ")).toBe("  \n  ");
		});

		it("should accept plain text error format", () => {
			const plainError = `src/file.ts:10:5 - error TS2322: Type mismatch
Found: string
Required: number`;
			expect(validateTypecheckOutput(plainError)).toBe(plainError);
		});

		it("should accept JSON error format", () => {
			const jsonError = '{"errors": [{"file": "src/file.ts", "line": 10}]}';
			expect(validateTypecheckOutput(jsonError)).toBe(jsonError);
		});

		it("should accept tsc summary output", () => {
			const summary = "Found 5 errors in 3 files.\n\nErrors  Files\n     2  src/file1.ts:10\n     3  src/file2.ts:20";
			expect(validateTypecheckOutput(summary)).toBe(summary);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from("src/file.ts(10,5): error TS2322", "utf-8");
			const result = validateTypecheckOutput(buffer);
			expect(result).toBe("src/file.ts(10,5): error TS2322");
		});
	});

	describe("validateTestOutput", () => {
		it("should accept valid vitest output", () => {
			const vitestOutput = `
 ✓ src/__tests__/file.test.ts (5)
   ✓ should pass test 1
   ✓ should pass test 2

Test Files  1 passed (1)
     Tests  5 passed (5)`;
			expect(validateTestOutput(vitestOutput)).toBe(vitestOutput);
		});

		it("should accept jest output with failures", () => {
			const jestOutput = `FAIL src/__tests__/file.test.ts
  × should fail test 1 (10ms)

Tests: 1 failed, 4 passed, 5 total`;
			expect(validateTestOutput(jestOutput)).toBe(jestOutput);
		});

		it("should accept empty output", () => {
			// Empty output might indicate no tests found - let parsing handle it
			expect(validateTestOutput("")).toBe("");
		});

		it("should throw on truncated output", () => {
			const truncated = "Test running...\noutput truncated due to size";
			expect(() => validateTestOutput(truncated)).toThrow(InvalidInputError);
			expect(() => validateTestOutput(truncated)).toThrow("truncated");
		});

		it("should throw on output with ...truncated... marker", () => {
			const truncated = "Test output\n...truncated...\nmore output";
			expect(() => validateTestOutput(truncated)).toThrow(InvalidInputError);
			expect(() => validateTestOutput(truncated)).toThrow("truncated");
		});

		it("should throw on SIGTERM indicator", () => {
			const terminated = "Running tests...\nSIGTERM received";
			expect(() => validateTestOutput(terminated)).toThrow(InvalidInputError);
			expect(() => validateTestOutput(terminated)).toThrow("truncated or terminated");
		});

		it("should throw on SIGKILL indicator", () => {
			const killed = "Tests running\nSIGKILL\nProcess killed";
			expect(() => validateTestOutput(killed)).toThrow(InvalidInputError);
			expect(() => validateTestOutput(killed)).toThrow("truncated or terminated");
		});

		it("should accept coverage output", () => {
			const coverage = `Test Files  1 passed (1)
     Tests  5 passed (5)
  Coverage  85% statements, 80% branches`;
			expect(validateTestOutput(coverage)).toBe(coverage);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from("Tests: 5 passed", "utf-8");
			const result = validateTestOutput(buffer);
			expect(result).toBe("Tests: 5 passed");
		});

		it("should handle case-insensitive truncation markers", () => {
			const truncated = "Output TRUNCATED here";
			expect(() => validateTestOutput(truncated)).toThrow(InvalidInputError);
		});
	});

	describe("validateLintOutput", () => {
		it("should accept valid Biome lint output", () => {
			const lintOutput = `src/file.ts:10:5 lint/style/useConst
  × This let declaration is never reassigned.
    9 │ function test() {
  > 10 │   let x = 5;
      │   ^^^
   11 │   return x;`;
			expect(validateLintOutput(lintOutput)).toBe(lintOutput);
		});

		it("should accept empty output (no lint issues)", () => {
			expect(validateLintOutput("")).toBe("");
			expect(validateLintOutput("   \n   ")).toBe("   \n   ");
		});

		it("should accept lint summary", () => {
			const summary = "Checked 50 files in 1.2s\nFound 3 errors, 2 warnings";
			expect(validateLintOutput(summary)).toBe(summary);
		});

		it("should accept multiple file lint output", () => {
			const multiFile = `src/file1.ts:10:5 error
src/file2.ts:20:10 warning
src/file3.ts:30:15 error`;
			expect(validateLintOutput(multiFile)).toBe(multiFile);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from("src/file.ts:10:5 lint/style/useConst", "utf-8");
			const result = validateLintOutput(buffer);
			expect(result).toBe("src/file.ts:10:5 lint/style/useConst");
		});
	});

	describe("validateSpellCheckOutput", () => {
		it("should accept valid spell check output", () => {
			const spellOutput = `src/file.ts:10:15: spelling error: "recieve" should be "receive"
src/other.ts:20:5: spelling error: "occured" should be "occurred"`;
			expect(validateSpellCheckOutput(spellOutput)).toBe(spellOutput);
		});

		it("should accept empty output (no spelling errors)", () => {
			expect(validateSpellCheckOutput("")).toBe("");
		});

		it("should accept summary output", () => {
			const summary = "Checked 25 files\nFound 3 spelling errors";
			expect(validateSpellCheckOutput(summary)).toBe(summary);
		});

		it("should convert Buffer input", () => {
			const buffer = Buffer.from('spelling error: "teh" should be "the"', "utf-8");
			const result = validateSpellCheckOutput(buffer);
			expect(result).toBe('spelling error: "teh" should be "the"');
		});
	});

	describe("edge cases and integration", () => {
		it("should handle UTF-8 special characters", () => {
			const utf8Output = "File with émojis: ✓ passed 🎉";
			expect(validateCommandOutput(utf8Output, "test")).toBe(utf8Output);
		});

		it("should handle Windows line endings (CRLF)", () => {
			const crlfOutput = "line1\r\nline2\r\nline3";
			expect(validateCommandOutput(crlfOutput, "test")).toBe(crlfOutput);
		});

		it("should handle mixed line endings", () => {
			const mixedOutput = "line1\nline2\r\nline3\rline4";
			expect(validateCommandOutput(mixedOutput, "test")).toBe(mixedOutput);
		});

		it("should handle output with null bytes", () => {
			const nullBytes = "output\x00with\x00nulls";
			expect(validateCommandOutput(nullBytes, "test")).toBe(nullBytes);
		});

		it("should handle very long single lines", () => {
			const longLine = "x".repeat(50000);
			expect(validateCommandOutput(longLine, "test")).toBe(longLine);
		});

		it("should preserve whitespace in output", () => {
			const whitespace = "  leading\n  trailing  \n\n  empty lines  ";
			expect(validateCommandOutput(whitespace, "test")).toBe(whitespace);
		});
	});
});
