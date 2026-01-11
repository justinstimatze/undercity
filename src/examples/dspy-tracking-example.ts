/**
 * Example: Enhanced Knowledge Tracking for DSPy Assessment
 *
 * Shows how to record prompt performance data that helps evaluate
 * whether DSPy integration would provide value.
 */

import { KnowledgeTracker } from "../knowledge-tracker.js";

// Example of recording enhanced prompt knowledge
export function recordEnhancedPromptExample() {
	const tracker = new KnowledgeTracker();

	// Record a successful prompt with enhanced metrics
	tracker.recordPromptKnowledge(
		"bug-fix", // Task type
		"Fix the authentication error in the login flow", // Original prompt
		"Located the issue in token validation and updated middleware to handle expired tokens properly", // Approach
		{
			tokensUsed: 1200,
			executionTimeMs: 45000,
			successRating: 4,
			// Enhanced metrics for DSPy evaluation
			humanSatisfactionScore: 5,
			errorCategories: [], // No errors on this successful task
			requiredHumanIntervention: false,
		},
		["authentication", "bug-fix", "middleware"],
	);

	// Record a problematic prompt that might benefit from DSPy optimization
	tracker.recordPromptKnowledge(
		"feature-implementation",
		"Add real-time notifications to the dashboard",
		"Attempted WebSocket implementation but had issues with connection management", // Approach
		{
			tokensUsed: 2100,
			executionTimeMs: 120000,
			successRating: 2, // Low success
			// Enhanced metrics showing issues
			humanSatisfactionScore: 2,
			errorCategories: ["ambiguous_requirements", "poor_context", "wrong_approach"],
			requiredHumanIntervention: true, // Needed human help
		},
		["real-time", "websockets", "dashboard"],
	);
}

// Example of assessing DSPy readiness
export async function assessDSPyReadinessExample() {
	const tracker = new KnowledgeTracker();

	console.log("Assessing DSPy Readiness...");

	const assessment = tracker.assessDSPyReadiness();

	console.log("\n=== DSPy Readiness Assessment ===");
	console.log(`Recommendation: ${assessment.recommendDSPy ? "YES" : "NO"}`);
	console.log(`Confidence: ${(assessment.confidence * 100).toFixed(1)}%`);

	console.log("\nKey Metrics:");
	console.log(`- Low-performing prompts: ${assessment.criticalMetrics.lowPerformingPrompts}`);
	console.log(`- Human intervention rate: ${(assessment.criticalMetrics.humanInterventionRate * 100).toFixed(1)}%`);
	console.log(`- Avg satisfaction: ${assessment.criticalMetrics.avgSatisfactionScore.toFixed(1)}/5`);
	console.log(`- Error categories: ${assessment.criticalMetrics.errorPatternDiversity}`);

	console.log("\nRationale:");
	for (const reason of assessment.rationale) {
		console.log(`- ${reason}`);
	}
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
	recordEnhancedPromptExample();
	await assessDSPyReadinessExample();
}
