export { SemanticAnalyzer } from "./analyzer.js";
export { printMachineReport, runSemanticCheck } from "./cli.js";
export { SemanticFixer } from "./fixer.js";
export type {
	Action,
	FileAnalysis,
	GlobalMetrics,
	Issue,
	Redundancy,
	SemanticReport,
} from "./types.js";
