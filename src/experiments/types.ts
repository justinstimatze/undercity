/**
 * Experimentation Framework Types
 *
 * Defines types for A/B experiments, variant assignment, and statistical analysis
 */

import { AgentType, ContextSize, ModelChoice, ParallelismLevel } from "../types.js";

/**
 * Experiment status
 */
export type ExperimentStatus = "draft" | "active" | "paused" | "completed" | "archived";

/**
 * Parameter types that can be varied in experiments
 */
export interface VariantParameters {
  /** Model choice for each agent type */
  modelChoices?: Partial<Record<AgentType, ModelChoice>>;
  /** Squad composition - which agents to include */
  squadComposition?: AgentType[];
  /** Maximum squad size */
  maxSquadSize?: number;
  /** Context size configuration */
  contextSize?: ContextSize;
  /** Parallelism level */
  parallelismLevel?: ParallelismLevel;
  /** Auto-approval setting */
  autoApprove?: boolean;
  /** Custom parameters for specific hypotheses */
  customParameters?: Record<string, any>;
}

/**
 * Experiment variant definition
 */
export interface ExperimentVariant {
  /** Unique variant identifier */
  id: string;
  /** Human-readable variant name */
  name: string;
  /** Description of what this variant tests */
  description: string;
  /** Probability weight for assignment (0-1) */
  weight: number;
  /** Parameters to override for this variant */
  parameters: VariantParameters;
  /** Whether this is the control variant */
  isControl?: boolean;
}

/**
 * Success metrics that can be tracked
 */
export interface SuccessMetrics {
  /** Quest completion rate (0-1) */
  successRate: number;
  /** Average tokens used per quest */
  avgTokensPerQuest: number;
  /** Average execution time in milliseconds */
  avgExecutionTimeMs: number;
  /** Average number of rework attempts */
  avgReworkCount: number;
  /** Human satisfaction score (1-5) if available */
  humanSatisfaction?: number;
}

/**
 * Outcome tracking for a single quest assignment
 */
export interface ExperimentOutcome {
  /** Unique outcome ID */
  id: string;
  /** Experiment ID this outcome belongs to */
  experimentId: string;
  /** Variant ID assigned to this outcome */
  variantId: string;
  /** Quest ID that was executed */
  questId: string;
  /** Whether the quest succeeded */
  success: boolean;
  /** Total tokens used */
  tokensUsed: number;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Number of rework attempts */
  reworkCount: number;
  /** Human rating if provided (1-5) */
  humanRating?: number;
  /** When the outcome was recorded */
  recordedAt: Date;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Statistical significance test result
 */
export interface SignificanceTestResult {
  /** Name of the metric tested */
  metric: string;
  /** Control variant value */
  controlValue: number;
  /** Treatment variant value */
  treatmentValue: number;
  /** Percentage improvement (positive is better for treatment) */
  improvement: number;
  /** P-value from statistical test */
  pValue: number;
  /** Whether result is statistically significant */
  isSignificant: boolean;
  /** Confidence interval for the improvement */
  confidenceInterval: [number, number];
  /** Sample sizes */
  sampleSizes: { control: number; treatment: number };
}

/**
 * Experiment analysis result
 */
export interface ExperimentAnalysis {
  /** When analysis was performed */
  analyzedAt: Date;
  /** Number of outcomes analyzed per variant */
  sampleSizes: Record<string, number>;
  /** Metrics per variant */
  variantMetrics: Record<string, SuccessMetrics>;
  /** Statistical significance tests */
  significanceTests: SignificanceTestResult[];
  /** Overall experiment status */
  status: "insufficient_data" | "running" | "significant" | "inconclusive";
  /** Recommended action */
  recommendation: "continue" | "stop_winner" | "stop_no_effect" | "increase_sample_size";
  /** Winning variant ID if significant */
  winningVariant?: string;
  /** Confidence in recommendation (0-1) */
  confidence: number;
}

/**
 * Experiment definition
 */
export interface Experiment {
  /** Unique experiment identifier */
  id: string;
  /** Human-readable experiment name */
  name: string;
  /** Detailed description of the hypothesis */
  description: string;
  /** What hypothesis this experiment tests */
  hypothesis: string;
  /** Current experiment status */
  status: ExperimentStatus;
  /** Experiment variants */
  variants: ExperimentVariant[];
  /** Target sample size per variant */
  targetSampleSize: number;
  /** Alpha level for significance testing (default 0.05) */
  alphaLevel: number;
  /** Minimum effect size to detect */
  minimumDetectableEffect: number;
  /** When experiment was created */
  createdAt: Date;
  /** When experiment started */
  startedAt?: Date;
  /** When experiment ended */
  endedAt?: Date;
  /** Creator/owner of the experiment */
  createdBy: string;
  /** Tags for categorization */
  tags: string[];
  /** Latest analysis results */
  latestAnalysis?: ExperimentAnalysis;
}

/**
 * Quest assignment to experiment variant
 */
export interface QuestAssignment {
  /** Quest ID */
  questId: string;
  /** Experiment ID */
  experimentId: string;
  /** Assigned variant ID */
  variantId: string;
  /** When assignment was made */
  assignedAt: Date;
  /** Random seed used for assignment */
  assignmentSeed: string;
}

/**
 * Experiment storage structure
 */
export interface ExperimentStorage {
  /** All experiments */
  experiments: Record<string, Experiment>;
  /** Quest assignments */
  assignments: QuestAssignment[];
  /** Experiment outcomes */
  outcomes: ExperimentOutcome[];
  /** Storage version for migrations */
  version: string;
  /** When storage was last updated */
  lastUpdated: Date;
}