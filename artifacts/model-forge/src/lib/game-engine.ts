import { GameState } from "./game-types";

export type Choice = {
  id: string;
  label: string;
  effect: (s: GameState) => void;
};

export type GameEvent = {
  id: string;
  eventType?: "overfitting" | "poisoning" | "bias" | "latency" | "drift" | "triggered" | "random";
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

  s.history.push(JSON.parse(JSON.stringify(s)));
  if (s.history.length > 20) s.history = s.history.slice(-20);

  s.day += 1;

  // Passive decay
  s.metrics.precision = Math.max(0, s.metrics.precision - 1);
  s.metrics.recall = Math.max(0, s.metrics.recall - 1);
  s.metrics.featureStaleness = s.featureStore.enabled ? 2 : s.metrics.featureStaleness + 2;
  s.metrics.slaAdherence = Math.max(0, s.metrics.slaAdherence - 0.5);

  if (s.ciCd.autoRetrain) {
    s.metrics.precision = Math.min(100, s.metrics.precision + 2);
    // Retraining runs consume compute — reflected in cost index
    s.metrics.inferenceCost = Math.min(100, s.metrics.inferenceCost + 2);
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

  // ---- Scenario-specific unique events ----

  // ZILLOW: Regression overfitting — backtest vs live error divergence
  if (sc === "zillow" && d === 3) {
    return {
      id: "zillow_overfit",
      eventType: "overfitting",
      title: "BACKTEST vs. LIVE ERROR DIVERGENCE",
      description:
        "Your model's offline validation error looked acceptable — but live prediction error is 5x higher. The model is overfit to stable historical market patterns that no longer hold in a volatile market.",
      choices: [
        {
          id: "A",
          label: "Apply L2 regularization and retrain on recent market data",
          effect: (s) => {
            s.metrics.precision -= 8;
            s.metrics.recall += 5;
            s.metrics.skew = "Low";
            s.registry.models.push({
              id: "model_v2",
              type: "Linear",
              version: "2.0",
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_regularized",
              accuracy: 74,
              cost: 0.05,
              latency: 8,
              explainability: "High",
            });
          },
        },
        {
          id: "B",
          label: "Collect 90 days of recent transaction data and schedule retrain",
          effect: (s) => {
            s.metrics.inferenceCost += 5;
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "precision",
              delta: 12,
              message: "Fresh-data retrain corrected live error distribution",
            });
          },
        },
        {
          id: "C",
          label: "Ignore — offline metrics show the model is fine",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: -10, message: "Overfitting to stable market caused live accuracy to collapse" },
              { triggerDay: s.day + 3, metric: "recall", delta: -8, message: "Unaddressed overfitting — model fails on new market patterns" }
            );
          },
        },
      ],
    };
  }

  // TESLA: Computer vision edge-case collapse
  if (sc === "tesla" && d === 3) {
    return {
      id: "tesla_edge_case",
      eventType: "overfitting",
      title: "EDGE CASE COLLAPSE: RARE ROAD EVENTS",
      description:
        "Average-case accuracy is 99.1% — but the model catastrophically fails on stationary emergency vehicles and unusual road markings. Recall on rare-class events has silently degraded in production.",
      choices: [
        {
          id: "A",
          label: "Train on dedicated edge-case dataset with synthetic rare events",
          effect: (s) => {
            s.metrics.recall += 18;
            s.metrics.inferenceCost += 8;
            s.registry.models.push({
              id: "model_v2",
              type: "Ensemble",
              version: "2.0",
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_edge_cases",
              accuracy: 91,
              cost: 0.18,
              latency: 22,
              explainability: "Medium",
            });
          },
        },
        {
          id: "B",
          label: "Ensemble with rule-based fallback for flagged rare-class inputs",
          effect: (s) => {
            s.metrics.recall += 10;
            s.metrics.precision -= 3;
          },
        },
        {
          id: "C",
          label: "Average accuracy is 99.1% — this is within acceptable safety range",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "recall", delta: -15, message: "Rare-class failures escalated — edge cases now common in production" },
              { triggerDay: s.day + 4, metric: "slaAdherence", delta: -12, message: "Regulators flagged safety-critical rare-class failures" }
            );
          },
        },
      ],
    };
  }

  // TAY: Real-time online learning poisoning (generative model)
  if (sc === "tay" && d === 2) {
    return {
      id: "tay_online_poisoning",
      eventType: "poisoning",
      title: "REAL-TIME ONLINE LEARNING POISONING",
      description:
        "Your model learns directly from live user inputs in real-time. Coordinated users are injecting adversarial content. Output coherence is degrading as toxic patterns are reinforced with each new incoming batch.",
      choices: [
        {
          id: "A",
          label: "Disable online learning — switch to hourly offline retrain cycle",
          effect: (s) => {
            s.metrics.precision += 5;
            s.metrics.skew = "Low";
            s.metrics.featureStaleness += 6;
          },
        },
        {
          id: "B",
          label: "Add adversarial input filter and content validation layer",
          effect: (s) => {
            s.metrics.precision += 8;
            s.featureStore.enabled = true;
            s.metrics.featureStaleness = 1;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "C",
          label: "Rate-limit suspicious users and monitor for 24 hours",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "skewLevel", delta: 1, message: "Online poisoning escalated — output skew now CRITICAL" },
              { triggerDay: s.day + 3, metric: "precision", delta: -10, message: "Adversarial patterns now dominant in model outputs" }
            );
          },
        },
      ],
    };
  }

  // STRIPE: Coordinated trust-score manipulation (fraud classification)
  if (sc === "stripe" && d === 2) {
    return {
      id: "stripe_trust_poisoning",
      eventType: "poisoning",
      title: "COORDINATED TRUST-SCORE MANIPULATION",
      description:
        "Fraud rings made hundreds of small legitimate transactions to inflate trust scores before executing large fraudulent charges. Retroactive analysis shows training data encodes this pattern — your classifier learned a poisoned distribution.",
      choices: [
        {
          id: "A",
          label: "Deploy velocity anomaly detection on transaction sequences",
          effect: (s) => {
            s.featureStore.enabled = true;
            s.metrics.featureStaleness = 1;
            s.metrics.skew = "Low";
            s.metrics.precision += 5;
          },
        },
        {
          id: "B",
          label: "Add temporal consistency validation to the training pipeline",
          effect: (s) => {
            s.metrics.precision += 8;
            s.metrics.skew = "Low";
            s.metrics.inferenceCost += 3;
          },
        },
        {
          id: "C",
          label: "Raise fraud detection threshold to flag more transactions",
          effect: (s) => {
            s.metrics.precision += 10;
            s.metrics.recall -= 12;
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "precision",
              delta: -8,
              message: "Fraud rings adapted to the raised threshold — precision eroded as false negatives accumulated",
            });
          },
        },
      ],
    };
  }

  // AMAZON: Demographic disparity in hiring scores (classification bias)
  if (sc === "amazon" && d === 4) {
    return {
      id: "amazon_demographic_bias",
      eventType: "bias",
      title: "DEMOGRAPHIC DISPARITY IN MODEL SCORES",
      description:
        "Your model gives systematically lower scores to résumés containing women-associated terms. Disparate impact ratio is 0.61 — below the 0.8 legal threshold. The compliance team is escalating to executive leadership.",
      choices: [
        {
          id: "A",
          label: "Remove proxy demographic features from the training data",
          effect: (s) => {
            s.metrics.precision -= 8;
            s.metrics.recall -= 3;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "B",
          label: "Reweight training labels to balance outcomes across demographic groups",
          effect: (s) => {
            s.metrics.precision -= 3;
            s.metrics.skew = "Low";
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "C",
          label: "Suppress the report — the model reflects historical hiring patterns",
          effect: (s) => {
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "slaAdherence",
              delta: -28,
              message: "Regulatory intervention — compliance audit forced model shutdown",
            });
          },
        },
      ],
    };
  }

  // TWITTER: Political amplification disparity (ranking bias)
  if (sc === "twitter" && d === 4) {
    return {
      id: "twitter_amplification_bias",
      eventType: "bias",
      title: "POLITICAL AMPLIFICATION DISPARITY AUDIT",
      description:
        "Internal audit reveals your engagement-optimized ranking algorithm amplifies one political group's content 18% more than another. Engagement is up — but the disparity is triggering regulatory inquiry and advertiser pullback.",
      choices: [
        {
          id: "A",
          label: "Add political diversity constraint to the ranking objective",
          effect: (s) => {
            s.metrics.precision -= 5;
            s.metrics.recall += 3;
            s.metrics.skew = "Low";
          },
        },
        {
          id: "B",
          label: "Audit and reweight training data for political content balance",
          effect: (s) => {
            s.metrics.skew = "Low";
            s.metrics.inferenceCost += 8;
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "precision",
              delta: 5,
              message: "Rebalanced training data improved ranking fairness",
            });
          },
        },
        {
          id: "C",
          label: "Engagement is the objective — keep maximizing it",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "skewLevel", delta: 1, message: "Amplification disparity widened — major advertisers pausing spend" },
              { triggerDay: s.day + 3, metric: "slaAdherence", delta: -22, message: "Regulatory sanction imposed — enforcement action against platform" }
            );
          },
        },
      ],
    };
  }

  // UBER: Neural Network inference latency crisis
  if (sc === "uber" && d === 3) {
    return {
      id: "uber_latency_crisis",
      eventType: "latency",
      title: "INFERENCE LATENCY CRISIS: P99 = 180ms",
      description:
        "A city-wide event caused a 4x traffic spike. Your Neural Network's P99 inference latency hit 180ms — violating the 100ms SLA. Surge pricing predictions are delayed. Every second of latency costs dynamic pricing revenue.",
      choices: [
        {
          id: "A",
          label: "Fall back to XGBoost (35ms P99, slightly lower accuracy)",
          effect: (s) => {
            s.metrics.precision -= 8;
            s.metrics.recall -= 5;
            s.metrics.slaAdherence += 12;
            s.registry.models.push({
              id: "model_xgb_fallback",
              type: "XGBoost",
              version: "1.1",
              stage: "production",
              trainedOnDay: s.day,
              dataVersion: "dataset_latest",
              accuracy: 79,
              cost: 0.06,
              latency: 35,
              explainability: "Medium",
            });
            s.registry.productionModelId = "model_xgb_fallback";
          },
        },
        {
          id: "B",
          label: "Scale inference cluster to 2x replicas (+100% infra cost)",
          effect: (s) => {
            s.metrics.inferenceCost = Math.min(100, s.metrics.inferenceCost * 2 + 5);
            s.metrics.slaAdherence += 15;
          },
        },
        {
          id: "C",
          label: "Do nothing — traffic will drop after the event ends",
          effect: (s) => {
            s.metrics.slaAdherence -= 20;
            s.futureEffects.push({
              triggerDay: s.day + 1,
              metric: "slaAdherence",
              delta: -15,
              message: "Peak traffic sustained — SLA violations compounded across the city",
            });
          },
        },
      ],
    };
  }

  // FACEBOOK: BGP routing failure — no ML graceful degradation
  if (sc === "facebook" && d === 3) {
    return {
      id: "facebook_cascade_failure",
      eventType: "latency",
      title: "BGP ROUTING FAILURE — INFERENCE UNREACHABLE",
      description:
        "A BGP misconfiguration has made your ML serving cluster unreachable. There is no pre-warmed fallback model in staging. Feed ranking and content recommendations have been offline for 47 minutes with no circuit breaker in place.",
      choices: [
        {
          id: "A",
          label: "Deploy lightweight rule-based heuristic fallback immediately",
          effect: (s) => {
            s.metrics.precision -= 15;
            s.metrics.slaAdherence += 20;
            s.registry.models.push({
              id: "model_heuristic_fallback",
              type: "Linear",
              version: "0.1",
              stage: "production",
              trainedOnDay: 0,
              dataVersion: "rules_v1",
              accuracy: 60,
              cost: 0.01,
              latency: 5,
              explainability: "High",
            });
            s.registry.productionModelId = "model_heuristic_fallback";
          },
        },
        {
          id: "B",
          label: "Implement circuit breaker — serve cached predictions from last hour",
          effect: (s) => {
            s.metrics.slaAdherence += 12;
            s.metrics.recall -= 8;
          },
        },
        {
          id: "C",
          label: "Wait for BGP routing to self-heal — this is transient",
          effect: (s) => {
            s.metrics.slaAdherence -= 25;
            s.futureEffects.push({
              triggerDay: s.day + 1,
              metric: "slaAdherence",
              delta: -15,
              message: "BGP failure persisted — six-hour total outage recorded",
            });
          },
        },
      ],
    };
  }

  // NETFLIX: Gradual concept drift from COVID behavioral shift
  if (sc === "netflix" && d === 5) {
    return {
      id: "netflix_gradual_drift",
      eventType: "drift",
      title: "GRADUAL CONCEPT DRIFT: VIEWING BEHAVIOR SHIFT",
      description:
        "COVID lockdowns shifted viewing patterns from short commute-hour sessions to multi-hour binge sessions. Recommendation signals trained on pre-lockdown behavior are misaligned. Viewer satisfaction scores are quietly declining.",
      choices: [
        {
          id: "A",
          label: "Enable CI/CD auto-retraining on a rolling 14-day engagement window",
          effect: (s) => {
            s.ciCd.autoRetrain = true;
            s.metrics.precision += 3;
          },
        },
        {
          id: "B",
          label: "Manual retrain with last 14 days of session and engagement data",
          effect: (s) => {
            s.metrics.precision += 10;
            s.metrics.recall += 8;
            s.registry.models.push({
              id: `model_v${s.day}`,
              type: "Neural Network",
              version: `${s.day}.0`,
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_covid_behavior",
              accuracy: 89,
              cost: 0.18,
              latency: 25,
              explainability: "Low",
            });
          },
        },
        {
          id: "C",
          label: "Drift is small — viewing behavior will normalize on its own",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: -5, message: "Gradual drift degraded recommendation ranking quality" },
              { triggerDay: s.day + 4, metric: "precision", delta: -5, message: "Severe drift — recommendations rated poor by 30%+ of users" }
            );
          },
        },
      ],
    };
  }

  // GOOGLE: Sudden LLM content flood — abrupt distribution shift
  if (sc === "google" && d === 5) {
    return {
      id: "google_llm_flood",
      eventType: "drift",
      title: "LLM CONTENT FLOOD — QUALITY SIGNALS COLLAPSE",
      description:
        "Overnight, 40% of indexed web content is AI-generated. Your content quality classifiers — trained before LLMs existed — can no longer discriminate spam from genuine content. Quality signals that took years to build are now non-discriminative.",
      choices: [
        {
          id: "A",
          label: "Train dedicated LLM-content classifier and integrate into pipeline",
          effect: (s) => {
            s.metrics.precision += 12;
            s.metrics.inferenceCost += 15;
            s.registry.models.push({
              id: `model_llm_detector_v${s.day}`,
              type: "Neural Network",
              version: `${s.day}.0`,
              stage: "staging",
              trainedOnDay: s.day,
              dataVersion: "dataset_llm_content",
              accuracy: 88,
              cost: 0.22,
              latency: 28,
              explainability: "Low",
            });
          },
        },
        {
          id: "B",
          label: "Ensemble existing model with lightweight LLM-pattern detector",
          effect: (s) => {
            s.metrics.precision += 7;
            s.metrics.recall += 5;
            s.metrics.inferenceCost += 8;
          },
        },
        {
          id: "C",
          label: "Keep existing pipeline — signal quality may improve naturally",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 1, metric: "precision", delta: -8, message: "LLM content flood overwhelmed all quality signals" },
              { triggerDay: s.day + 3, metric: "recall", delta: -8, message: "Spam recall collapsed — LLM content evades all existing filters" }
            );
          },
        },
      ],
    };
  }

  // ---- Triggered events (universal — checked after scenario-specific events) ----

  if (state.metrics.precision < 60) {
    return {
      id: "low_accuracy",
      eventType: "triggered",
      title: "CRITICAL: MODEL QUALITY DEGRADED",
      description:
        "Your model's primary quality metric has dropped below 60%. Prediction quality is critically degraded in production — immediate action required.",
      choices: [
        {
          id: "A",
          label: "Emergency retrain on latest data",
          effect: (s) => {
            s.metrics.precision += 20;
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "B",
          label: "Rollback to last stable checkpoint",
          effect: (s) => {
            s.metrics.precision = Math.max(s.metrics.precision + 15, 72);
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
              message: "Stakeholders escalated quality degradation — SLA breach incoming",
            });
          },
        },
      ],
    };
  }

  if (state.metrics.featureStaleness > 24) {
    return {
      id: "stale_features",
      eventType: "triggered",
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
      eventType: "triggered",
      title: "SLA BREACH",
      description: "SLA adherence dropped below 80%. Multiple customers report degraded service. Escalations incoming.",
      choices: [
        {
          id: "A",
          label: "Execute emergency service recovery",
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

  // ---- Random daily events pool ----
  const pool: GameEvent[] = [
    {
      id: "rand_upstream_delay",
      eventType: "random",
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
      eventType: "random",
      title: "A/B TEST RESULTS",
      description: "Canary model showing 5% quality improvement on 10% of live traffic. Ready to promote?",
      choices: [
        {
          id: "A",
          label: "Promote canary to production",
          effect: (s) => {
            s.metrics.recall += 5;
            const newId = `model_v${s.day}`;
            const canaryType = ["tesla", "netflix", "google", "tay", "facebook"].includes(s.scenario)
              ? "Neural Network"
              : "XGBoost";
            s.registry.models.push({ id: newId, type: canaryType, version: `${s.day}.0`, stage: "production", trainedOnDay: s.day, dataVersion: "dataset_latest", accuracy: 87, cost: 0.1, latency: 15, explainability: "Medium" });
            s.registry.productionModelId = newId;
          },
        },
        { id: "B", label: "Run experiment longer", effect: (_s) => {} },
        { id: "C", label: "Roll back canary", effect: (_s) => {} },
      ],
    },
    {
      id: "rand_new_dataset",
      eventType: "random",
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
            const retrainType = ["tesla", "netflix", "google", "tay", "facebook"].includes(s.scenario)
              ? "Neural Network"
              : "XGBoost";
            s.registry.models.push({ id: newId, type: retrainType, version: `${s.day}.0`, stage: "staging", trainedOnDay: s.day, dataVersion: "dataset_2025Q2", accuracy: 88, cost: 0.1, latency: 15, explainability: "Medium" });
          },
        },
        {
          id: "B",
          label: "Schedule for next sprint",
          effect: (s) => {
            s.futureEffects.push({ triggerDay: s.day + 3, metric: "precision", delta: 5, message: "Scheduled retrain on fresh data improved model quality" });
          },
        },
        { id: "C", label: "Skip — current model is good enough", effect: (_s) => {} },
      ],
    },
    {
      id: "rand_gpu_interrupt",
      eventType: "random",
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
      eventType: "random",
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
      eventType: "random",
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
      eventType: "random",
      title: "DATA QUALITY ALERT",
      description: "Monitor detected an unusual spike in missing or corrupted values in the last inference batch.",
      choices: [
        { id: "A", label: "Investigate and fix upstream data pipeline", effect: (s) => { s.metrics.featureStaleness = 3; } },
        { id: "B", label: "Apply data imputation strategy", effect: (s) => { s.metrics.precision -= 3; } },
        { id: "C", label: "Ignore — likely a blip", effect: (s) => { s.metrics.skew = s.metrics.skew === "Low" ? "Medium" : "High"; } },
      ],
    },
    {
      id: "rand_explainability",
      eventType: "random",
      title: "LEGAL EXPLAINABILITY REQUEST",
      description: "Legal team requires model explainability report for a pending audit within 48 hours.",
      choices: [
        { id: "A", label: "Generate model explainability report", effect: (s) => { s.metrics.inferenceCost += 5; } },
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
  problemType: "classification" | "regression" | "ranking" | "generative";
  metricLabels: { precision: string; recall: string };
  briefLabels: { precision: string; recall: string };
};

export const SCENARIO_BRIEFS: Record<string, ScenarioBrief> = {
  default: {
    id: "default",
    company: "Generic Corp",
    year: "2024",
    title: "Standard Production Run",
    tagline: "No inherited disasters — just your own.",
    whatHappened:
      "A clean slate. Your XGBoost classifier is freshly deployed with solid baseline metrics. There are no legacy skeletons in the closet — every failure from here is yours to own.",
    keyRisk: "Passive metric decay and reactive incident management without proper MLOps infrastructure.",
    lesson: "Even well-tuned models degrade. The systems around a model matter as much as the model itself.",
    problemType: "classification",
    metricLabels: { precision: "Precision", recall: "Recall" },
    briefLabels: { precision: "PREC", recall: "REC" },
  },
  zillow: {
    id: "zillow",
    company: "Zillow",
    year: "2021",
    title: "Zillow Offers: The Overfitting Disaster",
    tagline: "A model that aced the test. Failed the market.",
    whatHappened:
      "Zillow's iBuying algorithm predicted home prices with apparently high accuracy in backtests — then lost $881M in Q3 2021 when market conditions shifted. The regression model was overfit to a stable, low-volatility market it would never see again. Validation data didn't reflect the distribution the model would face in production.",
    keyRisk:
      "On Day 3, your live prediction error will be revealed as 5x worse than offline validation suggested. The model is overfit to historical market stability.",
    lesson:
      "Offline accuracy metrics are unreliable if your validation set doesn't reflect production distribution. Always monitor live error, not just held-out test metrics.",
    startingHandicap: "Coverage index starts at 75% — you inherit a model already showing signs of distribution mismatch on recent market data.",
    problemType: "regression",
    metricLabels: { precision: "Accuracy Index", recall: "Coverage Index" },
    briefLabels: { precision: "ACC", recall: "COV" },
  },
  tay: {
    id: "tay",
    company: "Microsoft",
    year: "2016",
    title: "Tay: Online Learning Poisoning",
    tagline: "The model learned. From the wrong teachers.",
    whatHappened:
      "Microsoft's Tay chatbot went live on Twitter and was poisoned within 16 hours. The model used real-time online learning — updating its parameters directly from incoming user messages. Users coordinated to feed it toxic content at scale. With no input validation or content filtering, the model reinforced adversarial patterns as if they were signal.",
    keyRisk:
      "On Day 2, your real-time learning pipeline will surface poisoning patterns. Disabling online learning or adding content validation stops the cascade. Waiting causes coherence to collapse.",
    lesson:
      "Any model that updates from live user input in production is an adversarial target. Real-time online learning requires adversarial input validation as a prerequisite, not an afterthought.",
    startingHandicap: "Output distribution skew starts at Medium — adversarial inputs are already influencing your model's pattern space.",
    problemType: "generative",
    metricLabels: { precision: "Coherence", recall: "Safety Score" },
    briefLabels: { precision: "COH", recall: "SAFE" },
  },
  amazon: {
    id: "amazon",
    company: "Amazon",
    year: "2018",
    title: "Amazon Hiring Tool: Bias Encoded at Scale",
    tagline: "The model learned from history. History was biased.",
    whatHappened:
      "Amazon's ML recruiting tool penalized résumés containing the word 'women's' and downgraded graduates of all-women's colleges. It had learned from 10 years of historical hiring decisions that reflected gender imbalance in tech. Removing proxy features like college name didn't fully solve the problem — the bias was encoded in the training labels themselves.",
    keyRisk:
      "On Day 4, a compliance audit will flag disparate impact against a protected group. The correct fix is removing biased training features or reweighting labels — not switching model architectures. Suppressing the audit has severe delayed consequences.",
    lesson:
      "Training data encodes societal bias. Fairness requires auditing and correcting training labels and features — not just swapping model architectures. Simpler models can be equally biased.",
    startingHandicap: "Output distribution skew starts at Medium — feature distributions already diverge across demographic groups in the training data.",
    problemType: "classification",
    metricLabels: { precision: "Precision", recall: "Recall" },
    briefLabels: { precision: "PREC", recall: "REC" },
  },
  uber: {
    id: "uber",
    company: "Uber",
    year: "2019",
    title: "Uber Surge: The Latency Cliff",
    tagline: "Milliseconds between working and not.",
    whatHappened:
      "Uber's real-time surge pricing Neural Network had a hard SLA of 100ms. During a city-wide event in Sydney, traffic spiked 4x. P99 latency hit 180ms, violating driver and rider SLAs. The fallback was a static surge multiplier — losing millions in dynamic pricing revenue because no pre-warmed simpler model was ready.",
    keyRisk:
      "On Day 3, a 4x traffic spike will push your Neural Network past the latency SLA. Falling back to XGBoost restores speed but costs accuracy; scaling the cluster doubles infra cost.",
    lesson:
      "Real-time ML systems need latency budgets, not just accuracy targets. Load testing, pre-warmed fallback models, and autoscaling are engineering requirements — not nice-to-haves.",
    startingHandicap: "SLA Adherence starts at 92% — the system is already under mild background load pressure from city traffic patterns.",
    problemType: "regression",
    metricLabels: { precision: "Demand Index", recall: "Surge Coverage" },
    briefLabels: { precision: "DMND", recall: "SRGE" },
  },
  netflix: {
    id: "netflix",
    company: "Netflix",
    year: "2020",
    title: "Netflix Recommendations: Concept Drift",
    tagline: "The model knew what you liked. Before everything changed.",
    whatHappened:
      "During COVID-19 lockdowns, Netflix's recommendation model — trained on pre-pandemic behavior — started surfacing content misaligned with viewer mood. Binge patterns, genre preferences, and session lengths all shifted dramatically. The model took weeks to retrain because CI/CD wasn't set up for rapid iteration on the recommendation pipeline.",
    keyRisk:
      "On Day 5, gradual concept drift will surface as viewer behavior shifts. Ignoring it schedules two future ranking quality drops. Enabling auto-retraining is the fastest mitigation.",
    lesson:
      "Concept drift is the default state of any model serving a changing world. Continuous training pipelines are infrastructure, not a nice-to-have.",
    startingHandicap: "Ranking quality (NDCG index) starts at 78% — the model is already slightly behind the current user behavior distribution.",
    problemType: "ranking",
    metricLabels: { precision: "NDCG Index", recall: "MAP Index" },
    briefLabels: { precision: "NDCG", recall: "MAP" },
  },
  tesla: {
    id: "tesla",
    company: "Tesla",
    year: "2022",
    title: "Tesla Autopilot: Edge Case Collapse",
    tagline: "99.9% accuracy. Not enough.",
    whatHappened:
      "Tesla's Autopilot computer vision model showed high average accuracy — but catastrophically failed on rare edge cases: stationary emergency vehicles, unusual road markings, and adversarial conditions. Optimizing for average-case mAP on common highway scenarios made the model brittle on the long tail of rare events that matter most for safety.",
    keyRisk:
      "On Day 3, rare-class recall failures surface in production. The fix requires targeted training on synthetic edge-case data or a rule-based ensemble — not just retraining on more of the same distribution.",
    lesson:
      "Safety-critical computer vision systems cannot optimize only for average-case accuracy. Tail risk and rare events require specific evaluation sets, dedicated training data, and targeted coverage constraints.",
    startingHandicap: "Rare-class detection recall starts at 72% — the model is already missing a significant portion of rare road-event classes in production.",
    problemType: "classification",
    metricLabels: { precision: "Detection Precision", recall: "Detection Recall" },
    briefLabels: { precision: "DET-P", recall: "DET-R" },
  },
  twitter: {
    id: "twitter",
    company: "Twitter / X",
    year: "2023",
    title: "Twitter Algorithmic Amplification Audit",
    tagline: "Engagement was the metric. Outrage was the result.",
    whatHappened:
      "Twitter's ML-driven feed ranking optimized for engagement — and a 2023 internal audit found it was systematically amplifying one political group's content 18% more than another. The model had never been evaluated for political neutrality. Maximizing engagement as a proxy for user satisfaction produced unintended demographic amplification at scale.",
    keyRisk:
      "On Day 4, an amplification audit will flag political content disparity. The fix requires adding fairness constraints to the ranking objective or rebalancing training data — not just switching model architectures.",
    lesson:
      "Engagement metrics are a proxy for attention — not fairness or wellbeing. Any ranking model optimizing engagement at scale requires demographic fairness evaluation as part of standard model review.",
    startingHandicap: "Feed distribution skew starts at Medium — amplification patterns already diverge across user segments in the current ranking model.",
    problemType: "ranking",
    metricLabels: { precision: "Engagement Score", recall: "Reach Index" },
    briefLabels: { precision: "ENGS", recall: "REAC" },
  },
  facebook: {
    id: "facebook",
    company: "Meta / Facebook",
    year: "2021",
    title: "Facebook Real-Time Inference: The Cascade",
    tagline: "One service failed. Everything failed.",
    whatHappened:
      "Facebook's 2021 outage began with a BGP routing misconfiguration that made the ML serving infrastructure unreachable. The real-time ranking models had no graceful degradation path — no pre-warmed fallback model in staging, no circuit breakers. Six hours of complete downtime followed because the system had never been tested without the main model.",
    keyRisk:
      "On Day 3, a BGP routing failure will take your serving cluster offline. With no fallback model in staging, you must choose between deploying an untested heuristic, serving cached predictions, or waiting — each with major SLA consequences.",
    lesson:
      "Every ML system needs a simpler, cheaper fallback that has been battle-tested in production. Circuit breakers and graceful degradation are as important as the main model.",
    startingHandicap: "SLA Adherence starts at 90% — the infrastructure is already under mild stress from background load on the serving cluster.",
    problemType: "ranking",
    metricLabels: { precision: "Relevance Score", recall: "Feed Recall" },
    briefLabels: { precision: "RLVN", recall: "FEED" },
  },
  google: {
    id: "google",
    company: "Google",
    year: "2023",
    title: "Google Search: The Silent Drift",
    tagline: "The model kept improving. The world kept changing faster.",
    whatHappened:
      "Google's search quality and spam detection models — trained on pre-LLM web content — began showing concept drift in 2023 when LLM-generated content flooded the web. Spam detection signals and content quality classifiers trained on human-written content distributions could no longer discriminate. Engineers scrambled to build continuous evaluation and rapid retraining pipelines.",
    keyRisk:
      "On Day 5, a sudden LLM content flood will collapse your quality signals. Unlike Netflix's gradual drift, this is a sudden, adversarially-induced distribution shift. Waiting compounds the damage significantly.",
    lesson:
      "Concept drift timelines compress when the input distribution can be deliberately flooded. Continuous evaluation, rapid retraining pipelines, and ensemble-based adaptation are essential defensive infrastructure.",
    startingHandicap: "Ranking quality (NDCG index) starts at 78% — your model is already slightly stale relative to the current web content distribution.",
    problemType: "ranking",
    metricLabels: { precision: "NDCG Index", recall: "MAP Index" },
    briefLabels: { precision: "NDCG", recall: "MAP" },
  },
  stripe: {
    id: "stripe",
    company: "Stripe",
    year: "2022",
    title: "Stripe Fraud Detection: Adversarial Poisoning",
    tagline: "The attacker read the model's playbook.",
    whatHappened:
      "Stripe's fraud detection classifier faced a coordinated adversarial attack: fraud rings deliberately made hundreds of small legitimate transactions to build up trust scores, then executed large fraudulent charges. The model's training data was retroactively found to encode this pattern — the classifier had learned from a poisoned distribution where high trust scores correlated with eventual fraud.",
    keyRisk:
      "On Day 2, your fraud detection pipeline will surface trust-score manipulation patterns. Unlike Tay's online poisoning, this is batch-training data corruption. Velocity anomaly detection and temporal consistency validation are the correct mitigations.",
    lesson:
      "Fraud models are adversarial by nature. Treating training data as trusted is naive. Continuous anomaly detection on the training pipeline is as important as anomaly detection on predictions.",
    startingHandicap: "Prediction distribution skew starts at Medium — adversarial transactions have already influenced your trust-score feature distribution.",
    problemType: "classification",
    metricLabels: { precision: "Precision", recall: "Recall" },
    briefLabels: { precision: "PREC", recall: "REC" },
  },
};

// ---- Metric label helper ----

export function getMetricLabels(scenario: string): { precision: string; recall: string } {
  return SCENARIO_BRIEFS[scenario]?.metricLabels ?? { precision: "Precision", recall: "Recall" };
}

export function getProblemType(scenario: string): ScenarioBrief["problemType"] {
  return SCENARIO_BRIEFS[scenario]?.problemType ?? "classification";
}

// ---- Event color helper ----

export function getEventColor(eventType?: GameEvent["eventType"]): string {
  switch (eventType) {
    case "overfitting": return "border-orange-400/60";
    case "poisoning":   return "border-red-500/60";
    case "bias":        return "border-purple-500/60";
    case "latency":     return "border-yellow-400/60";
    case "drift":       return "border-blue-400/60";
    case "triggered":   return "border-destructive/50";
    default:            return "border-primary/60";
  }
}

export function getEventTypeLabel(eventType?: GameEvent["eventType"]): string {
  switch (eventType) {
    case "overfitting": return "OVERFITTING";
    case "poisoning":   return "DATA POISONING";
    case "bias":        return "BIAS / FAIRNESS";
    case "latency":     return "LATENCY";
    case "drift":       return "CONCEPT DRIFT";
    case "triggered":   return "TRIGGERED";
    default:            return "INCIDENT";
  }
}

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

  const labels = getMetricLabels(state.scenario);
  const brief = SCENARIO_BRIEFS[state.scenario];
  const briefP = brief?.briefLabels?.precision ?? labels.precision.slice(0, 4).toUpperCase();
  const briefR = brief?.briefLabels?.recall ?? labels.recall.slice(0, 4).toUpperCase();

  const deltas: DailyBriefData["deltas"] = [
    {
      name: briefP,
      delta: state.metrics.precision - prev.metrics.precision,
      current: state.metrics.precision,
    },
    {
      name: briefR,
      delta: state.metrics.recall - prev.metrics.recall,
      current: state.metrics.recall,
    },
    {
      name: "SLA",
      delta: state.metrics.slaAdherence - prev.metrics.slaAdherence,
      current: state.metrics.slaAdherence,
    },
    {
      name: "STALE",
      delta: -(state.metrics.featureStaleness - prev.metrics.featureStaleness),
      current: state.metrics.featureStaleness,
      isInverse: true,
    },
    {
      name: "COST",
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
      diagnosis = `CRITICAL: ${labels.precision} at ${m.precision.toFixed(0)}% — ${daysLeft} days to survive. Emergency retrain or rollback needed immediately.`;
    } else if (m.recall <= m.slaAdherence) {
      diagnosis = `CRITICAL: ${labels.recall} collapsed to ${m.recall.toFixed(0)}%. Model is missing most positive cases. Rollback strongly advised.`;
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
    diagnosis = `WARNING: Model quality degrading (${labels.precision} ${m.precision.toFixed(0)}%, ${labels.recall} ${m.recall.toFixed(0)}%). Consider retraining or promoting a staged candidate.`;
  } else if (m.slaAdherence < 75) {
    severity = "warning";
    diagnosis = `WARNING: SLA at ${m.slaAdherence.toFixed(0)}% — approaching breach territory. Address root cause before next peak traffic window.`;
  } else if (m.inferenceCost > 65) {
    severity = "warning";
    diagnosis = `WARNING: Inference cost index at ${m.inferenceCost.toFixed(0)}/100. Unchecked scaling will exhaust budget before Day 14.`;
  } else if (m.skew === "High") {
    severity = "warning";
    diagnosis = "WARNING: Distribution skew is HIGH. Feature distributions have diverged from your training baseline — model predictions are unreliable.";
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
  const labels = getMetricLabels(state.scenario);
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
    bullets.push(`${labels.precision} hit zero — the model was making meaningless predictions. Emergency retraining or rollback was needed.`);
  }
  if (state.metrics.recall <= 0) {
    bullets.push(`${labels.recall} hit zero — the model stopped detecting positive cases entirely.`);
  }
  if (state.metrics.slaAdherence <= 0) {
    bullets.push("SLA adherence hit zero — a complete production outage. Infrastructure scaling or rollback was critical.");
  }
  if (state.metrics.featureStaleness > 36) {
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
