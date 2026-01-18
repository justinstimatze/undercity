/**
 * Annealing Review System
 *
 * Temperature-based code review using Tarot-inspired archetypes.
 *
 * | Phase     | Temperature | Source       | Focus                    |
 * |-----------|-------------|--------------|--------------------------|
 * | Hot       | >0.6        | Major Arcana | Wild, radical exploration|
 * | Cooling   | 0.3-0.6     | Both         | Balanced perspectives    |
 * | Cold      | <0.3        | Minor Arcana | Focused refinement       |
 */

import { UndercityOracle } from "./oracle.js";

interface MajorArcanaCard {
	name: string;
	archetype: string;
	reviewPrompt: string;
	temperature: "high" | "medium";
}

interface MinorArcanaCard {
	suit: "wands" | "cups" | "swords" | "pentacles";
	rank: string;
	domain: string;
	reviewPrompt: string;
}

export interface ReviewPass {
	temperature: number;
	card: MajorArcanaCard | MinorArcanaCard;
	isMajor: boolean;
	prompt: string;
}

export interface AnnealingConfig {
	initialTemperature?: number;
	coolingRate?: number;
	minTemperature?: number;
	passesPerTemperature?: number;
}

const MAJOR_ARCANA: MajorArcanaCard[] = [
	{
		name: "The Fool",
		archetype: "Beginner's Mind",
		reviewPrompt:
			"Review this as if you've never seen code before. What's confusing? What requires tribal knowledge? What would trip up someone on day one?",
		temperature: "high",
	},
	{
		name: "The Magician",
		archetype: "Hidden Power",
		reviewPrompt:
			"What latent capabilities exist here that aren't being used? What could this code do with minor changes? Where's the untapped potential?",
		temperature: "high",
	},
	{
		name: "The High Priestess",
		archetype: "Hidden Knowledge",
		reviewPrompt:
			"What does this code know that it's not saying? What assumptions are buried? What would the code tell you if it could speak?",
		temperature: "high",
	},
	{
		name: "The Empress",
		archetype: "Growth & Nurture",
		reviewPrompt:
			"How will this code grow? What will it need to sustain itself? Where are the seeds of future complexity?",
		temperature: "high",
	},
	{
		name: "The Emperor",
		archetype: "Structure & Authority",
		reviewPrompt:
			"What are the power structures here? Who/what controls the flow? Is the hierarchy appropriate or oppressive?",
		temperature: "medium",
	},
	{
		name: "The Hierophant",
		archetype: "Convention & Tradition",
		reviewPrompt:
			"What conventions is this following? Breaking? Should it? What would the maintainers of the framework think?",
		temperature: "medium",
	},
	{
		name: "The Lovers",
		archetype: "Union & Choice",
		reviewPrompt:
			"What couplings exist? Are they healthy? What choices were made here and what alternatives were rejected?",
		temperature: "medium",
	},
	{
		name: "The Chariot",
		archetype: "Will & Direction",
		reviewPrompt:
			"Where is this code trying to go? Is it moving efficiently toward that goal? What's pulling in different directions?",
		temperature: "medium",
	},
	{
		name: "Strength",
		archetype: "Gentle Power",
		reviewPrompt:
			"Where does this code show restraint? Where does it overreach? Is it using the minimum force necessary?",
		temperature: "medium",
	},
	{
		name: "The Hermit",
		archetype: "Solitude & Reflection",
		reviewPrompt:
			"What would happen if this code had to run alone, with no dependencies? What does it truly need vs want?",
		temperature: "high",
	},
	{
		name: "Wheel of Fortune",
		archetype: "Cycles & Change",
		reviewPrompt: "What cycles will this code go through? What's the lifecycle? Where are the points of change?",
		temperature: "medium",
	},
	{
		name: "Justice",
		archetype: "Balance & Fairness",
		reviewPrompt: "Is this code fair to all its callers? Does it give back what it takes? Is the contract balanced?",
		temperature: "medium",
	},
	{
		name: "The Hanged Man",
		archetype: "Suspension & Sacrifice",
		reviewPrompt:
			"What if we did nothing here? What's being sacrificed for this implementation? Flip it upside down - what do you see?",
		temperature: "high",
	},
	{
		name: "Death",
		archetype: "Endings & Transformation",
		reviewPrompt:
			"What needs to die here? What's being held onto that should be released? Where's the dead code walking?",
		temperature: "high",
	},
	{
		name: "Temperance",
		archetype: "Balance & Moderation",
		reviewPrompt: "Where is excess? Where is deficiency? What needs to be blended more carefully?",
		temperature: "medium",
	},
	{
		name: "The Devil",
		archetype: "Shadow & Bondage",
		reviewPrompt: "What's the shadow of this code? What unhealthy attachments exist? What feels like a trap?",
		temperature: "high",
	},
	{
		name: "The Tower",
		archetype: "Sudden Change & Revelation",
		reviewPrompt: "What would catastrophically break this? What false structures exist? What needs to be torn down?",
		temperature: "high",
	},
	{
		name: "The Star",
		archetype: "Hope & Inspiration",
		reviewPrompt: "What's the aspiration here? What would the ideal version look like? Where's the guiding light?",
		temperature: "medium",
	},
	{
		name: "The Moon",
		archetype: "Illusion & Intuition",
		reviewPrompt: "What's not as it seems? Where might you be deceived? What does your gut say that logic doesn't?",
		temperature: "high",
	},
	{
		name: "The Sun",
		archetype: "Clarity & Success",
		reviewPrompt: "What's working brilliantly here? What should be celebrated and preserved? Where's the light?",
		temperature: "medium",
	},
	{
		name: "Judgement",
		archetype: "Evaluation & Rebirth",
		reviewPrompt:
			"If this code were judged by future maintainers, what verdict would they give? What needs resurrection?",
		temperature: "medium",
	},
	{
		name: "The World",
		archetype: "Completion & Integration",
		reviewPrompt: "Is this complete? What's the whole picture? How does this integrate with everything else?",
		temperature: "medium",
	},
];

const MINOR_ARCANA: MinorArcanaCard[] = [
	// WANDS - Energy, Action, Performance
	{
		suit: "wands",
		rank: "Ace",
		domain: "Performance Potential",
		reviewPrompt: "Where's the performance opportunity? What could be faster?",
	},
	{
		suit: "wands",
		rank: "King",
		domain: "Performance Mastery",
		reviewPrompt: "Is this optimized appropriately? Over-optimized? Under?",
	},
	{
		suit: "wands",
		rank: "Knight",
		domain: "Execution Speed",
		reviewPrompt: "Hot paths? Cold paths? Is effort allocated correctly?",
	},
	// CUPS - Emotion, Relationships, UX
	{
		suit: "cups",
		rank: "Ace",
		domain: "User Experience",
		reviewPrompt: "How will users feel using this? Joy? Frustration? Confusion?",
	},
	{
		suit: "cups",
		rank: "King",
		domain: "Developer Experience",
		reviewPrompt: "How will developers feel maintaining this? Is it kind to them?",
	},
	{
		suit: "cups",
		rank: "Knight",
		domain: "API Ergonomics",
		reviewPrompt: "Is this API pleasant to use? Intuitive? Frustrating?",
	},
	// SWORDS - Intellect, Logic, Security
	{
		suit: "swords",
		rank: "Ace",
		domain: "Security Basics",
		reviewPrompt: "OWASP top 10? Injection? Auth bypass? Input validation?",
	},
	{
		suit: "swords",
		rank: "King",
		domain: "Security Architecture",
		reviewPrompt: "Trust boundaries? Privilege escalation? Defense in depth?",
	},
	{
		suit: "swords",
		rank: "Knight",
		domain: "Logic Correctness",
		reviewPrompt: "Edge cases? Off-by-one? Null handling? Race conditions?",
	},
	{
		suit: "swords",
		rank: "Queen",
		domain: "Type Safety",
		reviewPrompt: "Type narrowing? Any types? Runtime type assertions?",
	},
	// PENTACLES - Material, Practical, Infrastructure
	{
		suit: "pentacles",
		rank: "Ace",
		domain: "Reliability",
		reviewPrompt: "Error handling? Recovery? Graceful degradation?",
	},
	{
		suit: "pentacles",
		rank: "King",
		domain: "Maintainability",
		reviewPrompt: "Will future you understand this? In 6 months? 2 years?",
	},
	{
		suit: "pentacles",
		rank: "Knight",
		domain: "Testability",
		reviewPrompt: "Can this be tested? Easily? Are tests missing?",
	},
	{
		suit: "pentacles",
		rank: "Queen",
		domain: "Observability",
		reviewPrompt: "Can you tell what's happening? Logs? Metrics? Traces?",
	},
];

const DEFAULT_CONFIG: Required<AnnealingConfig> = {
	initialTemperature: 1.0,
	coolingRate: 0.25,
	minTemperature: 0.15,
	passesPerTemperature: 1,
};

/**
 * Annealing Review: Temperature-based code review system
 *
 * Features:
 * - Progressive refinement via temperature-controlled passes
 * - Diverse perspectives from Tarot-inspired archetypes
 * - Customizable review configurations
 * - Multi-lens analytical coverage
 */
export class AnnealingReview {
	/**
	 * Temperature Control System
	 *
	 * | Range   | Perspective | Source       | Purpose |
	 * |---------|-------------|--------------|---------|
	 * | >0.6    | Broad       | Major Arcana | Radical exploration |
	 * | 0.3-0.6 | Mixed       | Both         | Balanced exploration |
	 * | <0.3    | Focused     | Minor Arcana | Refined insights |
	 *
	 * Simulated annealing analogy: High temp = exploration, Low temp = convergence
	 */
	private oracle: UndercityOracle;
	private config: Required<AnnealingConfig>;
	private usedMajor: Set<string> = new Set();
	private usedMinor: Set<string> = new Set();

	constructor(config: AnnealingConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.oracle = new UndercityOracle();
	}

	/**
	 * Generate a full annealing review schedule
	 */
	generateSchedule(): ReviewPass[] {
		const passes: ReviewPass[] = [];
		let temperature = this.config.initialTemperature;

		while (temperature >= this.config.minTemperature) {
			for (let i = 0; i < this.config.passesPerTemperature; i++) {
				const pass = this.drawForTemperature(temperature);
				passes.push(pass);
			}
			temperature *= 1 - this.config.coolingRate;
		}

		// Final focused pass
		passes.push(this.drawForTemperature(this.config.minTemperature));

		return passes;
	}

	/**
	 * Draw a single card appropriate for the temperature
	 */
	drawForTemperature(temperature: number): ReviewPass {
		// High temp (>0.6): Favor Major Arcana
		// Medium temp (0.3-0.6): Mix
		// Low temp (<0.3): Favor Minor Arcana
		const useMajor = temperature > 0.5 || (temperature > 0.25 && Math.random() < 0.4);

		if (useMajor) {
			const card = this.drawMajor(temperature);
			return {
				temperature,
				card,
				isMajor: true,
				prompt: card.reviewPrompt,
			};
		}

		const card = this.drawMinor();
		return {
			temperature,
			card,
			isMajor: false,
			prompt: card.reviewPrompt,
		};
	}

	/**
	 * Draw a Major Arcana card
	 */
	private drawMajor(temperature: number): MajorArcanaCard {
		// At high temps, prefer high-temp arcana
		const candidates = MAJOR_ARCANA.filter((card) => {
			if (this.usedMajor.has(card.name)) return false;
			if (temperature > 0.6) return card.temperature === "high";
			return true;
		});

		// If all used, reset and pick any
		if (candidates.length === 0) {
			this.usedMajor.clear();
			return MAJOR_ARCANA[Math.floor(Math.random() * MAJOR_ARCANA.length)];
		}

		const card = candidates[Math.floor(Math.random() * candidates.length)];
		this.usedMajor.add(card.name);
		return card;
	}

	/**
	 * Draw a Minor Arcana card
	 */
	private drawMinor(): MinorArcanaCard {
		const candidates = MINOR_ARCANA.filter((card) => !this.usedMinor.has(`${card.suit}-${card.rank}`));

		if (candidates.length === 0) {
			this.usedMinor.clear();
			return MINOR_ARCANA[Math.floor(Math.random() * MINOR_ARCANA.length)];
		}

		const card = candidates[Math.floor(Math.random() * candidates.length)];
		this.usedMinor.add(`${card.suit}-${card.rank}`);
		return card;
	}

	/**
	 * Draw a single card for quick review
	 */
	drawSingle(preferMajor = true): ReviewPass {
		const temperature = preferMajor ? 0.8 : 0.2;
		return this.drawForTemperature(temperature);
	}

	/**
	 * Get an oracle card to combine with a review pass
	 * (Extra randomness injection)
	 */
	drawOracleModifier(): string {
		const card = this.oracle.drawCard();
		return card.text;
	}

	/**
	 * Reset all used cards
	 */
	reset(): void {
		this.usedMajor.clear();
		this.usedMinor.clear();
		this.oracle.resetDeck();
	}

	/**
	 * Format a review pass for display
	 */
	formatPass(pass: ReviewPass): string {
		if (pass.isMajor) {
			const card = pass.card as MajorArcanaCard;
			return `[T=${pass.temperature.toFixed(2)}] ${card.name} (${card.archetype})\n  → ${pass.prompt}`;
		}

		const card = pass.card as MinorArcanaCard;
		return `[T=${pass.temperature.toFixed(2)}] ${card.rank} of ${card.suit} (${card.domain})\n  → ${pass.prompt}`;
	}
}
