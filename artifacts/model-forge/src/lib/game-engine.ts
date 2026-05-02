import { GameState } from "./game-types";

export type Choice = {
  id: string;
  label: string;
  effect: (s: GameState) => void;
};

export type GameEvent = {
  id: string;
  title: string;
  description: string;
  choices: Choice[];
};

export function applyChoiceAndAdvance(state: GameState, event: GameEvent, choiceId: string): GameState {
  let s = JSON.parse(JSON.stringify(state)) as GameState;
  const choice = event.choices.find((c) => c.id === choiceId);
  if (choice) {
    choice.effect(s);
    s.eventLog.push({ day: s.day, type: event.id, message: event.description, choice: choice.label });
  }
  return advanceDay(s);
}

export function skipEventAndAdvance(state: GameState): GameState {
  return advanceDay(JSON.parse(JSON.stringify(state)));
}

function advanceDay(s: GameState): GameState {
  // Apply future effects triggering on this day
  const remaining: GameState["futureEffects"] = [];
  for (const effect of s.futureEffects) {
    if (effect.triggerDay === s.day) {
      if (effect.metric === "precision") s.metrics.precision += effect.delta;
      if (effect.metric === "recall") s.metrics.recall += effect.delta;
      if (effect.metric === "slaAdherence") s.metrics.slaAdherence += effect.delta;
      if (effect.metric === "inferenceCost") s.metrics.inferenceCost += effect.delta;
      if (effect.metric === "featureStaleness") s.metrics.featureStaleness += effect.delta;
      if (effect.metric === "skewLevel") s.metrics.skew = effect.delta > 0 ? "High" : "Medium";
      s.eventLog.push({ day: s.day, type: "effect", message: effect.message });
    } else {
      remaining.push(effect);
    }
  }
  s.futureEffects = remaining;

  // Save history snapshot
  s.history.push(JSON.parse(JSON.stringify(s)));
  if (s.history.length > 20) s.history = s.history.slice(-20);

  // Advance day
  s.day += 1;

  // Passive decay
  s.metrics.precision = Math.max(0, s.metrics.precision - 1);
  s.metrics.recall = Math.max(0, s.metrics.recall - 1);
  s.metrics.featureStaleness = s.featureStore.enabled ? 2 : s.metrics.featureStaleness + 2;
  s.metrics.slaAdherence = Math.max(0, s.metrics.slaAdherence - 0.5);

  if (s.ciCd.autoRetrain) {
    s.metrics.precision = Math.min(100, s.metrics.precision + 2);
  }

  // Clamp
  s.metrics.precision = Math.min(100, Math.max(0, s.metrics.precision));
  s.metrics.recall = Math.min(100, Math.max(0, s.metrics.recall));
  s.metrics.slaAdherence = Math.min(100, Math.max(0, s.metrics.slaAdherence));
  s.metrics.inferenceCost = Math.min(100, Math.max(0, s.metrics.inferenceCost));

  // Loss conditions
  if (
    s.metrics.precision <= 0 ||
    s.metrics.recall <= 0 ||
    s.metrics.slaAdherence <= 0 ||
    s.metrics.featureStaleness > 48 ||
    s.metrics.inferenceCost >= 100
  ) {
    s.status = "lost";
  }

  // Win condition
  if (s.day > 14 && s.status === "playing") {
    s.status = "won";
    s.wins += 1;
  }

  return s;
}

export function getEventForDay(state: GameState): GameEvent | null {
  if (state.status !== "playing") return null;

  const d = state.day;
  const sc = state.scenario;

  if ((sc === "zillow" || sc === "tesla") && d === 3) {
    return {
      id: "overfitting",
      title: "OVERFITTING DETECTED",
      description:
        "Model shows Precision 99% offline — but Recall has dropped to 60% in production. Classic overfitting to training distribution.",
      choices: [
        {
          id: "A",
          label: "Simplify to Linear Regression",
          effect: (s) => {
            s.metrics.precision -= 15;
            s.metrics.recall += 20;
            s.metrics.skew = "Low";
            s.registry.models.push({
              id: "model_v2",
              type: "Linear",
              version: "2.0",
              stage: "production",
              trainedOnDay: s.day,
              dataVersion: "dataset_latest",
              accuracy: 70,
              cost: 0.05,
              latency: 5,
              explainability: "High",
            });
            s.registry.productionModelId = "model_v2";
          },
        },
        {
          id: "B",
          label: "Add validation set + retrain XGBoost",
          effect: (s) => {
            s.metrics.precision -= 5;
            s.metrics.recall += 15;
            s.registry.models.push({
              id: "model_v2",
              type: "XGBoost",
              version: "2.0",
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_latest",
              accuracy: 85,
              cost: 0.1,
              latency: 15,
              explainability: "Medium",
            });
          },
        },
        {
          id: "C",
          label: "Ignore it — metrics look fine",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "recall",
              delta: -10,
              message: "Unaddressed overfitting caused Recall to degrade",
            });
          },
        },
      ],
    };
  }

  if ((sc === "tay" || sc === "stripe") && d === 2) {
    return {
      id: "poisoning",
      title: "DATA POISONING SUSPECTED",
      description:
        "Suspicious patterns detected in incoming training data. Possible adversarial injection targeting your feature store.",
      choices: [
        {
          id: "A",
          label: "Add data validation pipeline",
          effect: (s) => {
            s.metrics.skew = "Low";
            s.featureStore.enabled = true;
            s.metrics.featureStaleness = 1;
          },
        },
        {
          id: "B",
          label: "Rollback to baseline model",
          effect: (s) => {
            s.metrics.recall -= 10;
            s.metrics.precision -= 5;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "C",
          label: "Monitor and wait",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "skewLevel",
              delta: 1,
              message: "Data poisoning escalated — Skew now HIGH",
            });
          },
        },
      ],
    };
  }

  if ((sc === "amazon" || sc === "twitter") && d === 4) {
    return {
      id: "bias",
      title: "BIAS AUDIT FLAGGED",
      description:
        "Bias detected in predictions against a protected group — divergence of 18%. Compliance team is escalating to leadership.",
      choices: [
        {
          id: "A",
          label: "Switch to Linear (explainable)",
          effect: (s) => {
            s.metrics.precision -= 15;
            s.metrics.recall += 5;
            s.metrics.skew = "Low";
            s.registry.models.push({
              id: "model_v2",
              type: "Linear",
              version: "2.0",
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_latest",
              accuracy: 70,
              cost: 0.05,
              latency: 5,
              explainability: "High",
            });
          },
        },
        {
          id: "B",
          label: "Add fairness constraint to Feature Store",
          effect: (s) => {
            s.featureStore.enabled = true;
            s.metrics.precision -= 3;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "C",
          label: "Suppress the report",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "slaAdherence",
              delta: -25,
              message: "Compliance audit failure — regulators intervened",
            });
          },
        },
      ],
    };
  }

  if ((sc === "uber" || sc === "facebook") && d === 3) {
    return {
      id: "latency",
      title: "LATENCY CRISIS",
      description:
        "P99 inference latency spiked to 180ms. SLA threshold is 100ms. Peak traffic window begins in 2 hours.",
      choices: [
        {
          id: "A",
          label: "Fallback to XGBoost (faster, lower accuracy)",
          effect: (s) => {
            s.metrics.precision -= 8;
            s.metrics.recall -= 5;
            s.metrics.slaAdherence += 10;
          },
        },
        {
          id: "B",
          label: "Scale inference cluster (+50% cost)",
          effect: (s) => {
            s.metrics.inferenceCost += 40;
            s.metrics.slaAdherence += 15;
          },
        },
        {
          id: "C",
          label: "Do nothing and hope",
          effect: (s) => {
            s.metrics.slaAdherence -= 20;
            s.futureEffects.push({
              triggerDay: s.day + 1,
              metric: "slaAdherence",
              delta: -15,
              message: "Peak traffic overwhelmed the system",
            });
          },
        },
      ],
    };
  }

  if ((sc === "netflix" || sc === "google") && d === 5) {
    return {
      id: "drift",
      title: "CONCEPT DRIFT DETECTED",
      description:
        "User behavior shifted significantly post-event. Model trained on 6-month-old distribution is now stale.",
      choices: [
        {
          id: "A",
          label: "Enable CI/CD auto-retraining",
          effect: (s) => {
            s.ciCd.autoRetrain = true;
            s.metrics.precision += 5;
          },
        },
        {
          id: "B",
          label: "Manual retrain with fresh data",
          effect: (s) => {
            s.metrics.precision += 10;
            s.metrics.recall += 8;
            s.registry.models.push({
              id: `model_v${s.day}`,
              type: "XGBoost",
              version: `${s.day}.0`,
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_latest_v2",
              accuracy: 87,
              cost: 0.1,
              latency: 15,
              explainability: "Medium",
            });
          },
        },
        {
          id: "C",
          label: "Ignore the drift signal",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: -5, message: "Drift degraded Precision" },
              { triggerDay: s.day + 4, metric: "precision", delta: -5, message: "Severe concept drift — Precision critically low" }
            );
          },
        },
      ],
    };
  }

  // Triggered events (check after scenario)
  if (state.metrics.precision < 60) {
    return {
      id: "low_accuracy",
      title: "CRITICAL: LOW PRECISION",
      description: "Precision has dropped below 60%. Users are receiving low-quality predictions in production.",
      choices: [
        {
          id: "A",
          label: "Emergency retrain",
          effect: (s) => {
            s.metrics.precision += 20;
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "B",
          label: "Rollback to previous model",
          effect: (s) => {
            s.metrics.precision = 70;
            s.metrics.recall -= 10;
          },
        },
        {
          id: "C",
          label: "Alert stakeholders and monitor",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "slaAdherence",
              delta: -10,
              message: "Stakeholders escalated low accuracy SLA breach",
            });
          },
        },
      ],
    };
  }

  if (state.metrics.featureStaleness > 24) {
    return {
      id: "stale_features",
      title: "CRITICAL: STALE FEATURES",
      description:
        "Feature staleness exceeds 24 hours. Training-serving skew is widening — model is operating on outdated inputs.",
      choices: [
        {
          id: "A",
          label: "Enable Feature Store auto-refresh",
          effect: (s) => {
            s.featureStore.enabled = true;
            s.metrics.featureStaleness = 2;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "B",
          label: "Emergency feature refresh (one-time)",
          effect: (s) => {
            s.metrics.featureStaleness = 4;
            s.metrics.skew = "Medium";
          },
        },
        {
          id: "C",
          label: "Accept technical debt",
          effect: (s) => {
            s.metrics.skew = "High";
          },
        },
      ],
    };
  }

  if (state.metrics.slaAdherence < 80) {
    return {
      id: "sla_breach",
      title: "SLA BREACH",
      description: "SLA adherence dropped below 80%. Multiple customers report degraded service. Escalations incoming.",
      choices: [
        {
          id: "A",
          label: "Rollback to last stable model",
          effect: (s) => {
            s.metrics.slaAdherence += 15;
            s.metrics.precision -= 5;
          },
        },
        {
          id: "B",
          label: "Scale infrastructure",
          effect: (s) => {
            s.metrics.slaAdherence += 10;
            s.metrics.inferenceCost += 20;
          },
        },
        {
          id: "C",
          label: "Investigate root cause",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 1,
              metric: "slaAdherence",
              delta: 5,
              message: "Root cause investigation resolved bottleneck",
            });
          },
        },
      ],
    };
  }

  // Random daily events pool
  const pool: GameEvent[] = [
    {
      id: "rand_upstream_delay",
      title: "PIPELINE DELAY",
      description: "Upstream data pipeline delayed 3 hours due to infrastructure issues.",
      choices: [
        { id: "A", label: "Delay feature ingest", effect: (s) => { s.metrics.featureStaleness += 4; } },
        { id: "B", label: "Use cached features", effect: (s) => { s.metrics.precision -= 2; } },
        { id: "C", label: "Halt predictions temporarily", effect: (s) => { s.metrics.slaAdherence -= 5; } },
      ],
    },
    {
      id: "rand_ab_test",
      title: "A/B TEST RESULTS",
      description: "Canary model showing 5% recall improvement on 10% of live traffic. Ready to promote?",
      choices: [
        {
          id: "A",
          label: "Promote canary to production",
          effect: (s) => {
            s.metrics.recall += 5;
            const newId = `model_v${s.day}`;
            s.registry.models.push({ id: newId, type: "XGBoost", version: `${s.day}.0`, stage: "production", trainedOnDay: s.day, dataVersion: "dataset_latest", accuracy: 87, cost: 0.1, latency: 15, explainability: "Medium" });
            s.registry.productionModelId = newId;
          },
        },
        { id: "B", label: "Run experiment longer", effect: (_s) => {} },
        { id: "C", label: "Roll back canary", effect: (_s) => {} },
      ],
    },
    {
      id: "rand_new_dataset",
      title: "NEW DATASET AVAILABLE",
      description: "Dataset v2025Q2 is ready — 2x more training examples and fresher distribution.",
      choices: [
        {
          id: "A",
          label: "Retrain immediately",
          effect: (s) => {
            s.metrics.precision += 8;
            s.metrics.inferenceCost += 5;
            const newId = `model_v${s.day}`;
            s.registry.models.push({ id: newId, type: "XGBoost", version: `${s.day}.0`, stage: "staging", trainedOnDay: s.day, dataVersion: "dataset_2025Q2", accuracy: 88, cost: 0.1, latency: 15, explainability: "Medium" });
          },
        },
        {
          id: "B",
          label: "Schedule for next sprint",
          effect: (s) => {
            s.futureEffects.push({ triggerDay: s.day + 3, metric: "precision", delta: 5, message: "Scheduled retrain improved Precision" });
          },
        },
        { id: "C", label: "Skip — current model is good enough", effect: (_s) => {} },
      ],
    },
    {
      id: "rand_gpu_interrupt",
      title: "GPU SPOT INSTANCE INTERRUPTED",
      description: "Batch inference job failed mid-run. Spot instance was reclaimed by cloud provider.",
      choices: [
        { id: "A", label: "Switch to on-demand instances", effect: (s) => { s.metrics.inferenceCost += 15; } },
        { id: "B", label: "Retry on next spot window", effect: (s) => { s.metrics.slaAdherence -= 8; } },
        { id: "C", label: "Queue requests — degrade gracefully", effect: (s) => { s.metrics.recall -= 3; } },
      ],
    },
    {
      id: "rand_security",
      title: "SECURITY VULNERABILITY",
      description: "Critical CVE found in the model serving container. Patch requires brief restart.",
      choices: [
        {
          id: "A",
          label: "Patch immediately",
          effect: (s) => {
            s.metrics.slaAdherence -= 5;
            s.futureEffects.push({ triggerDay: s.day + 1, metric: "slaAdherence", delta: 8, message: "Security patch applied — SLA stabilized" });
          },
        },
        { id: "B", label: "Schedule during off-peak maintenance", effect: (_s) => {} },
        { id: "C", label: "Accept risk — delay indefinitely", effect: (s) => { s.futureEffects.push({ triggerDay: s.day + 2, metric: "skewLevel", delta: 1, message: "Unpatched vulnerability exploited — Skew HIGH" }); } },
      ],
    },
    {
      id: "rand_traffic_spike",
      title: "TRAFFIC SPIKE: 3X VOLUME",
      description: "Unexpected 3x spike in inference requests. Infrastructure is under stress.",
      choices: [
        { id: "A", label: "Auto-scale cluster", effect: (s) => { s.metrics.inferenceCost += 20; } },
        { id: "B", label: "Rate limit requests", effect: (s) => { s.metrics.slaAdherence -= 10; } },
        { id: "C", label: "Let it fail — shed load", effect: (s) => { s.metrics.slaAdherence -= 20; s.metrics.recall -= 5; } },
      ],
    },
    {
      id: "rand_null_features",
      title: "NULL FEATURE SPIKE",
      description: "Monitor detected unusual spike in null feature values in the last inference batch.",
      choices: [
        { id: "A", label: "Investigate and fix upstream pipeline", effect: (s) => { s.metrics.featureStaleness = 3; } },
        { id: "B", label: "Impute nulls with mean", effect: (s) => { s.metrics.precision -= 3; } },
        { id: "C", label: "Ignore — likely a blip", effect: (s) => { s.metrics.skew = s.metrics.skew === "Low" ? "Medium" : "High"; } },
      ],
    },
    {
      id: "rand_explainability",
      title: "LEGAL EXPLAINABILITY REQUEST",
      description: "Legal team requires model explainability report for a pending audit within 48 hours.",
      choices: [
        { id: "A", label: "Generate SHAP report", effect: (s) => { s.metrics.inferenceCost += 5; } },
        { id: "B", label: "Use surrogate model for explanation", effect: (s) => { s.metrics.precision -= 3; } },
        { id: "C", label: "Deny request — no bandwidth", effect: (s) => { s.metrics.slaAdherence -= 3; } },
      ],
    },
  ];

  return pool[d % pool.length];
}

export function generatePostMortem(state: GameState): string[] {
  const bullets: string[] = [];
  if (!state.featureStore.enabled) {
    bullets.push("Feature Store was never enabled — feature staleness escalated unchecked, widening training-serving skew.");
  }
  if (!state.ciCd.autoRetrain) {
    bullets.push("CI/CD auto-retraining was disabled — concept drift went undetected until metrics collapsed.");
  }
  if (state.registry.models.filter((m) => m.stage === "staging" || m.stage === "archived").length === 0) {
    bullets.push("Model Registry had no staging model — you had no safe rollback option when production degraded.");
  }
  if (state.metrics.precision <= 0) {
    bullets.push("Precision hit zero — the model was making meaningless predictions. Emergency retraining or rollback was needed.");
  }
  if (state.metrics.recall <= 0) {
    bullets.push("Recall hit zero — the model stopped detecting positive cases entirely.");
  }
  if (state.metrics.slaAdherence <= 0) {
    bullets.push("SLA adherence hit zero — a complete production outage. Infrastructure scaling or rollback was critical.");
  }
  if (state.metrics.featureStaleness > 48) {
    bullets.push("Feature staleness exceeded 48 hours — the model was operating on data nearly 2 days out of date.");
  }
  if (state.metrics.inferenceCost >= 100) {
    bullets.push("Inference cost hit the limit — unchecked scaling without optimization bankrupted the budget.");
  }
  if (bullets.length === 0) {
    bullets.push("The simulation ended unexpectedly. Review your metric decisions and event choices.");
  }
  return bullets;
}
