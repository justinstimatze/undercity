import type { Issue } from "./types.js";

/**
 * Issue detectors for code and documentation
 */

export class IssueDetector {
	detectRedundantComments(content: string, _filePath: string): Issue[] {
		const issues: Issue[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			const lineNum = i + 1;

			// Single-line comment
			if (line.startsWith("//")) {
				const comment = line.replace(/^\/\/\s*/, "");
				const nextLine = lines[i + 1]?.trim() || "";

				if (this.isRedundant(comment, nextLine)) {
					issues.push({
						type: "redundant_comment",
						line: lineNum,
						severity: "medium",
						message: "Comment repeats what code says",
						data: { comment, code: nextLine },
					});
				}
			}
		}

		return issues;
	}

	detectUnclearNaming(content: string, _filePath: string): Issue[] {
		const issues: Issue[] = [];
		const lines = content.split("\n");

		// Unclear variable names
		const unclearPatterns = [
			/\b(foo|bar|baz|tmp|temp|data|info|obj|val|item)\b/,
			/\b[a-z]\b/, // Single letter variables
		];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			for (const pattern of unclearPatterns) {
				if (pattern.test(line)) {
					const match = line.match(pattern);
					if (match) {
						issues.push({
							type: "unclear_naming",
							line: lineNum,
							severity: "low",
							message: "Generic/unclear variable name",
							data: { name: match[0] },
						});
					}
				}
			}
		}

		return issues;
	}

	detectLowDensityProse(content: string, _filePath: string): Issue[] {
		const issues: Issue[] = [];
		const lines = content.split("\n");

		let proseStart: number | null = null;
		let proseLines: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			const lineNum = i + 1;

			const isProse =
				line.length > 0 &&
				!line.startsWith("#") &&
				!line.startsWith("```") &&
				!line.startsWith("|") &&
				!line.startsWith("-") &&
				!line.startsWith("*") &&
				!/^\d+\./.test(line);

			if (isProse && !proseStart) {
				proseStart = lineNum;
				proseLines = [line];
			} else if (isProse && proseStart) {
				proseLines.push(line);
			} else if (!isProse && proseStart && proseLines.length >= 3) {
				// Prose block ended, check if it's low density
				const proseText = proseLines.join(" ");
				if (this.isLowDensityProse(proseText)) {
					issues.push({
						type: "low_density",
						startLine: proseStart,
						endLine: lineNum - 1,
						severity: "medium",
						message: "Prose paragraph - consider table or list",
						data: { lineCount: proseLines.length },
					});
				}
				proseStart = null;
				proseLines = [];
			}
		}

		return issues;
	}

	detectDuplicateDefinitions(allFiles: Map<string, string>): Map<string, Issue[]> {
		const definitions = new Map<string, string[]>();
		const issuesByFile = new Map<string, Issue[]>();

		// Extract all type/interface/enum names
		for (const [filePath, content] of allFiles.entries()) {
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				const match = line.match(/^(export\s+)?(interface|type|enum|class)\s+(\w+)/);

				if (match) {
					const name = match[3];
					if (!definitions.has(name)) {
						definitions.set(name, []);
					}
					definitions.get(name)?.push(`${filePath}:${i + 1}`);
				}
			}
		}

		// Find duplicates
		for (const [name, locations] of definitions.entries()) {
			if (locations.length > 1) {
				for (const location of locations) {
					const [filePath, lineStr] = location.split(":");
					const line = Number.parseInt(lineStr, 10);

					if (!issuesByFile.has(filePath)) {
						issuesByFile.set(filePath, []);
					}

					issuesByFile.get(filePath)?.push({
						type: "duplicate_definition",
						line,
						severity: "high",
						message: `Definition of ${name} duplicated`,
						data: {
							name,
							locations: locations.filter((loc) => loc !== location),
						},
					});
				}
			}
		}

		return issuesByFile;
	}

	private isRedundant(comment: string, code: string): boolean {
		const commentWords = comment.toLowerCase().split(/\s+/);
		const codeWords = code.toLowerCase().split(/\s+/);

		// Check if comment just restates code
		const overlap = commentWords.filter((word) => codeWords.includes(word));
		return overlap.length > commentWords.length * 0.6;
	}

	private isLowDensityProse(text: string): boolean {
		// Heuristics for low density:
		// - Long sentences with few concrete facts
		// - Marketing/motivational language
		// - Filler words

		const fillerWords = ["really", "very", "quite", "just", "simply", "easily", "basically"];
		const marketingWords = ["powerful", "robust", "elegant", "beautiful", "amazing"];

		const words = text.toLowerCase().split(/\s+/);
		const fillerCount = words.filter((w) => fillerWords.includes(w)).length;
		const marketingCount = words.filter((w) => marketingWords.includes(w)).length;

		return fillerCount + marketingCount > 2;
	}
}
