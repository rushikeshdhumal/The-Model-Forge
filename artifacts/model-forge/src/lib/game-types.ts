export interface GameState {
  sessionId: string;
  scenario: string;
  day: number;
  status: "playing" | "won" | "lost";
  metrics: {
    precision: number;
    recall: number;
    featureStaleness: number;
    inferenceCost: number;
    slaAdherence: number;
    skew: "Low" | "Medium" | "High";
  };
  registry: {
    models: ModelInfo[];
    productionModelId: string;
  };
  featureStore: {
    enabled: boolean;
    stalenessHours: number;
    featureVersions: string[];
  };
  ciCd: {
    autoRetrain: boolean;
    testPassRate: number;
  };
  eventLog: Array<{ day: number; type: string; message: string; choice?: string }>;
  futureEffects: Array<{ triggerDay: number; metric: string; delta: number; message: string }>;
  history: any[];
  userLevel: "intern" | "engineer" | "mlops";
  wins: number;
  streak: number;
  maxStreak: number;
  score?: number;
  grade?: string;
  scenarioFlags?: Partial<Record<string, boolean>>;
}

export interface ModelInfo {
  id: string;
  type: "Linear" | "XGBoost" | "Neural Network" | "Ensemble";
  version: string;
  stage: "production" | "staging" | "archived";
  trainedOnDay: number;
  dataVersion: string;
  accuracy?: number;
  cost?: number;
  latency?: number;
  explainability?: string;
}

export const DEFAULT_STATE: GameState = {
  sessionId: "",
  scenario: "default",
  day: 1,
  status: "playing",
  metrics: { precision: 85, recall: 80, featureStaleness: 2, inferenceCost: 10, slaAdherence: 99, skew: "Low" },
  registry: {
    models: [{ id: "model_v1", type: "XGBoost", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_20250428", accuracy: 85, cost: 0.10, latency: 15, explainability: "Medium" }],
    productionModelId: "model_v1"
  },
  featureStore: { enabled: false, stalenessHours: 0, featureVersions: [] },
  ciCd: { autoRetrain: false, testPassRate: 1.0 },
  eventLog: [],
  futureEffects: [],
  history: [],
  userLevel: "intern",
  wins: 0,
  streak: 0,
  maxStreak: 0,
};
