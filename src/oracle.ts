import chalk from "chalk";

/**
 * Provides random motivational quotes for Undercity workers
 * to inspire creativity, break problem-solving blocks,
 * and offer fresh perspectives during task execution.
 */

/**
 * Undercity Oracle - A deck of oblique strategy cards for novel insights
 *
 * Philosophy: "It only has to make sense for me" (365 buttons)
 * Cards don't need to be logically defensible, just useful.
 *
 * Use cases:
 * - When stuck on a problem
 * - During reflection phases
 * - Randomly during planning to break patterns
 * - When you need a fresh perspective
 */

export interface OracleCard {
	text: string;
	category: "questioning" | "action" | "perspective" | "disruption" | "exploration";
	loreContext?: string;
}

const ORACLE_DECK: OracleCard[] = [
	// Questioning Cards - Challenge assumptions
	{
		text: "What would fail spectacularly?",
		category: "questioning",
		loreContext: "Example: null input, empty array, concurrent access, network timeout",
	},
	{
		text: "What are you avoiding?",
		category: "questioning",
		loreContext: "Check: error handling, edge cases, tests, documentation, refactoring",
	},
	{
		text: "What would a rival agent exploit?",
		category: "questioning",
		loreContext: "Review: input validation, auth checks, rate limits, injection points",
	},
	{
		text: "What if the opposite were true?",
		category: "questioning",
		loreContext: "Try: if sync→async, if push→pull, if client→server, if required→optional",
	},
	{
		text: "What would you do if you couldn't fail?",
		category: "questioning",
		loreContext: "Consider: rewrite from scratch, use different tech, simplify radically",
	},
	{
		text: "What assumptions are you making?",
		category: "questioning",
		loreContext: "List: input format, execution order, availability, permissions, state",
	},

	// Action Cards - Direct interventions
	{
		text: "Reverse the dependency",
		category: "action",
		loreContext: "Pattern: A calls B → B emits event, A listens. Inversion of control.",
	},
	{
		text: "Honor the accidental pattern",
		category: "action",
		loreContext: "Action: If code accidentally works, understand why before 'fixing' it",
	},
	{
		text: "Start from the end and work backwards",
		category: "action",
		loreContext: "Method: Write the test first. Define output, then figure out input.",
	},
	{
		text: "Remove the most obvious solution",
		category: "action",
		loreContext: "Constraint: No if/else, no loops, no mutation - what's left?",
	},
	{
		text: "Make it smaller, then smaller again",
		category: "action",
		loreContext: "Split: one function → two, one file → module, one task → subtasks",
	},
	{
		text: "Change your time horizon",
		category: "action",
		loreContext: "Shift: what matters for this PR vs this quarter vs this year?",
	},

	// Perspective Cards - Shift viewpoints
	{
		text: "What would this look like to an outsider?",
		category: "perspective",
		loreContext: "Test: Can someone new understand this in 5 minutes? If not, simplify.",
	},
	{
		text: "Pretend you're explaining it to your past self",
		category: "perspective",
		loreContext: "Document: Write the comment you wish existed when you started.",
	},
	{
		text: "What would the system do without human intervention?",
		category: "perspective",
		loreContext: "Default: What happens if config missing? If user absent? If empty?",
	},
	{
		text: "View it as a gift to your future self",
		category: "perspective",
		loreContext: "Quality: Clear names, helpful errors, good tests save future debugging.",
	},
	{
		text: "What would a child notice first?",
		category: "perspective",
		loreContext: "Fresh eyes: The obvious question nobody asks. The weird name. The gap.",
	},
	{
		text: "Zoom out to see the larger pattern",
		category: "perspective",
		loreContext: "Context: This bug in context of system. This task in context of goal.",
	},

	// Disruption Cards - Break patterns
	{
		text: "Introduce controlled chaos",
		category: "disruption",
		loreContext: "Fuzz: Random input, network jitter, concurrent requests, kill -9",
	},
	{
		text: "What's the laziest solution that would work?",
		category: "disruption",
		loreContext: "YAGNI: Hardcode it. Use a library. Copy-paste. Ship and iterate.",
	},
	{
		text: "Combine two unrelated solutions",
		category: "disruption",
		loreContext: "Mashup: Cache + queue, ORM + raw SQL, sync + async in same flow",
	},
	{
		text: "Make the implicit explicit",
		category: "disruption",
		loreContext: "Expose: Hidden config, magic numbers, assumed state, silent failures",
	},
	{
		text: "What rule can you break?",
		category: "disruption",
		loreContext: "Question: DRY, single responsibility, no globals - which helps here?",
	},
	{
		text: "Do the opposite of best practices",
		category: "disruption",
		loreContext: "Heresy: Global state, God object, tight coupling - sometimes right",
	},

	// Exploration Cards - Discover possibilities
	{
		text: "Follow the energy in the room",
		category: "exploration",
		loreContext: "Signal: Which file gets edited most? Which test fails often? Start there.",
	},
	{
		text: "What wants to emerge?",
		category: "exploration",
		loreContext: "Refactor: When you keep adding params, a new abstraction is forming.",
	},
	{
		text: "Look for the pattern that connects everything",
		category: "exploration",
		loreContext: "Abstract: Same shape in 3 places = extract. Same bug twice = systemic.",
	},
	{
		text: "What's the story this problem is trying to tell?",
		category: "exploration",
		loreContext: "Diagnose: Symptom points to cause. Trace the chain of events.",
	},
	{
		text: "Find the edge case that breaks the model",
		category: "exploration",
		loreContext: "Boundary: Zero, one, many. Empty, null, undefined. Min, max, overflow.",
	},
	{
		text: "What would happen if this were easy?",
		category: "exploration",
		loreContext: "Simplify: What if one file? What if no state? What if no network?",
	},

	// Additional unique cards
	{
		text: "What are you optimizing for that you shouldn't be?",
		category: "questioning",
		loreContext: "Metrics: Lines of code, test coverage, performance - are these the goal?",
	},
	{
		text: "Imagine you have infinite resources. Now what?",
		category: "exploration",
		loreContext: "Ideal: Design without constraints first, then add them back strategically.",
	},
	{
		text: "What would you do if this was your only chance?",
		category: "action",
		loreContext: "Focus: Which one change matters most? Do that. Skip the rest.",
	},
	{
		text: "Look for what everyone else is ignoring",
		category: "perspective",
		loreContext: "Blind spots: Logging, monitoring, cleanup, error messages, docs.",
	},
];

export class UndercityOracle {
	private usedCards: Set<number> = new Set();

	/**
	 * Draw a random card from the oracle deck
	 * @param category Optional category filter
	 * @returns A random oracle card
	 */
	drawCard(category?: OracleCard["category"]): OracleCard {
		let availableCards = ORACLE_DECK;

		// Filter by category if specified
		if (category) {
			availableCards = ORACLE_DECK.filter((card) => card.category === category);
		}

		// If all cards have been used, reset the deck
		if (this.usedCards.size >= availableCards.length) {
			this.usedCards.clear();
		}

		// Find unused cards
		const unusedCards = availableCards.filter((_, index) => !this.usedCards.has(index));
		const cardsToChooseFrom = unusedCards.length > 0 ? unusedCards : availableCards;

		// Draw random card
		const randomIndex = Math.floor(Math.random() * cardsToChooseFrom.length);
		const selectedCard = cardsToChooseFrom[randomIndex];

		// Mark as used
		const originalIndex = ORACLE_DECK.indexOf(selectedCard);
		this.usedCards.add(originalIndex);

		return selectedCard;
	}

	/**
	 * Draw multiple cards for broader perspective
	 * @param count Number of cards to draw
	 * @param category Optional category filter
	 * @returns Array of oracle cards
	 */
	drawSpread(count: number = 3, category?: OracleCard["category"]): OracleCard[] {
		const cards: OracleCard[] = [];

		for (let i = 0; i < Math.min(count, ORACLE_DECK.length); i++) {
			const card = this.drawCard(category);
			cards.push(card);
		}

		return cards;
	}

	/**
	 * Get deck statistics
	 */
	getDeckInfo(): { total: number; used: number; remaining: number; categories: string[] } {
		const categories = [...new Set(ORACLE_DECK.map((card) => card.category))];
		return {
			total: ORACLE_DECK.length,
			used: this.usedCards.size,
			remaining: ORACLE_DECK.length - this.usedCards.size,
			categories,
		};
	}

	/**
	 * Reset the deck (all cards become available again)
	 */
	resetDeck(): void {
		this.usedCards.clear();
	}

	/**
	 * Format card for console display
	 */
	formatCard(card: OracleCard): string {
		const categoryColors = {
			questioning: chalk.yellow,
			action: chalk.green,
			perspective: chalk.blue,
			disruption: chalk.red,
			exploration: chalk.magenta,
		};

		const colorFn = categoryColors[card.category] || chalk.white;
		const categoryBadge = colorFn(`[${card.category.toUpperCase()}]`);

		let output = `${categoryBadge} ${chalk.bold.white(card.text)}\n`;

		if (card.loreContext) {
			output += `${chalk.gray(`  ↳ ${card.loreContext}`)}\n`;
		}

		return output;
	}

	/**
	 * Format multiple cards for console display
	 */
	formatSpread(cards: OracleCard[]): string {
		let output = chalk.cyan.bold("🔮 UNDERCITY ORACLE READING 🔮\n");
		output += `${chalk.gray("═".repeat(60))}\n\n`;

		cards.forEach((card, index) => {
			output += chalk.gray(`Card ${index + 1}:\n`);
			output += this.formatCard(card);
			output += "\n";
		});

		return output;
	}
}

/**
 * Get oracle advice for common situations
 */
export const ORACLE_SITUATIONS = {
	stuck: () => "You're stuck on a problem",
	planning: () => "You're planning your approach",
	reflecting: () => "You're reflecting on progress",
	debugging: () => "You're debugging an issue",
	deciding: () => "You're making a decision",
	random: () => "You need random inspiration",
} as const;

export type OracleSituation = keyof typeof ORACLE_SITUATIONS;
