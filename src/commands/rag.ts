/**
 * RAG Commands
 *
 * | Command      | Purpose                                      |
 * |--------------|----------------------------------------------|
 * | rag index    | Index a file or directory                    |
 * | rag search   | Search the RAG index                         |
 * | rag list     | List indexed documents                       |
 * | rag stats    | Show RAG index statistics                    |
 * | rag remove   | Remove a document from the index             |
 */

import { error, header, info, keyValue, list, section, success } from "../output.js";
import { getRAGEngine } from "../rag/index.js";
import type { CommandModule } from "./types.js";

// =============================================================================
// Option Types
// =============================================================================

interface IndexOptions {
	source?: string;
	recursive?: boolean;
}

interface SearchOptions {
	limit?: string;
	source?: string;
	vectorWeight?: string;
	ftsWeight?: string;
}

interface ListOptions {
	source?: string;
}

// =============================================================================
// Handlers
// =============================================================================

async function handleIndex(path: string, options: IndexOptions): Promise<void> {
	const source = options.source ?? "default";
	const recursive = options.recursive ?? false;

	info(`Indexing ${path}...`);

	try {
		const engine = getRAGEngine();
		const results = await engine.indexFile({
			filePath: path,
			source,
			recursive,
		});

		const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);
		const totalTokens = results.reduce((sum, r) => sum + r.tokensIndexed, 0);

		if (totalChunks === 0) {
			info("No new content indexed (files may already be indexed or unsupported)");
		} else {
			success(`Indexed ${results.length} file(s): ${totalChunks} chunks, ${totalTokens} tokens`);
		}
	} catch (err) {
		error(`Failed to index: ${String(err)}`);
		process.exit(1);
	}
}

async function handleSearch(query: string, options: SearchOptions): Promise<void> {
	const limit = options.limit ? Number.parseInt(options.limit, 10) : 10;
	const sources = options.source ? options.source.split(",").map((s) => s.trim()) : undefined;
	const vectorWeight = options.vectorWeight ? Number.parseFloat(options.vectorWeight) : 0.7;
	const ftsWeight = options.ftsWeight ? Number.parseFloat(options.ftsWeight) : 0.3;

	try {
		const engine = getRAGEngine();
		const results = await engine.search(query, {
			limit,
			sources,
			vectorWeight,
			ftsWeight,
		});

		if (results.length === 0) {
			info("No results found");
			return;
		}

		header(`Search Results (${results.length})`);

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			section(`${i + 1}. [${result.document.source}] ${result.document.title}`);
			keyValue("Score", result.score.toFixed(4));
			if (result.vectorScore !== undefined) {
				keyValue("Vector", result.vectorScore.toFixed(4));
			}
			if (result.ftsScore !== undefined) {
				keyValue("FTS", result.ftsScore.toFixed(4));
			}
			info("");
			// Show truncated content
			const preview =
				result.chunk.content.length > 300 ? `${result.chunk.content.substring(0, 300)}...` : result.chunk.content;
			info(preview);
			info("");
		}
	} catch (err) {
		error(`Search failed: ${String(err)}`);
		process.exit(1);
	}
}

function handleList(options: ListOptions): void {
	try {
		const engine = getRAGEngine();
		const documents = engine.getDocuments(options.source);

		if (documents.length === 0) {
			info("No documents indexed");
			return;
		}

		header(`Indexed Documents (${documents.length})`);

		const items = documents.map((doc) => {
			const path = doc.filePath ? ` (${doc.filePath})` : "";
			const date = doc.indexedAt ? doc.indexedAt.toISOString().split("T")[0] : "unknown";
			return `[${doc.source}] ${doc.title}${path} - ${date} - ${doc.id}`;
		});

		list(items);
	} catch (err) {
		error(`Failed to list documents: ${String(err)}`);
		process.exit(1);
	}
}

function handleStats(): void {
	try {
		const engine = getRAGEngine();
		const stats = engine.getStats();

		header("RAG Index Statistics");
		keyValue("Documents", stats.documentCount.toString());
		keyValue("Chunks", stats.chunkCount.toString());
		keyValue("Embedding Dimensions", stats.embeddingDimensions.toString());

		if (stats.sources.length > 0) {
			section("Sources");
			for (const source of stats.sources) {
				info(`  ${source.source}: ${source.documentCount} docs, ${source.chunkCount} chunks`);
			}
		}
	} catch (err) {
		error(`Failed to get stats: ${String(err)}`);
		process.exit(1);
	}
}

function handleRemove(documentId: string): void {
	try {
		const engine = getRAGEngine();
		const removed = engine.removeDocument(documentId);

		if (removed) {
			success(`Removed document: ${documentId}`);
		} else {
			error(`Document not found: ${documentId}`);
			process.exit(1);
		}
	} catch (err) {
		error(`Failed to remove document: ${String(err)}`);
		process.exit(1);
	}
}

// =============================================================================
// Command Module
// =============================================================================

export const ragCommands: CommandModule = {
	register(program) {
		const rag = program.command("rag").description("Manage the RAG (Retrieval-Augmented Generation) index");

		rag
			.command("index <path>")
			.description("Index a file or directory")
			.option("-s, --source <name>", "Source name for categorization", "default")
			.option("-r, --recursive", "Index directories recursively")
			.action((path: string, options: IndexOptions) => handleIndex(path, options));

		rag
			.command("search <query>")
			.description("Search the RAG index")
			.option("-l, --limit <n>", "Maximum results", "10")
			.option("-s, --source <sources>", "Filter by source(s), comma-separated")
			.option("--vector-weight <n>", "Weight for vector search (0-1)", "0.7")
			.option("--fts-weight <n>", "Weight for FTS search (0-1)", "0.3")
			.action((query: string, options: SearchOptions) => handleSearch(query, options));

		rag
			.command("list")
			.description("List indexed documents")
			.option("-s, --source <name>", "Filter by source")
			.action((options: ListOptions) => handleList(options));

		rag
			.command("stats")
			.description("Show RAG index statistics")
			.action(() => handleStats());

		rag
			.command("remove <documentId>")
			.description("Remove a document from the index")
			.action((documentId: string) => handleRemove(documentId));
	},
};
