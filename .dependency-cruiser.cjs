/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-cli-from-execution",
			comment:
				"Execution layer (worker/, orchestrator/) must not import from CLI commands/. " +
				"Commands depend on execution, not the reverse.",
			severity: "error",
			from: {
				path: ["^src/worker", "^src/orchestrator"],
			},
			to: {
				path: "^src/commands/",
			},
		},
		{
			name: "no-execution-from-learning",
			comment:
				"Learning systems (knowledge, patterns, ledger, decisions) must not import " +
				"from execution layer. Learning is consumed by execution, not coupled to it.",
			severity: "error",
			from: {
				path: [
					"^src/knowledge\\.ts$",
					"^src/task-file-patterns\\.ts$",
					"^src/error-fix-patterns\\.ts$",
					"^src/capability-ledger\\.ts$",
					"^src/decision-tracker\\.ts$",
				],
			},
			to: {
				path: ["^src/worker", "^src/orchestrator"],
			},
		},
		{
			name: "rag-isolation",
			comment:
				"RAG module only imports from infrastructure (logger, types, config, storage, concurrency). " +
				"No imports from execution, CLI, or learning layers.",
			severity: "error",
			from: {
				path: "^src/rag/",
			},
			to: {
				path: "^src/",
				pathNot: [
					"^src/rag/",
					"^src/logger\\.ts$",
					"^src/types\\.ts$",
					"^src/config\\.ts$",
					"^src/storage\\.ts$",
					"^src/concurrency\\.ts$",
				],
			},
		},
		{
			name: "storage-isolation",
			comment:
				"Storage/persistence layer must not import from execution layer. " +
				"Execution depends on storage, not the reverse.",
			severity: "error",
			from: {
				path: [
					"^src/storage\\.ts$",
					"^src/task\\.ts$",
					"^src/persistence\\.ts$",
				],
			},
			to: {
				path: ["^src/worker", "^src/orchestrator"],
			},
		},
		{
			name: "no-circular",
			comment:
				"No circular dependency chains allowed. Warning-only until existing cycles " +
				"(worker<->verification-handler, types<->complexity, etc.) are resolved.",
			severity: "warn",
			from: {},
			to: {
				circular: true,
			},
		},
	],
	options: {
		doNotFollow: {
			path: "node_modules",
		},
		tsPreCompilationDeps: true,
		tsConfig: {
			fileName: "tsconfig.json",
		},
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
			mainFields: ["module", "main", "types", "typings"],
		},
		reporterOptions: {
			text: {
				highlightFocused: true,
			},
		},
	},
};
