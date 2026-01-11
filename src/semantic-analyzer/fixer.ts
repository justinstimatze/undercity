import { readFileSync, writeFileSync } from "node:fs";
import type { Action, SemanticReport } from "./types.js";

/**
 * Auto-fix semantic issues
 */

export class SemanticFixer {
	applyFixes(report: SemanticReport, rootDir: string): void {
		const actionsByFile = new Map<string, Action[]>();

		// Group actions by file
		for (const action of report.actions) {
			if (!actionsByFile.has(action.file)) {
				actionsByFile.set(action.file, []);
			}
			actionsByFile.get(action.file)?.push(action);
		}

		// Apply fixes file by file
		for (const [filePath, actions] of actionsByFile.entries()) {
			this.applyFileActions(filePath, actions, rootDir);
		}
	}

	private applyFileActions(filePath: string, actions: Action[], rootDir: string): void {
		const fullPath = `${rootDir}/${filePath}`;
		let content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");

		// Sort actions by priority and type
		const sortedActions = actions.sort((a, b) => {
			const priorityOrder = { high: 0, medium: 1, low: 2 };
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		});

		// Collect all lines to remove
		const linesToRemove = new Set<number>();

		for (const action of sortedActions) {
			switch (action.type) {
				case "remove_lines": {
					const actionLines = action.data.lines as number[];
					for (const line of actionLines) {
						linesToRemove.add(line);
					}
					break;
				}

				case "rename_symbol": {
					// Simple find-replace for now
					const oldName = action.data.current as string;
					const newName = action.data.new as string;
					if (oldName && newName) {
						content = content.replace(new RegExp(`\\b${oldName}\\b`, "g"), newName);
					}
					break;
				}
			}
		}

		// Remove lines (from end to beginning to preserve line numbers)
		if (linesToRemove.size > 0) {
			const filteredLines = lines.filter((_, index) => !linesToRemove.has(index + 1));
			content = filteredLines.join("\n");
		}

		// Write back
		writeFileSync(fullPath, content, "utf-8");

		console.log(`Fixed: ${filePath} (${actions.length} actions applied)`);
	}
}
