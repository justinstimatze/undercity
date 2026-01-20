/**
 * Docker-style Name Generator
 *
 * Generates memorable names for workers and branches in the format "adjective-animal".
 * Inspired by Docker's container naming and dlorenc/multiclaude.
 *
 * Benefits:
 * - Human-readable identifiers for workers
 * - Easier to reference in logs and conversation
 * - Adds character to the orchestration system
 */

const ADJECTIVES = [
	// Positive traits
	"happy",
	"clever",
	"brave",
	"calm",
	"eager",
	"fancy",
	"gentle",
	"jolly",
	"kind",
	"lively",
	"nice",
	"proud",
	"silly",
	"witty",
	"zealous",
	"bright",
	"swift",
	"bold",
	"cool",
	"wise",
	// Technical vibes
	"async",
	"atomic",
	"cached",
	"cosmic",
	"crypto",
	"cyber",
	"digital",
	"dynamic",
	"elastic",
	"fuzzy",
	"hyper",
	"lambda",
	"neural",
	"quantum",
	"stealth",
	"turbo",
	"vector",
	"vivid",
	"wired",
	"zen",
];

const ANIMALS = [
	// Classic Docker animals
	"platypus",
	"elephant",
	"dolphin",
	"penguin",
	"koala",
	"otter",
	"panda",
	"tiger",
	"lion",
	"bear",
	"fox",
	"wolf",
	"eagle",
	"hawk",
	"owl",
	"deer",
	"rabbit",
	"squirrel",
	"badger",
	"raccoon",
	// Underground/nocturnal (fitting the "undercity" theme)
	"mole",
	"bat",
	"ferret",
	"hedgehog",
	"opossum",
	"armadillo",
	"pangolin",
	"aardvark",
	"wombat",
	"mongoose",
	// Mythical (for epic tasks)
	"phoenix",
	"dragon",
	"griffin",
	"chimera",
	"hydra",
	"kraken",
	"leviathan",
	"manticore",
	"basilisk",
	"unicorn",
];

/**
 * Generate a random Docker-style name (adjective-animal)
 */
export function generateWorkerName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
	return `${adj}-${animal}`;
}

/**
 * Generate a deterministic name from a task ID or hash
 * Same input always produces same name (for crash recovery)
 */
export function nameFromId(id: string): string {
	// Simple hash function for deterministic selection
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		const char = id.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32-bit integer
	}

	const adjIndex = Math.abs(hash) % ADJECTIVES.length;
	const animalIndex = Math.abs(hash >> 8) % ANIMALS.length;

	return `${ADJECTIVES[adjIndex]}-${ANIMALS[animalIndex]}`;
}

/**
 * Parse worker name from branch name
 * e.g., "undercity/swift-fox/task-abc123" -> "swift-fox"
 */
export function parseWorkerNameFromBranch(branch: string): string | null {
	const match = branch.match(/^undercity\/([a-z]+-[a-z]+)\//);
	return match ? match[1] : null;
}

/**
 * Generate branch name with worker name
 * Format: undercity/{worker-name}/task-{taskId}
 */
export function generateBranchName(taskId: string): string {
	const workerName = nameFromId(taskId);
	return `undercity/${workerName}/${taskId}`;
}

/**
 * Get just the worker name portion for display
 */
export function getWorkerDisplayName(taskId: string): string {
	return nameFromId(taskId);
}
