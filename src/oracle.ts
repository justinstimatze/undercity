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
		loreContext: "Scout's wisdom: 'Know your breaking points before the enemy does.'",
	},
	{
		text: "What are you avoiding?",
		category: "questioning",
		loreContext: "Survivor's truth: 'The path you don't take might be the one that leads home.'",
	},
	{
		text: "What would a rival agent exploit?",
		category: "questioning",
		loreContext: "Radio chatter: 'Think like the competition. They're thinking about you.'",
	},
	{
		text: "What if the opposite were true?",
		category: "questioning",
		loreContext: "Undercity paradox: 'Sometimes you dig up to find the way down.'",
	},
	{
		text: "What would you do if you couldn't fail?",
		category: "questioning",
		loreContext: "Raider's courage: 'Fear is just intel telling you where the treasure is.'",
	},
	{
		text: "What assumptions are you making?",
		category: "questioning",
		loreContext: "Old survivor saying: 'Assumptions are just lies we tell ourselves about tomorrow.'",
	},

	// Action Cards - Direct interventions
	{
		text: "Reverse the dependency",
		category: "action",
		loreContext: "Engineer's insight: 'When the system breaks, rebuild it backwards.'",
	},
	{
		text: "Honor the accidental pattern",
		category: "action",
		loreContext: "Scavenger wisdom: 'The best finds are the ones you weren't looking for.'",
	},
	{
		text: "Start from the end and work backwards",
		category: "action",
		loreContext: "Navigator's method: 'Plot your exit before you enter the ruins.'",
	},
	{
		text: "Remove the most obvious solution",
		category: "action",
		loreContext: "Raider's cunning: 'The obvious path is where the traps are waiting.'",
	},
	{
		text: "Make it smaller, then smaller again",
		category: "action",
		loreContext: "Undercity rule: 'Big problems fit through small cracks.'",
	},
	{
		text: "Change your time horizon",
		category: "action",
		loreContext: "Temporal scout: 'What matters in an hour vs. what matters in a year.'",
	},

	// Perspective Cards - Shift viewpoints
	{
		text: "What would this look like to an outsider?",
		category: "perspective",
		loreContext: "Surface dweller's view: 'They see what we can't, because they've never been here.'",
	},
	{
		text: "Pretend you're explaining it to your past self",
		category: "perspective",
		loreContext: "Memory keeper's trick: 'The you from before knew things the you now forgot.'",
	},
	{
		text: "What would the system do without human intervention?",
		category: "perspective",
		loreContext: "Machine whisperer: 'Code wants to be simple. Humans make it complicated.'",
	},
	{
		text: "View it as a gift to your future self",
		category: "perspective",
		loreContext: "Long-game thinking: 'Today's pain is tomorrow's power-up.'",
	},
	{
		text: "What would a child notice first?",
		category: "perspective",
		loreContext: "Young survivor's clarity: 'Kids see the world before the rules teach them not to.'",
	},
	{
		text: "Zoom out to see the larger pattern",
		category: "perspective",
		loreContext: "Cartographer's vision: 'The path only makes sense from above.'",
	},

	// Disruption Cards - Break patterns
	{
		text: "Introduce controlled chaos",
		category: "disruption",
		loreContext: "Saboteur's principle: 'Sometimes you have to break it to understand it.'",
	},
	{
		text: "What's the laziest solution that would work?",
		category: "disruption",
		loreContext: "Efficient raider: 'Energy is currency. Spend it wisely.'",
	},
	{
		text: "Combine two unrelated solutions",
		category: "disruption",
		loreContext: "Hybrid inventor: 'The best salvage comes from mixing incompatible parts.'",
	},
	{
		text: "Make the implicit explicit",
		category: "disruption",
		loreContext: "Truth seeker: 'The danger is in what nobody talks about.'",
	},
	{
		text: "What rule can you break?",
		category: "disruption",
		loreContext: "Rebel's code: 'Rules are just suggestions from people who got there first.'",
	},
	{
		text: "Do the opposite of best practices",
		category: "disruption",
		loreContext: "Heretic's wisdom: 'Best practices are just yesterday's experiments.'",
	},

	// Exploration Cards - Discover possibilities
	{
		text: "Follow the energy in the room",
		category: "exploration",
		loreContext: "Empath navigator: 'People's excitement points to hidden treasure.'",
	},
	{
		text: "What wants to emerge?",
		category: "exploration",
		loreContext: "Oracle's question: 'Listen for what's trying to be born.'",
	},
	{
		text: "Look for the pattern that connects everything",
		category: "exploration",
		loreContext: "System mystic: 'All raids are the same raid. All code is the same code.'",
	},
	{
		text: "What's the story this problem is trying to tell?",
		category: "exploration",
		loreContext: "Lore keeper: 'Every bug is a message from the machine spirits.'",
	},
	{
		text: "Find the edge case that breaks the model",
		category: "exploration",
		loreContext: "Boundary rider: 'The real world lives in the exceptions.'",
	},
	{
		text: "What would happen if this were easy?",
		category: "exploration",
		loreContext: "Simplicity seeker: 'Hard problems often have embarrassingly simple solutions.'",
	},

	// Additional unique cards
	{
		text: "What are you optimizing for that you shouldn't be?",
		category: "questioning",
		loreContext: "Meta-raider insight: 'Sometimes the score you're chasing isn't worth winning.'",
	},
	{
		text: "Imagine you have infinite resources. Now what?",
		category: "exploration",
		loreContext: "Resource abundance thought: 'Constraints shape creativity. Remove them and see what emerges.'",
	},
	{
		text: "What would you do if this was your only chance?",
		category: "action",
		loreContext: "Final run mentality: 'When the stakes are highest, the vision becomes clearest.'",
	},
	{
		text: "Look for what everyone else is ignoring",
		category: "perspective",
		loreContext: "Contrarian's edge: 'The obvious answers are already taken. Find the ignored ones.'",
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
