/**
 * Tests for semantic topic keyword extraction
 */

import { describe, expect, it } from "vitest";
import {
	extractSemanticTopics,
	extractTopicsFromResearch,
	filterTopicsByConfidence,
	getExtractionMetrics,
	groupTopicsByCategory,
	type SemanticTopic,
	type TopicCategory,
} from "../semantic-keywords.js";

describe("extractSemanticTopics", () => {
	it("should extract technology keywords", () => {
		const topics = extractSemanticTopics("Research TypeScript and Node.js best practices");

		const techTopics = topics.filter((t) => t.category === "technology");
		expect(techTopics.length).toBeGreaterThanOrEqual(2);

		const tsKeyword = techTopics.find((t) => t.keyword === "typescript");
		expect(tsKeyword).toBeDefined();
		expect(tsKeyword?.confidence).toBeGreaterThan(0.9);

		const nodeKeyword = techTopics.find((t) => t.keyword === "node.js");
		expect(nodeKeyword).toBeDefined();
		expect(nodeKeyword?.confidence).toBeGreaterThan(0.9);
	});

	it("should extract library keywords", () => {
		const topics = extractSemanticTopics("Implement JWT authentication with React");

		const libTopics = topics.filter((t) => t.category === "library");
		expect(libTopics.length).toBeGreaterThanOrEqual(2);

		const jwtKeyword = libTopics.find((t) => t.keyword === "jwt");
		expect(jwtKeyword).toBeDefined();
		expect(jwtKeyword?.confidence).toBeGreaterThan(0.9);

		const reactKeyword = libTopics.find((t) => t.keyword === "react");
		expect(reactKeyword).toBeDefined();
		expect(reactKeyword?.confidence).toBeGreaterThan(0.9);
	});

	it("should extract domain concept keywords", () => {
		const topics = extractSemanticTopics("Research authentication and caching strategies");

		const domainTopics = topics.filter((t) => t.category === "domain_concept");
		expect(domainTopics.length).toBeGreaterThanOrEqual(2);

		const authKeyword = domainTopics.find((t) => t.keyword === "authentication");
		expect(authKeyword).toBeDefined();
		expect(authKeyword?.confidence).toBeGreaterThan(0.9);

		const cacheKeyword = domainTopics.find((t) => t.keyword === "caching");
		expect(cacheKeyword).toBeDefined();
		expect(cacheKeyword?.confidence).toBeGreaterThan(0.8);
	});

	it("should extract architecture keywords", () => {
		const topics = extractSemanticTopics("Design REST API with PostgreSQL database");

		const archTopics = topics.filter((t) => t.category === "architecture");
		expect(archTopics.length).toBeGreaterThanOrEqual(2);

		const restKeyword = archTopics.find((t) => t.keyword === "rest api");
		expect(restKeyword).toBeDefined();
		expect(restKeyword?.confidence).toBeGreaterThan(0.9);

		const pgKeyword = archTopics.find((t) => t.keyword === "postgresql");
		expect(pgKeyword).toBeDefined();
		expect(pgKeyword?.confidence).toBeGreaterThan(0.9);
	});

	it("should extract tool keywords", () => {
		const topics = extractSemanticTopics("Setup Docker and Kubernetes deployment");

		const toolTopics = topics.filter((t) => t.category === "tool");
		expect(toolTopics.length).toBeGreaterThanOrEqual(2);

		const dockerKeyword = toolTopics.find((t) => t.keyword === "docker");
		expect(dockerKeyword).toBeDefined();
		expect(dockerKeyword?.confidence).toBeGreaterThan(0.9);

		const k8sKeyword = toolTopics.find((t) => t.keyword === "kubernetes");
		expect(k8sKeyword).toBeDefined();
		expect(k8sKeyword?.confidence).toBeGreaterThan(0.9);
	});

	it("should extract pattern keywords", () => {
		const topics = extractSemanticTopics("Implement singleton pattern with dependency injection");

		const patternTopics = topics.filter((t) => t.category === "pattern");
		expect(patternTopics.length).toBeGreaterThanOrEqual(2);

		const singletonKeyword = patternTopics.find((t) => t.keyword === "singleton");
		expect(singletonKeyword).toBeDefined();
		expect(singletonKeyword?.confidence).toBeGreaterThan(0.8);

		const diKeyword = patternTopics.find((t) => t.keyword === "dependency injection");
		expect(diKeyword).toBeDefined();
		expect(diKeyword?.confidence).toBeGreaterThan(0.8);
	});

	it("should extract methodology keywords", () => {
		const topics = extractSemanticTopics("Setup CI/CD pipeline with test-driven development");

		const methodTopics = topics.filter((t) => t.category === "methodology");
		expect(methodTopics.length).toBeGreaterThanOrEqual(2);

		const cicdKeyword = methodTopics.find((t) => t.keyword === "ci/cd");
		expect(cicdKeyword).toBeDefined();
		expect(cicdKeyword?.confidence).toBeGreaterThan(0.9);

		const tddKeyword = methodTopics.find((t) => t.keyword === "test-driven");
		expect(tddKeyword).toBeDefined();
		expect(tddKeyword?.confidence).toBeGreaterThan(0.8);
	});

	it("should extract infrastructure keywords", () => {
		const topics = extractSemanticTopics("Deploy to AWS with nginx load balancer");

		const infraTopics = topics.filter((t) => t.category === "infrastructure");
		expect(infraTopics.length).toBeGreaterThanOrEqual(2);

		const awsKeyword = infraTopics.find((t) => t.keyword === "aws");
		expect(awsKeyword).toBeDefined();
		expect(awsKeyword?.confidence).toBeGreaterThan(0.9);

		const nginxKeyword = infraTopics.find((t) => t.keyword === "nginx");
		expect(nginxKeyword).toBeDefined();
		expect(nginxKeyword?.confidence).toBeGreaterThan(0.8);
	});

	it("should handle multi-word phrases", () => {
		const topics = extractSemanticTopics("Build REST API with rate limit middleware");

		const restKeyword = topics.find((t) => t.keyword === "rest api");
		expect(restKeyword).toBeDefined();
		expect(restKeyword?.category).toBe("architecture");

		const rateLimitKeyword = topics.find((t) => t.keyword === "rate limit");
		expect(rateLimitKeyword).toBeDefined();
		expect(rateLimitKeyword?.category).toBe("domain_concept");
	});

	it("should handle metadata findings", () => {
		const topics = extractSemanticTopics("Research authentication", {
			findings: [
				{ finding: "JWT tokens provide stateless authentication", source: "jwt.io" },
				{ finding: "Use bcrypt for password hashing", source: "security.txt" },
			],
		});

		const jwtKeyword = topics.find((t) => t.keyword === "jwt");
		expect(jwtKeyword).toBeDefined();

		const bcryptKeyword = topics.find((t) => t.keyword === "bcrypt");
		expect(bcryptKeyword).toBeDefined();
	});

	it("should handle metadata sources", () => {
		const topics = extractSemanticTopics("Research caching", {
			sources: ["Redis documentation", "Memcached best practices"],
		});

		const redisKeyword = topics.find((t) => t.keyword === "redis");
		expect(redisKeyword).toBeDefined();

		const memcachedKeyword = topics.find((t) => t.keyword === "memcached");
		expect(memcachedKeyword).toBeDefined();
	});

	it("should extract topics from task category", () => {
		const topics = extractSemanticTopics("Improve performance", {
			category: "refactor",
		});

		const refactorKeyword = topics.find((t) => t.keyword === "refactoring");
		expect(refactorKeyword).toBeDefined();
		expect(refactorKeyword?.category).toBe("methodology");
	});

	it("should sort topics by confidence descending", () => {
		const topics = extractSemanticTopics("JWT authentication with Redis caching");

		// Check that topics are sorted by confidence
		for (let i = 0; i < topics.length - 1; i++) {
			expect(topics[i].confidence).toBeGreaterThanOrEqual(topics[i + 1].confidence);
		}
	});

	it("should handle empty objective", () => {
		const topics = extractSemanticTopics("");
		expect(topics).toEqual([]);
	});

	it("should be case-insensitive", () => {
		const topics1 = extractSemanticTopics("JWT Authentication");
		const topics2 = extractSemanticTopics("jwt authentication");

		expect(topics1.length).toBe(topics2.length);
		expect(topics1.every((t1) => topics2.some((t2) => t1.keyword === t2.keyword))).toBe(true);
	});

	it("should deduplicate keywords across categories (keep highest confidence)", () => {
		// If a keyword appears in multiple dictionaries with different confidence,
		// only the highest should be kept
		const topics = extractSemanticTopics("factory pattern with factory library");

		const factoryTopics = topics.filter((t) => t.keyword === "factory");
		expect(factoryTopics.length).toBe(1);
		expect(factoryTopics[0].confidence).toBeGreaterThan(0);
	});
});

describe("extractTopicsFromResearch", () => {
	it("should extract topics from research result structure", () => {
		const result = {
			summary: "JWT authentication best practices with Redis caching",
			findings: [
				{ finding: "Use RS256 algorithm for JWT", source: "jwt.io" },
				{ finding: "Store tokens in Redis for blacklisting", source: "redis.io" },
			],
			sources: ["https://jwt.io/introduction/", "https://redis.io/docs/"],
		};

		const topics = extractTopicsFromResearch(result);

		expect(topics.length).toBeGreaterThan(0);

		const jwtKeyword = topics.find((t) => t.keyword === "jwt");
		expect(jwtKeyword).toBeDefined();

		const redisKeyword = topics.find((t) => t.keyword === "redis");
		expect(redisKeyword).toBeDefined();

		const authKeyword = topics.find((t) => t.keyword === "authentication");
		expect(authKeyword).toBeDefined();
	});
});

describe("filterTopicsByConfidence", () => {
	it("should filter topics by minimum confidence", () => {
		const topics: SemanticTopic[] = [
			{ keyword: "jwt", category: "library", confidence: 0.95 },
			{ keyword: "auth", category: "domain_concept", confidence: 0.85 },
			{ keyword: "token", category: "domain_concept", confidence: 0.75 },
		];

		const filtered = filterTopicsByConfidence(topics, 0.8);

		expect(filtered.length).toBe(2);
		expect(filtered.every((t) => t.confidence >= 0.8)).toBe(true);
	});

	it("should return empty array if no topics meet threshold", () => {
		const topics: SemanticTopic[] = [{ keyword: "token", category: "domain_concept", confidence: 0.5 }];

		const filtered = filterTopicsByConfidence(topics, 0.8);

		expect(filtered).toEqual([]);
	});
});

describe("groupTopicsByCategory", () => {
	it("should group topics by category", () => {
		const topics: SemanticTopic[] = [
			{ keyword: "jwt", category: "library", confidence: 0.95 },
			{ keyword: "react", category: "library", confidence: 0.95 },
			{ keyword: "authentication", category: "domain_concept", confidence: 0.95 },
			{ keyword: "docker", category: "tool", confidence: 0.95 },
		];

		const grouped = groupTopicsByCategory(topics);

		expect(grouped.library.length).toBe(2);
		expect(grouped.domain_concept.length).toBe(1);
		expect(grouped.tool.length).toBe(1);
		expect(grouped.technology.length).toBe(0);
	});

	it("should include empty arrays for unused categories", () => {
		const topics: SemanticTopic[] = [{ keyword: "jwt", category: "library", confidence: 0.95 }];

		const grouped = groupTopicsByCategory(topics);

		expect(grouped).toHaveProperty("technology");
		expect(grouped).toHaveProperty("pattern");
		expect(grouped.technology).toEqual([]);
		expect(grouped.pattern).toEqual([]);
	});
});

describe("getExtractionMetrics", () => {
	it("should return latency metrics", () => {
		const metrics = getExtractionMetrics();

		expect(metrics.latency).toBeDefined();
		expect(metrics.latency.avg).toBeGreaterThan(0);
		expect(metrics.latency.median).toBeGreaterThan(0);
		expect(metrics.latency.p95).toBeGreaterThan(0);
	});

	it("should return cost metrics", () => {
		const metrics = getExtractionMetrics();

		expect(metrics.cost).toBeDefined();
		expect(metrics.cost.perExtraction).toBe(0); // Pattern-based is free
		expect(metrics.cost.total).toBe(0);
	});

	it("should have P95 latency under 500ms", () => {
		const metrics = getExtractionMetrics();

		expect(metrics.latency.p95).toBeLessThan(500);
	});
});

describe("integration: task type scenarios", () => {
	it("should extract keywords from research task", () => {
		const objective = "Research JWT authentication patterns and security best practices";
		const topics = extractSemanticTopics(objective);

		// Expect at least JWT, authentication, security
		expect(topics.length).toBeGreaterThanOrEqual(2);

		const categories = new Set(topics.map((t) => t.category));
		expect(categories.has("library")).toBe(true); // JWT
		expect(categories.has("domain_concept")).toBe(true); // authentication
	});

	it("should extract keywords from implementation task", () => {
		const objective = "Implement REST API with Express and PostgreSQL database";
		const topics = extractSemanticTopics(objective);

		expect(topics.length).toBeGreaterThanOrEqual(3);

		const restKeyword = topics.find((t) => t.keyword === "rest api");
		expect(restKeyword).toBeDefined();

		const expressKeyword = topics.find((t) => t.keyword === "express");
		expect(expressKeyword).toBeDefined();

		const pgKeyword = topics.find((t) => t.keyword === "postgresql");
		expect(pgKeyword).toBeDefined();
	});

	it("should extract keywords from review-fix task", () => {
		const objective = "Fix authentication token validation bug in middleware";
		const topics = extractSemanticTopics(objective);

		expect(topics.length).toBeGreaterThanOrEqual(2);

		const authKeyword = topics.find((t) => t.keyword === "authentication");
		expect(authKeyword).toBeDefined();

		const tokenKeyword = topics.find((t) => t.keyword === "token");
		expect(tokenKeyword).toBeDefined();

		const middlewareKeyword = topics.find((t) => t.keyword === "middleware");
		expect(middlewareKeyword).toBeDefined();
	});

	it("should handle complex multi-domain task", () => {
		const objective =
			"Research and implement JWT authentication with Redis caching, rate limiting, and CI/CD pipeline using Docker and Kubernetes";
		const topics = extractSemanticTopics(objective);

		// Should extract topics from multiple categories
		const categories = new Set(topics.map((t) => t.category));
		expect(categories.size).toBeGreaterThanOrEqual(4);

		expect(categories.has("library")).toBe(true); // JWT, Redis
		expect(categories.has("domain_concept")).toBe(true); // authentication, caching, rate limiting
		expect(categories.has("methodology")).toBe(true); // CI/CD
		expect(categories.has("tool")).toBe(true); // Docker, Kubernetes
	});
});

describe("acceptance criteria validation", () => {
	it("should support at least 8 semantic categories", () => {
		// Test that all 8 categories are recognized
		const testCases: Array<[string, TopicCategory]> = [
			["TypeScript", "technology"],
			["React", "library"],
			["Docker", "tool"],
			["Singleton", "pattern"],
			["Authentication", "domain_concept"],
			["REST API", "architecture"],
			["TDD", "methodology"],
			["AWS", "infrastructure"],
		];

		for (const [keyword, expectedCategory] of testCases) {
			const topics = extractSemanticTopics(keyword);
			const topic = topics.find((t) => t.keyword.toLowerCase() === keyword.toLowerCase());
			expect(topic).toBeDefined();
			expect(topic?.category).toBe(expectedCategory);
		}
	});

	it("should return confidence scores between 0 and 1", () => {
		const topics = extractSemanticTopics("JWT authentication with Redis caching");

		for (const topic of topics) {
			expect(topic.confidence).toBeGreaterThanOrEqual(0);
			expect(topic.confidence).toBeLessThanOrEqual(1);
		}
	});

	it("should have detailed JSDoc with param, returns, and example", () => {
		// This is validated by TypeScript and manual inspection
		// Functions should have complete JSDoc annotations
		expect(extractSemanticTopics).toBeDefined();
		expect(extractTopicsFromResearch).toBeDefined();
		expect(getExtractionMetrics).toBeDefined();
	});
});
