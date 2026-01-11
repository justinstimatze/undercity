import { countTokens } from "@anthropic-ai/tokenizer";

/**
 * Token counting utilities
 */

export function countFileTokens(content: string): number {
	return countTokens(content);
}

export function estimateTokensPerLine(content: string): number[] {
	const lines = content.split("\n");
	return lines.map((line) => countTokens(line));
}

export function countTokensInRange(content: string, startLine: number, endLine: number): number {
	const lines = content.split("\n");
	const rangeContent = lines.slice(startLine - 1, endLine).join("\n");
	return countTokens(rangeContent);
}
