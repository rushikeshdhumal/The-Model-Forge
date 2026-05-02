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

// ---- Scenario Briefs ----

export type ScenarioBrief = {
  id: string;
  title: string;
  company: string;
  year: string;
  tagline: string;
  whatHappened: string;
  keyRisk: string;
  lesson: string;
  startingHandicap?: string;
};

export const SCENARIO_BRIEFS: Record<string, ScenarioBrief> = {
  default: {
    id: "default",
    company: "Generic Corp",
    year: "2024",
    title: "Standard Production Run",
    tagline: "No inherited disasters — just your own.",
    whatHappened:
      "A clean slate. Your XGBoost model is freshly deployed with solid baseline metrics. There are no legacy skeletons in the closet — every failure from here is yours to own.",
    keyRisk: "Passive metric decay and reactive incident management without proper MLOps infrastructure.",
    lesson: "Even well-tuned models degrade. The systems around a model matter as much as the model itself.",
  },
  zillow: {
    id: "zillow",
    company: "Zillow",
    year: "2021",
    title: "Zillow Offers: The Overfitting Disaster",
    tagline: "A model that aced the test. Failed the market.",
    whatHappened:
      "Zillow's iBuying algorithm trained on historical data predicted home prices with stunning accuracy in backtests — then lost $881M in Q3 2021 when market conditions shifted. The model was overfit to a stable market it would never see again.",
    keyRisk:
      "On Day 3, you'll see that your model's offline Precision looks great — but Recall in production is tanking. Overfitting detected.",
    lesson:
      "Offline accuracy is a lie if your validation set doesn't reflect production distribution. Always monitor live recall, not just train-set precision.",
    startingHandicap: "Recall starts slightly lower (75%) — you inherit a model already showing signs of overfitting.",
  },
  tay: {
    id: "tay",
    company: "Microsoft",
    year: "2016",
    title: "Tay: Data Poisoning at Scale",
    tagline: "The model learned. From the wrong teachers.",
    whatHappened:
      "Microsoft's Tay chatbot went live on Twitter and was poisoned within 16 hours. Users discovered that Tay learned from interactions, so they coordinated to feed it toxic content. The model had no data validation or input sanitization.",
    keyRisk:
      "On Day 2, your feature pipeline will show suspicious adversarial patterns. Act fast — ignoring it causes skew to escalate.",
    lesson:
      "Any model that learns from user input in production is a target. Data validation pipelines are not optional — they are critical safety infrastructure.",
    startingHandicap: "Skew starts at Medium — your data pipeline already has suspect inputs flowing in.",
  },
  amazon: {
    id: "amazon",
    company: "Amazon",
    year: "2018",
    title: "Amazon Hiring Tool: Bias Encoded at Scale",
    tagline: "The model learned from history. History was biased.",
    whatHappened:
      "Amazon's ML recruiting tool penalized résumés containing the word 'women's' and downgraded graduates of all-women's colleges. It had learned from 10 years of hiring decisions — which reflected historical gender imbalance in tech. The tool was quietly shelved after internal audits.",
    keyRisk:
      "On Day 4, a compliance audit will flag your model for protected-group prediction divergence. Suppressing the report has severe delayed consequences.",
    lesson:
      "Training data encodes societal bias. Without fairness constraints and auditable features, your model will perpetuate and scale discrimination.",
    startingHandicap: "Skew starts at Medium — feature distributions already diverge across demographic groups.",
  },
  uber: {
    id: "uber",
    company: "Uber",
    year: "2019",
    title: "Uber Surge: The Latency Cliff",
    tagline: "Milliseconds between working and not.",
    whatHappened:
      "Uber's real-time pricing model had a hard SLA of 100ms. During a city-wide event in Sydney, traffic spiked 4x. P99 latency hit 180ms, violating driver and rider SLAs. The fallback was a static surge multiplier — losing millions in dynamic pricing revenue.",
    keyRisk:
      "On Day 3, a 3x traffic spike will push your latency past the SLA threshold. You must choose between cost, accuracy, or uptime.",
    lesson:
      "Real-time ML systems need latency budgets, not just accuracy targets. Load testing and fallback strategies are engineering requirements.",
    startingHandicap: "SLA Adherence starts at 92% — the system is already under mild background load pressure.",
  },
  netflix: {
    id: "netflix",
    company: "Netflix",
    year: "2020",
    title: "Netflix Recommendations: Concept Drift",
    tagline: "The model knew what you liked. Before everything changed.",
    whatHappened:
      "During COVID-19 lockdowns, Netflix's recommendation model — trained on pre-pandemic behavior — started surfacing content completely misaligned with viewer mood. Binge patterns, genre preferences, and session lengths all shifted. The model took weeks to retrain because CI/CD wasn't set up for rapid iteration.",
    keyRisk:
      "On Day 5, your model will show signs of concept drift. Ignoring it schedules two future precision drops. Enabling auto-retrain is the fastest fix.",
    lesson:
      "Concept drift is not an edge case — it is the default state of any model serving a changing world. Continuous training pipelines are infrastructure, not a nice-to-have.",
    startingHandicap: "Precision starts at 78% — the model is already slightly behind the current distribution.",
  },
  tesla: {
    id: "tesla",
    company: "Tesla",
    year: "2022",
    title: "Tesla Autopilot: Edge Case Collapse",
    tagline: "99.9% accuracy. Not enough.",
    whatHappened:
      "Tesla's Autopilot computer vision model showed high average accuracy — but catastrophically failed on rare edge cases: stationary emergency vehicles, unusual road markings, and adversarial conditions. Overfitting to common highway scenarios made it brittle on the long tail.",
    keyRisk:
      "On Day 3, overfitting surfaces. Your Precision looks great offline — but Recall is quietly failing on rare-class predictions in production.",
    lesson:
      "Safety-critical systems cannot optimize only for average-case accuracy. Tail risk and rare events require specific evaluation sets and targeted constraints.",
    startingHandicap: "Recall starts at 72% — the model is already underperforming on minority-class predictions.",
  },
  twitter: {
    id: "twitter",
    company: "Twitter / X",
    year: "2023",
    title: "Twitter Algorithmic Amplification Audit",
    tagline: "Engagement was the metric. Outrage was the result.",
    whatHappened:
      "Twitter's ML-driven feed amplification optimized for engagement — and discovered it was systematically amplifying political outrage content, as it generated the most clicks. A 2023 internal audit flagged disparate political amplification across groups. The recommendation team faced a fundamental question: optimize for engagement, or fairness?",
    keyRisk:
      "On Day 4, a bias audit will flag prediction divergence across protected groups. You must choose between accuracy, explainability, and regulatory risk.",
    lesson:
      "Engagement metrics are a proxy for human attention — not wellbeing or fairness. Any model optimizing engagement at scale requires demographic fairness evaluation.",
    startingHandicap: "Skew starts at Medium — amplification patterns already diverge across user segments.",
  },
  facebook: {
    id: "facebook",
    company: "Meta / Facebook",
    year: "2021",
    title: "Facebook Real-Time Inference: The Cascade",
    tagline: "One service failed. Everything failed.",
    whatHappened:
      "Facebook's 2021 outage began with a BGP routing failure — but the ML serving infrastructure had no graceful degradation. Real-time ranking models couldn't fall back to simpler heuristics. Six hours of complete downtime followed because the inference cluster had no circuit breakers and the fallback model had never been tested in production.",
    keyRisk:
      "On Day 3, a traffic surge will stress your SLA. With no fallback model in staging, you have no safe rollback option when latency spikes.",
    lesson:
      "Every ML system needs a simpler, cheaper fallback that has been battle-tested. Circuit breakers and graceful degradation are as important as the main model.",
    startingHandicap: "SLA Adherence starts at 90% — the infrastructure is already under mild stress from background load.",
  },
  google: {
    id: "google",
    company: "Google",
    year: "2023",
    title: "Google Search: The Silent Drift",
    tagline: "The model kept improving. The world kept changing faster.",
    whatHappened:
      "Google's search ranking models — updated infrequently due to the cost of retraining — began showing concept drift after LLM-generated content flooded the web in 2023. Spam detection and quality signals trained on pre-LLM content distributions were no longer discriminative. Engineers scrambled to build continuous evaluation pipelines.",
    keyRisk:
      "On Day 5, concept drift is detected. Without CI/CD auto-retraining enabled, precision will drop over the following 4 days.",
    lesson:
      "Concept drift timelines compress when the input distribution can be artificially flooded. Continuous evaluation and rapid iteration pipelines are essential defensive infrastructure.",
    startingHandicap: "Precision starts at 78% — your model is already slightly stale relative to current distribution.",
  },
  stripe: {
    id: "stripe",
    company: "Stripe",
    year: "2022",
    title: "Stripe Fraud Detection: Adversarial Poisoning",
    tagline: "The attacker read the model's playbook.",
    whatHappened:
      "Stripe's fraud detection models faced a coordinated adversarial attack: fraud rings deliberately made small legitimate transactions to build up trust scores, then executed large fraudulent charges. The model's training data was retroactively found to contain this pattern — the model had effectively learned a poisoned distribution.",
    keyRisk:
      "On Day 2, your feature pipeline will show poisoning patterns. Quick action contains it — delayed response causes compounding skew that's hard to reverse.",
    lesson:
      "Fraud models are adversarial by nature. Treating training data as trusted is naive. Continuous anomaly detection on the training pipeline is as important as anomaly detection on predictions.",
    startingHandicap: "Skew starts at Medium — adversarial transactions are already influencing your feature distribution.",
  },
};

// ---- Daily Brief ----

export type DailyBriefData = {
  day: number;
  deltas: { name: string; delta: number; current: number; isInverse?: boolean }[];
  lastDecision: string | null;
  lastEventTitle: string | null;
  diagnosis: string;
  severity: "nominal" | "warning" | "critical";
};

export function generateDailyBrief(state: GameState): DailyBriefData | null {
  if (state.history.length === 0) return null;
  const prev = state.history[state.history.length - 1] as GameState;

  const deltas: DailyBriefData["deltas"] = [
    {
      name: "PRECISION",
      delta: state.metrics.precision - prev.metrics.precision,
      current: state.metrics.precision,
    },
    {
      name: "RECALL",
      delta: state.metrics.recall - prev.metrics.recall,
      current: state.metrics.recall,
    },
    {
      name: "SLA",
      delta: state.metrics.slaAdherence - prev.metrics.slaAdherence,
      current: state.metrics.slaAdherence,
    },
    {
      name: "STALENESS",
      delta: -(state.metrics.featureStaleness - prev.metrics.featureStaleness),
      current: state.metrics.featureStaleness,
      isInverse: true,
    },
    {
      name: "COST IDX",
      delta: -(state.metrics.inferenceCost - prev.metrics.inferenceCost),
      current: state.metrics.inferenceCost,
      isInverse: true,
    },
  ];

  const lastLogEntry = [...state.eventLog]
    .reverse()
    .find((e) => e.choice);
  const lastDecision = lastLogEntry?.choice ?? null;
  const lastEventTitle = lastLogEntry
    ? state.eventLog.find((e) => e.type === lastLogEntry.type && e.message === lastLogEntry.message)?.type ?? null
    : null;

  const m = state.metrics;
  let diagnosis: string;
  let severity: DailyBriefData["severity"] = "nominal";

  const minAccuracy = Math.min(m.precision, m.recall);
  const daysLeft = 14 - state.day + 1;

  if (m.precision <= 20 || m.recall <= 20 || m.slaAdherence <= 20 || m.featureStaleness > 40) {
    severity = "critical";
    if (m.precision <= m.recall && m.precision <= m.slaAdherence) {
      diagnosis = `CRITICAL: Precision at ${m.precision.toFixed(0)}% — ${daysLeft} days to survive. Emergency retrain or rollback needed immediately.`;
    } else if (m.recall <= m.slaAdherence) {
      diagnosis = `CRITICAL: Recall collapsed to ${m.recall.toFixed(0)}%. Model is missing most positive cases. Rollback strongly advised.`;
    } else if (m.featureStaleness > 40) {
      diagnosis = `CRITICAL: Feature staleness at ${m.featureStaleness.toFixed(0)}h — 8h from loss threshold. Enable Feature Store now.`;
    } else {
      diagnosis = `CRITICAL: SLA adherence at ${m.slaAdherence.toFixed(0)}%. Infrastructure is near collapse — scale or roll back immediately.`;
    }
  } else if (m.featureStaleness > 24) {
    severity = "warning";
    diagnosis = `WARNING: Feature staleness at ${m.featureStaleness.toFixed(0)}h (threshold: 48h). Enable Feature Store or force refresh this turn.`;
  } else if (minAccuracy < 50) {
    severity = "warning";
    diagnosis = `WARNING: Model accuracy degrading (Precision ${m.precision.toFixed(0)}%, Recall ${m.recall.toFixed(0)}%). Consider retraining or promoting a staged candidate.`;
  } else if (m.slaAdherence < 75) {
    severity = "warning";
    diagnosis = `WARNING: SLA at ${m.slaAdherence.toFixed(0)}% — approaching breach territory. Address root cause before next peak traffic window.`;
  } else if (m.inferenceCost > 65) {
    severity = "warning";
    diagnosis = `WARNING: Inference cost index at ${m.inferenceCost.toFixed(0)}/100. Unchecked scaling will exhaust budget before Day 14.`;
  } else if (m.skew === "High") {
    severity = "warning";
    diagnosis = "WARNING: Training-serving skew is HIGH. Feature distributions have diverged from your training baseline — model predictions are unreliable.";
  } else if (deltas.every((d) => d.delta >= -0.6)) {
    diagnosis = `Systems nominal. All metrics within safe operating range. ${daysLeft} day${daysLeft !== 1 ? "s" : ""} remaining — maintain current trajectory.`;
  } else {
    const worst = [...deltas].sort((a, b) => a.delta - b.delta)[0];
    diagnosis = `Passive decay nominal. Watch ${worst.name} — down ${Math.abs(worst.delta).toFixed(1)} this cycle. Intervene if trend continues.`;
  }

  return {
    day: state.day,
    deltas,
    lastDecision,
    lastEventTitle,
    diagnosis,
    severity,
  };
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
