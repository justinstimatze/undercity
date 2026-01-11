import type { Fact, FactType } from "./types.js";

/**
 * Extract facts from code and documentation
 * Facts are atomic, actionable pieces of information
 */

export class FactExtractor {
	extractFromTypeScript(content: string, filePath: string): Fact[] {
		const facts: Fact[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Type definitions
			if (/^(export\s+)?(interface|type|enum|class)\s+\w+/.test(line.trim())) {
				facts.push({
					type: "type_definition",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Function signatures
			if (
				/^(export\s+)?(async\s+)?function\s+\w+/.test(line.trim()) ||
				/^\s*(public|private|protected)?\s*\w+\s*\([^)]*\)\s*:/.test(line.trim())
			) {
				facts.push({
					type: "function_signature",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Constants
			if (/^(export\s+)?const\s+[A-Z_]+\s*=/.test(line.trim())) {
				facts.push({
					type: "constant",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Enum values
			if (/^\s*\w+\s*=/.test(line.trim()) && this.isInsideEnum(lines, i)) {
				facts.push({
					type: "enum_value",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}
		}

		return facts;
	}

	extractFromMarkdown(content: string, filePath: string): Fact[] {
		const facts: Fact[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Commands (code blocks or backtick-wrapped)
			if (/```(?:bash|sh|zsh)/.test(line) || /`[a-z-]+`/.test(line)) {
				facts.push({
					type: "command",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Table rows (contains pipes)
			if (/^\|.*\|.*\|/.test(line.trim()) && !line.includes("---")) {
				facts.push({
					type: "table_row",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Mappings (file → purpose, X → Y)
			if (/→|->|:/.test(line) && /^\s*[-*]\s*/.test(line)) {
				facts.push({
					type: "mapping",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Decision branches (if/when/use this)
			if (
				/^[-*]\s*(if|when|use|for|skip|avoid)/i.test(line.trim()) ||
				/^\d+\.\s*(if|when|use|for|skip|avoid)/i.test(line.trim())
			) {
				facts.push({
					type: "decision_branch",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}

			// Constraints (must, never, always, critical)
			if (/(must|never|always|critical|required|forbidden)/i.test(line) && line.trim().length < 200) {
				facts.push({
					type: "constraint",
					value: line.trim(),
					location: `${filePath}:${lineNum}`,
					line: lineNum,
				});
			}
		}

		return facts;
	}

	extractFromJSON(content: string, filePath: string): Fact[] {
		const facts: Fact[] = [];

		try {
			const data = JSON.parse(content);
			this.extractFromObject(data, filePath, facts);
		} catch {
			// Invalid JSON, skip
		}

		return facts;
	}

	private extractFromObject(obj: unknown, filePath: string, facts: Fact[], path = ""): void {
		if (typeof obj !== "object" || obj === null) return;

		for (const [key, value] of Object.entries(obj)) {
			const fullPath = path ? `${path}.${key}` : key;

			if (typeof value === "string" || typeof value === "number") {
				facts.push({
					type: "config_value",
					value: `${fullPath} = ${value}`,
					location: `${filePath}:${fullPath}`,
					line: 0,
				});
			} else if (typeof value === "object" && value !== null) {
				this.extractFromObject(value, filePath, facts, fullPath);
			}
		}
	}

	private isInsideEnum(lines: string[], currentIndex: number): boolean {
		// Look backwards for enum declaration
		for (let i = currentIndex; i >= 0; i--) {
			if (/enum\s+\w+\s*{/.test(lines[i])) return true;
			if (lines[i].includes("}")) return false;
		}
		return false;
	}
}
