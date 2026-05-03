import { GameState } from "./game-types";

export const DIFFICULTY_BY_SCENARIO: Record<string, number> = {
  default: 1, zillow: 2, netflix: 2, tesla: 2, google: 2,
  uber: 3, facebook: 3, tay: 3, stripe: 3, amazon: 3, twitter: 3,
};

// Tier bonuses shift scores upward; the S-grade threshold is also difficulty-aware (tier 1: S ≥ 90,
// tier 2/3: S ≥ 100) because the CI/CD cap at 85% limits Default's metricPts to ~35 (max achievable ≈ 95).
const DIFFICULTY_BONUS: Record<number, number> = { 1: 10, 2: 15, 3: 25 };

export function computeRunScore(state: GameState): { score: number; grade: string } {
  const difficulty = DIFFICULTY_BY_SCENARIO[state.scenario] ?? 1;
  const bonus = DIFFICULTY_BONUS[difficulty] ?? 0;
  const daysCompleted = Math.max(0, state.day - 1);
  const m = state.metrics;
  const avgMetric = (m.precision + m.recall + m.slaAdherence) / 3;
  const metricPts = (avgMetric / 100) * 40;
  const streakPts = Math.min((state.maxStreak ?? 0) / 14, 1) * 20;
  const survivalPts = Math.min(daysCompleted / 14, 1) * 20;
  const winPts = state.status === "won" ? 10 : 0;
  const score = Math.round(metricPts + streakPts + survivalPts + winPts + bonus);
  // S threshold scales with difficulty: tier-1 (Default) CI/CD cap at 85 limits metricPts to ~35,
  // so perfect play ≈ 95 — S at ≥90 is achievable. Harder tiers have higher bonuses → S at ≥100.
  const sThreshold = difficulty === 1 ? 90 : 100;
  let grade = "D";
  if (score >= sThreshold) grade = "S";
  else if (score >= 82) grade = "A";
  else if (score >= 65) grade = "B";
  else if (score >= 48) grade = "C";
  return { score, grade };
}

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
  // Note: loss fires at > 32h (see below). With +2/day from day 1 (start=2), passive decay alone
  // reaches 30h by day 14 (safe). Loss requires compounding events (e.g. Pipeline Delay A) + ignoring
  // the triggered stale_features event (> 24h) three consecutive times.
  s.metrics.slaAdherence = Math.max(0, s.metrics.slaAdherence - 0.5);

  // High skew compounds accuracy decay — features diverged from training distribution degrade predictions
  // faster than normal concept drift alone. This gives skew a tangible daily mechanic consequence.
  if (s.metrics.skew === "High") {
    s.metrics.precision = Math.max(0, s.metrics.precision - 1);
    s.metrics.recall = Math.max(0, s.metrics.recall - 1);
  }

  if (s.ciCd.autoRetrain) {
    // CI/CD retraining counters drift but has diminishing returns above 85% — data distribution
    // coverage saturates and further gains require fundamentally new data, not more retrains.
    if (s.metrics.precision < 85) {
      s.metrics.precision = Math.min(85, s.metrics.precision + 2);
    }
    if (s.metrics.recall < 85) {
      s.metrics.recall = Math.min(85, s.metrics.recall + 1);
    }
    // Retraining runs consume compute — reflected in cost index
    s.metrics.inferenceCost = Math.min(100, s.metrics.inferenceCost + 2);
  }

  // Clamp
  s.metrics.precision = Math.min(100, Math.max(0, s.metrics.precision));
  s.metrics.recall = Math.min(100, Math.max(0, s.metrics.recall));
  s.metrics.slaAdherence = Math.min(100, Math.max(0, s.metrics.slaAdherence));
  s.metrics.inferenceCost = Math.min(100, Math.max(0, s.metrics.inferenceCost));

  // Streak tracking — consecutive days with all metrics in healthy range
  const safeDay =
    s.metrics.precision >= 60 &&
    s.metrics.recall >= 60 &&
    s.metrics.slaAdherence >= 60 &&
    s.metrics.skew !== "High" &&
    s.metrics.featureStaleness <= 24;
  if (safeDay) {
    s.streak = (s.streak ?? 0) + 1;
    s.maxStreak = Math.max(s.maxStreak ?? 0, s.streak);
  } else {
    s.streak = 0;
  }

  // Loss conditions
  if (
    s.metrics.precision <= 0 ||
    s.metrics.recall <= 0 ||
    s.metrics.slaAdherence <= 0 ||
    s.metrics.featureStaleness > 32 ||
    s.metrics.inferenceCost >= 100
  ) {
    s.status = "lost";
    const { score, grade } = computeRunScore(s);
    s.score = score;
    s.grade = grade;
  }

  // Win condition
  if (s.day > 14 && s.status === "playing") {
    s.status = "won";
    s.wins += 1;
    const { score, grade } = computeRunScore(s);
    s.score = score;
    s.grade = grade;
  }

  return s;
}

export function getEventForDay(state: GameState): GameEvent | null {
  if (state.status !== "playing") return null;

  const d = state.day;
  const sc = state.scenario;

  // ---- Scenario-specific unique events ----

  // DEFAULT: Silent concept drift — the scenario's signature learning event
  if (sc === "default" && d === 5) {
    return {
      id: "default_silent_drift",
      eventType: "drift",
      title: "SILENT CONCEPT DRIFT DETECTED",
      description:
        "Model monitoring flagged a 12% shift in the input feature distribution over the past 5 days. Your model's confidence on recent predictions has quietly dropped — precision hasn't breached an alert threshold yet, but the trend is unmistakable. This is the slow-burn failure mode that ends careers.",
      choices: [
        {
          id: "A",
          label: "Enable CI/CD auto-retraining on a rolling data window",
          effect: (s) => {
            s.ciCd.autoRetrain = true;
            s.metrics.precision += 2;
          },
        },
        {
          id: "B",
          label: "Audit feature distributions then retrain on the last 30 days",
          effect: (s) => {
            s.metrics.inferenceCost += 3;
            // A retrain on recent data corrects learned patterns for both the positive and negative class —
            // precision recovers because the model re-learns the current feature-label mapping,
            // recall recovers because it re-learns which signals actually indicate positives.
            s.futureEffects.push(
              {
                triggerDay: s.day + 3,
                metric: "precision",
                delta: 10,
                message: "Distribution audit confirmed drift; targeted retrain on recent data resolved both precision and recall",
              },
              {
                triggerDay: s.day + 3,
                metric: "recall",
                delta: 6,
                message: "Retrain on recent data restored detection coverage as well as precision",
              }
            );
          },
        },
        {
          id: "C",
          label: "No threshold breach yet — monitor for another week",
          effect: (s) => {
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: -7, message: "Silent drift compounded — model quality degrading ahead of threshold alerts" },
              { triggerDay: s.day + 4, metric: "recall", delta: -6, message: "Untreated drift reached recall — the model is now missing real signals too" }
            );
          },
        },
      ],
    };
  }

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
            // L2 regularization is a hyperparameter change on the existing XGBoost model (reg_lambda),
            // NOT an architecture switch to linear regression. The model stays XGBoost — but with
            // penalized large coefficients it generalizes better to property types outside the training
            // distribution. Precision (Accuracy Index) drops slightly as the model sacrifices some
            // in-sample accuracy for generalization. Coverage (Coverage Index) gains modestly because
            // a less-overfit model is willing to estimate properties it was previously too uncertain about.
            s.metrics.precision -= 3;
            s.metrics.recall += 2;
            s.metrics.skew = "Low";
            s.registry.models.push({
              id: "model_v2",
              // L2 regularization applies to the XGBoost objective — architecture does not change
              type: "XGBoost",
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
            // 90 days of recent transaction data captures far more diverse property types:
            // new builds, non-standard lots, thin-market geographies, post-rate-shift comparables.
            // Precision (Accuracy Index) improves because the model learns current market dynamics.
            // Coverage (Coverage Index) also improves — with more diverse training examples the model
            // becomes confident enough to estimate properties it previously abstained from.
            s.metrics.inferenceCost += 5;
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: 12, message: "Fresh 90-day retrain corrected live error distribution — Accuracy Index recovered" },
              { triggerDay: s.day + 2, metric: "recall", delta: 4, message: "Retrain on diverse recent transactions expanded coverage — model now estimates previously uncertain property types" }
            );
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
        "Average-case accuracy is 99.1% — but the model catastrophically fails on stationary emergency vehicles left in lanes, unusual road markings, and pedestrians in low-visibility conditions. Recall on rare-class events has silently degraded in production.",
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
            s.metrics.skew = "Low";
            s.metrics.precision += 5;
            s.metrics.recall += 3;
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
              message: "Fraud rings studied the new threshold and adapted — sophisticated near-threshold transactions inflated the false alarm rate, eroding precision",
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
          label: "Fall back to XGBoost (35ms P99, lower accuracy)",
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
            // Retraining on 14 days of lockdown-era engagement replaces the model's diverse
            // historical collaborative-filtering signal with a concentrated lockdown signal.
            // Lockdown binge behavior clusters around specific genres (immersive long-form, home content) —
            // the model learns EXACTLY what users want right now, but narrows its view of their full
            // taste profile. Engagement Rate (Precision@N) improves strongly; Diversity Score drops
            // because the model now over-fits to the current narrow behavioral cluster, amplifying
            // the filter bubble the Netflix scenario warns about.
            s.metrics.precision += 10;
            s.metrics.recall -= 4;
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
            // Ignoring drift compounds in two stages:
            // 1. Engagement Rate drops as the model keeps recommending pre-lockdown content
            //    (wrong session length, wrong genres for lockdown mood). Users disengage.
            // 2. As users disengage, explicit engagement signals become sparse — collaborative
            //    filtering loses signal fidelity. Taste clusters collapse and Diversity Score
            //    falls as the model can no longer distinguish user preferences reliably.
            //    The diversity collapse arrives later than the engagement drop.
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: -5, message: "Gradual drift degraded recommendation ranking quality — engagement declining" },
              { triggerDay: s.day + 4, metric: "precision", delta: -5, message: "Severe drift — recommendations rated poor by 30%+ of users, engagement signals now sparse" },
              { triggerDay: s.day + 4, metric: "recall", delta: -5, message: "Sparse engagement signals collapsed collaborative filtering — Diversity Score degraded as taste clusters lost definition" }
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
            // A dedicated LLM-content classifier filters spam across the FULL index, not just top positions.
            // Every query that previously had spam displacing relevant results now sees those documents surface.
            // NDCG (precision) jumps because top positions are de-spammed — position-weighted quality rises.
            // MAP (recall) also rises: AP(q) improves for ALL affected queries, and MAP = (1/|Q|) × Σ AP(q).
            // This is not just a top-K fix — it is precisely what MAP measures (coverage of relevant documents
            // across all queries, not just the head of the ranked list).
            s.metrics.precision += 12;
            s.metrics.recall += 6;
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
              { triggerDay: s.day + 3, metric: "recall", delta: -8, message: "LLM content displaced relevant documents across the index — MAP collapsed as genuine content was buried in every affected result set" }
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
        "Your model's prediction quality has dropped below 60%. Outputs are significantly wrong at an unacceptable rate — downstream decisions built on these predictions are materially harmed. Immediate action required.",
      choices: [
        {
          id: "A",
          // Emergency retrain on fresh data recovers both precision and recall — a full model rebuild
          label: "Emergency retrain on latest data",
          effect: (s) => {
            s.metrics.precision += 20;
            s.metrics.recall += 10;
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "B",
          label: "Switch to a lighter fallback model — restores precision at cost of recall",
          effect: (s) => {
            s.metrics.precision += 15;
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

  if (state.metrics.recall < 60) {
    return {
      id: "low_recall",
      eventType: "triggered",
      title: "CRITICAL: COVERAGE COLLAPSED",
      description:
        "Your model's coverage has dropped below 60%. The model is failing to handle most of the cases it was designed for — whether missing positive class predictions in classification or refusing to predict on uncertain inputs in regression. Every uncovered case is a failure at scale.",
      choices: [
        {
          id: "A",
          label: "Emergency retrain to recover detection coverage",
          effect: (s) => {
            // Full rebuild on latest data restores both metrics — same as the precision emergency retrain.
            // Precision is NOT sacrificed here: that trade-off only happens when lowering the decision
            // threshold (Choice B), not when doing a full retrain on updated ground-truth labels.
            s.metrics.recall += 20;
            s.metrics.precision += 8;
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "B",
          label: "Lower detection threshold — catch more positives at cost of precision",
          effect: (s) => {
            s.metrics.recall += 12;
            s.metrics.precision -= 10;
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
              message: "Stakeholders escalated detection failures — SLA breach incoming",
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
          // Switching to a lighter fallback model restores availability fast — but simpler models are less precise
          label: "Switch to a lighter fallback model — restores SLA, trades precision",
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
          label: "Investigate root cause — fix deployed same day",
          effect: (s) => {
            // Full investigation and fix in one cycle: the highest SLA recovery of the three options
            // but requires more engineering time than a fallback switch or raw scaling.
            // No future effect to prevent stacking this choice across multiple triggered events.
            s.metrics.slaAdherence += 20;
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
        { id: "B", label: "Use cached features", effect: (s) => {
          s.metrics.precision -= 2;
          // Serving stale cached features widens training-serving skew
          if (s.metrics.skew === "Low") s.metrics.skew = "Medium";
        } },
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
            s.metrics.precision += 3;
            s.metrics.recall += 5;
            const newId = `model_v${s.day}`;
            const canaryType = ["tesla", "netflix", "google", "tay", "facebook"].includes(s.scenario)
              ? "Neural Network"
              : "XGBoost";
            // Archive the current production model before promoting the canary
            const oldProdIdx = s.registry.models.findIndex((m) => m.id === s.registry.productionModelId);
            if (oldProdIdx >= 0) s.registry.models[oldProdIdx].stage = "archived";
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
            s.metrics.recall += 5;
            s.metrics.inferenceCost += 5;
            // Retraining on fresh data that matches the current serving distribution also reduces
            // training-serving skew — the new model learns from the same distribution it will serve.
            if (s.metrics.skew === "High") s.metrics.skew = "Medium";
            else if (s.metrics.skew === "Medium") s.metrics.skew = "Low";
            const newId = `model_v${s.day}`;
            const retrainType = ["tesla", "netflix", "google", "tay", "facebook"].includes(s.scenario)
              ? "Neural Network"
              : "XGBoost";
            s.registry.models.push({ id: newId, type: retrainType, version: `${s.day}.0`, stage: "staging", trainedOnDay: s.day, dataVersion: "dataset_2025Q2", accuracy: 88, cost: 0.1, latency: 15, explainability: "Medium" });
            // Staging model auto-promotes after validation cycle — precision and recall gains land on day+2
            s.futureEffects.push(
              { triggerDay: s.day + 2, metric: "precision", delta: 4, message: "Staged model passed validation — promoted to production, precision gains confirmed" },
              { triggerDay: s.day + 2, metric: "recall", delta: 2, message: "Staged model promoted — recall improvement confirmed in live traffic evaluation" }
            );
          },
        },
        {
          id: "B",
          label: "Schedule for next sprint",
          effect: (s) => {
            // A scheduled retrain on fresh data improves both signal classes — not just precision.
            // Recall benefits because the model re-learns which patterns actually indicate positives
            // in the current distribution, not just where the false-positive boundary sits.
            s.futureEffects.push(
              { triggerDay: s.day + 3, metric: "precision", delta: 5, message: "Scheduled retrain on fresh data improved model quality — precision gains confirmed" },
              { triggerDay: s.day + 3, metric: "recall", delta: 3, message: "Scheduled retrain also recovered recall — model detects more true positives in current distribution" }
            );
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
        // Checkpointing partial results limits data loss; the requeue delay causes a minor SLA dip
        { id: "C", label: "Checkpoint partial results — requeue remaining work", effect: (s) => { s.metrics.slaAdherence -= 5; } },
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
        // Off-peak scheduling is safer than immediate patch but the maintenance window still causes a brief outage
        { id: "B", label: "Schedule during off-peak maintenance window", effect: (s) => {
          s.futureEffects.push(
            { triggerDay: s.day + 1, metric: "slaAdherence", delta: -3, message: "Off-peak maintenance window began — brief service interruption during CVE patch" },
            { triggerDay: s.day + 2, metric: "slaAdherence", delta: 6, message: "CVE patch deployed cleanly during maintenance — SLA stabilized" }
          );
        } },
        // CVE exploit is most likely DoS (SLA hit) or model-serving disruption, not training-serving skew
        { id: "C", label: "Accept risk — delay indefinitely", effect: (s) => {
          s.futureEffects.push(
            { triggerDay: s.day + 2, metric: "slaAdherence", delta: -18, message: "Unpatched CVE exploited — serving cluster disrupted, partial outage underway" },
            { triggerDay: s.day + 3, metric: "slaAdherence", delta: -10, message: "Exploit persisted — SLA degradation compounding while patch is still undeployed" }
          );
        } },
      ],
    },
    {
      id: "rand_traffic_spike",
      eventType: "random",
      title: "TRAFFIC SPIKE: 3X VOLUME",
      description: "Unexpected 3x spike in inference requests. Infrastructure is under stress.",
      choices: [
        { id: "A", label: "Auto-scale cluster", effect: (s) => { s.metrics.inferenceCost += 20; } },
        // Rate limiting a 3x spike means rejecting ~2/3 of requests cleanly — high SLA impact, but served predictions remain full quality
        { id: "B", label: "Rate limit requests", effect: (s) => { s.metrics.slaAdherence -= 22; } },
        // Uncontrolled failure drops ~2/3 of all prediction requests chaotically. These are not clean rejections —
        // shed requests are direct coverage misses. Surge Coverage, Coverage Index, MAP, and Diversity Score all
        // require predictions to actually be served. A shed request is an uncovered case in every recall metric.
        // Distinct from rate limiting: rate limiting rejects cleanly before prediction; shedding fails mid-pipeline,
        // creating partial failures that corrupt coverage counts.
        { id: "C", label: "Let it fail — shed load", effect: (s) => { s.metrics.slaAdherence -= 32; s.metrics.recall -= 5; } },
      ],
    },
    {
      id: "rand_null_features",
      eventType: "random",
      title: "DATA QUALITY ALERT",
      description: "Monitor detected an unusual spike in missing or corrupted values in the last inference batch.",
      choices: [
        // Fix: never make staleness worse — if already fresh (e.g. 2h), fixing the pipeline doesn't regress it
        { id: "A", label: "Investigate and fix upstream data pipeline", effect: (s) => { s.metrics.featureStaleness = Math.min(s.metrics.featureStaleness, 3); } },
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
        { id: "A", label: "Generate model explainability report", effect: (s) => {
          // Full SHAP/LIME analysis over the production dataset is expensive but surfaces feature-level
          // attribution. This often reveals high-noise or low-signal features the model over-relies on —
          // identifying and removing them improves precision as a side effect of the audit.
          s.metrics.inferenceCost += 5;
          s.metrics.precision += 2;
        } },
        // Surrogate models are for explanation only — they don't touch the serving path or affect live model precision
        { id: "B", label: "Use surrogate model for explanation", effect: (s) => { s.metrics.inferenceCost += 3; } },
        // Denying a legal audit request doesn't hurt serving SLA — it creates a delayed regulatory consequence
        { id: "C", label: "Deny request — no bandwidth", effect: (s) => {
          s.futureEffects.push({
            triggerDay: s.day + 3,
            metric: "slaAdherence",
            delta: -20,
            message: "Legal audit escalated to regulator — enforcement action forced emergency model review and partial shutdown",
          });
        } },
      ],
    },
    // ---- New events (indices 8-13) ---- expanding pool to 14 so 13 draws/run are all unique
    {
      id: "rand_label_errors",
      eventType: "random",
      title: "TRAINING DATA AUDIT: LABEL ERRORS FOUND",
      description:
        "A spot check of 500 training samples revealed 8% were mislabeled — wrong ground-truth attached to real inference outputs. The model has been learning from corrupted signal for the past training cycle.",
      choices: [
        {
          id: "A",
          label: "Relabel affected samples and retrain",
          effect: (s) => {
            // Full relabeling + retrain recovers both signal classes — precision and recall both improve.
            // Retraining on clean, correctly-labeled data also realigns the model with the true
            // feature-label relationship, reducing training-serving skew as a side effect.
            s.metrics.precision += 7;
            s.metrics.recall += 5;
            s.metrics.inferenceCost += 8;
            if (s.metrics.skew === "High") s.metrics.skew = "Medium";
            else if (s.metrics.skew === "Medium") s.metrics.skew = "Low";
          },
        },
        {
          id: "B",
          label: "Filter uncertain labels, retrain on cleaner smaller set",
          effect: (s) => {
            // Cleaner labels improve precision, but fewer training samples reduce recall coverage
            s.metrics.precision += 10;
            s.metrics.recall -= 5;
            s.metrics.inferenceCost += 5;
          },
        },
        {
          id: "C",
          label: "Accept noise — 8% is within industry tolerance",
          effect: (s) => {
            // Label noise above ~5% compounds into systematic bias over subsequent retraining cycles
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "precision",
              delta: -6,
              message: "Label noise compounded into systematic bias — precision degraded faster than passive drift alone",
            });
          },
        },
      ],
    },
    {
      id: "rand_output_drift",
      eventType: "random",
      title: "PREDICTION DISTRIBUTION SHIFT",
      description:
        "Real-time monitoring shows the model's output distribution has shifted significantly week-over-week with no corresponding change in actual ground-truth rates. In classification this appears as a spike in positive prediction rate; in regression as systematic over- or under-prediction; in ranking as systematic shifts in which content types or items dominate search result positions or recommendation slots. Output predictions have drifted independently of input features.",
      choices: [
        {
          id: "A",
          // For classification: re-tuning the decision threshold corrects the shifted positive rate.
          // For regression: recalibrating output bias corrects systematic over/under-prediction.
          // Both are post-hoc output corrections — precision (or Accuracy Index) improves without retraining.
          label: "Recalibrate model outputs and re-tune decision boundary",
          effect: (s) => {
            s.metrics.precision += 6;
            s.metrics.inferenceCost += 3;
          },
        },
        {
          id: "B",
          label: "Trigger full retraining pipeline on latest labeled data",
          effect: (s) => {
            // The problem is over-prediction of positives (too many false positives).
            // A full retrain on latest labeled data corrects this: precision improves most
            // because the model re-learns the positive/negative boundary more conservatively.
            // Recall also gains but less — the retrain helps detection without over-correcting.
            // Retraining on current data also realigns the model with the live feature distribution,
            // reducing training-serving skew.
            s.metrics.precision += 8;
            s.metrics.recall += 4;
            s.metrics.inferenceCost += 10;
            if (s.metrics.skew === "High") s.metrics.skew = "Medium";
            else if (s.metrics.skew === "Medium") s.metrics.skew = "Low";
          },
        },
        {
          id: "C",
          label: "Silence alert — output shifts can reflect seasonal variation",
          effect: (s) => {
            // Unaddressed output drift cascades into degraded precision as false positives accumulate
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "precision",
              delta: -8,
              message: "Ignored prediction drift compounded — output distribution diverged further from ground truth",
            });
          },
        },
      ],
    },
    {
      id: "rand_batch_timeout",
      eventType: "random",
      title: "BATCH SCORING JOB TIMED OUT",
      description:
        "Nightly batch inference job timed out at 78% completion. 22% of tomorrow's prediction cache is missing. Those requests will fall back to real-time inference (costly) or serve stale predictions.",
      choices: [
        {
          id: "A",
          label: "Extend timeout window and rerun batch job",
          effect: (s) => {
            // Rerunning extends compute cost and delays feature ingest — staleness accrues during the wait
            s.metrics.inferenceCost += 10;
            s.metrics.featureStaleness += 4;
          },
        },
        {
          id: "B",
          label: "Serve partial batch — accept 22% cache miss",
          effect: (s) => {
            // Missing 22% of the prediction cache means those requests fail or get default responses
            s.metrics.slaAdherence -= 12;
          },
        },
        {
          id: "C",
          label: "Fall back to rule-based heuristics for uncached requests",
          effect: (s) => {
            // Rule-based heuristics serve popular/trending content by popularity rank rather than
            // personalized predictions. For classification: rules are more conservative, missing edge
            // cases and reducing both precision and recall coverage. For ranking/recommendation:
            // popular content is concentrated (same top titles for everyone) — the opposite of
            // personalized diversity — so Diversity Score drops alongside Engagement Rate.
            s.metrics.slaAdherence -= 6;
            s.metrics.precision -= 4;
            s.metrics.recall -= 3;
          },
        },
      ],
    },
    {
      id: "rand_vendor_outage",
      eventType: "random",
      title: "VENDOR ENRICHMENT API OUTAGE",
      description:
        "External API providing 3 of your top-10 features by importance has been unreachable for 90 minutes. Inference is currently using stale cached enrichment values from before the outage began.",
      choices: [
        {
          id: "A",
          label: "Switch to backup vendor — accepts 10-minute migration",
          effect: (s) => {
            // Migration lag means features go stale before the backup starts serving
            s.metrics.inferenceCost += 8;
            s.metrics.featureStaleness += 6;
          },
        },
        {
          id: "B",
          label: "Drop affected features — serve with reduced feature set",
          effect: (s) => {
            // Removing 3 important features degrades both precision and recall
            s.metrics.precision -= 6;
            s.metrics.recall -= 4;
          },
        },
        {
          id: "C",
          label: "Continue with stale cached enrichment values",
          effect: (s) => {
            // Prolonged use of stale enrichment widens training-serving skew
            s.metrics.featureStaleness += 10;
            if (s.metrics.skew === "Low") s.metrics.skew = "Medium";
            else if (s.metrics.skew === "Medium") s.metrics.skew = "High";
          },
        },
      ],
    },
    {
      id: "rand_memory_leak",
      eventType: "random",
      title: "INFERENCE SERVER MEMORY LEAK",
      description:
        "Telemetry shows the inference process memory footprint has grown 3× over 6 hours. OOM-kill risk is elevated. Prediction latency is already 20% above baseline SLA.",
      choices: [
        {
          id: "A",
          label: "Deploy hotfix, rolling restart inference pods",
          effect: (s) => {
            // Brief pod restart causes a temporary SLA dip; once resolved, freed memory reduces overhead cost
            s.metrics.slaAdherence -= 5;
            s.metrics.inferenceCost -= 5;
          },
        },
        {
          id: "B",
          label: "Scale out horizontally to absorb the leak",
          effect: (s) => {
            // More pods absorb the leak but compounds the cost — the root cause is not fixed
            s.metrics.inferenceCost += 15;
          },
        },
        {
          id: "C",
          label: "Monitor — schedule fix in next maintenance window",
          effect: (s) => {
            // Leaving a memory leak unaddressed risks OOM-kill cascading across pods
            s.futureEffects.push({
              triggerDay: s.day + 2,
              metric: "slaAdherence",
              delta: -18,
              message: "OOM-kill cascaded across inference pods — serving cluster partially down",
            });
          },
        },
      ],
    },
    {
      id: "rand_feedback_loop",
      eventType: "random",
      title: "FEEDBACK LOOP IN TRAINING DATA",
      description:
        "Pipeline audit reveals that last quarter's model predictions are appearing as ground-truth labels in this month's retraining dataset. The model has been partially learning from its own outputs — a data leakage feedback loop.",
      choices: [
        {
          id: "A",
          label: "Scrub contaminated samples and retrain on verified labels only",
          effect: (s) => {
            // Clean retrain eliminates the self-reinforcing bias — both metrics recover.
            // Training on verified ground-truth labels also corrects the feature-label mapping,
            // reducing training-serving skew that accumulated from the contaminated training cycles.
            s.metrics.precision += 6;
            s.metrics.recall += 5;
            s.metrics.inferenceCost += 10;
            if (s.metrics.skew === "High") s.metrics.skew = "Medium";
            else if (s.metrics.skew === "Medium") s.metrics.skew = "Low";
          },
        },
        {
          id: "B",
          label: "Apply deduplication filter to label pipeline going forward",
          effect: (s) => {
            // Partial fix stops future contamination but doesn't remove already-learned bias
            s.metrics.precision += 3;
            s.metrics.inferenceCost += 3;
          },
        },
        {
          id: "C",
          label: "Contamination rate below 5% — acceptable for now",
          effect: (s) => {
            // Self-reinforcing labels amplify false negatives in subsequent retraining cycles
            s.futureEffects.push({
              triggerDay: s.day + 3,
              metric: "recall",
              delta: -9,
              message: "Feedback loop compounded — model increasingly entrenched in its own past predictions, amplifying systematic bias across the board",
            });
          },
        },
      ],
    },
  ];

  // Pool now has 14 events — one per non-fixed day (days 1-4 and 6-14 = 13 draws).
  // Multiplier must be coprime to 14 to reach all 14 slots. Using 3 (gcd(3,14)=1).
  // Multiplier 7 would only produce 2 distinct values mod 14 (gcd(7,14)=7) — never use it.
  const scenarioHash = [...sc].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const runSeed = (state.wins ?? 0) * 13;
  return pool[(d * 3 + scenarioHash * 3 + runSeed) % pool.length];
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
      "On Day 3, a 4x traffic spike will push your Neural Network past the latency SLA. The team recently migrated from LightGBM to a Neural Network for accuracy gains — but under load the P99 cost is now visible. Falling back to XGBoost restores speed; scaling the cluster doubles infra cost.",
    lesson:
      "Real-time ML systems need latency budgets, not just accuracy targets. Load testing, pre-warmed fallback models, and autoscaling are engineering requirements — not nice-to-haves.",
    startingHandicap: "SLA Adherence starts at 92% — the recently deployed Neural Network (migrated from LightGBM for accuracy) is already under mild background load pressure from city traffic patterns.",
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
    startingHandicap: "Engagement Rate starts at 78% — the model is already slightly behind the current user behavior distribution.",
    problemType: "ranking",
    metricLabels: { precision: "Engagement Rate", recall: "Diversity Score" },
    briefLabels: { precision: "ENGS", recall: "DIVS" },
  },
  tesla: {
    id: "tesla",
    company: "Tesla",
    year: "2022",
    title: "Tesla Autopilot: Edge Case Collapse",
    tagline: "99.9% accuracy. Not enough.",
    whatHappened:
      "Tesla's Autopilot computer vision model showed high average accuracy — but catastrophically failed on rare edge cases: stationary emergency vehicles left in live lanes, unusual temporary road markings, and pedestrians in low-visibility conditions. Optimizing for average-case mAP on common highway scenarios made the model brittle on the long tail of rare events that matter most for safety.",
    keyRisk:
      "On Day 3, rare-class recall failures surface in production. The fix requires targeted training on synthetic edge-case data or a rule-based ensemble — not just retraining on more of the same distribution. NHTSA's documented investigations of Autopilot focused on failure to respond to stationary objects and stop/signal violations.",
    lesson:
      "Safety-critical computer vision systems cannot optimize only for average-case accuracy. Tail risk and rare events require specific evaluation sets, dedicated training data, and targeted coverage constraints. A 99.1% average-case mAP can still mean catastrophic failure on the rare classes that cause fatalities.",
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
      "Facebook's 2021 outage began with a BGP routing misconfiguration that took all of Facebook's infrastructure offline — WhatsApp, Instagram, internal tooling, and critically, the entire ML serving layer. No service was spared. The ML consequence was severe: real-time News Feed ranking had no graceful degradation path. With no pre-warmed fallback model and no circuit breakers, ranking was absent for 6 hours.",
    keyRisk:
      "On Day 3, a BGP routing failure will make your serving cluster unreachable. With no fallback model in staging, you must choose between deploying an untested heuristic, serving cached predictions, or waiting for recovery — each with major SLA consequences.",
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

  if (m.precision <= 20 || m.recall <= 20 || m.slaAdherence <= 20 || m.featureStaleness > 28) {
    severity = "critical";
    // Staleness checked first — it has a hard loss threshold at >32h and players least expect it.
    // At >28h the buffer is only 4h; at 31h only 1h. Message must be time-accurate.
    if (m.featureStaleness > 24) {
      const hoursLeft = Math.max(0, Math.round(32 - m.featureStaleness));
      diagnosis = `CRITICAL: Feature staleness at ${m.featureStaleness.toFixed(0)}h — ${hoursLeft}h from loss threshold. Enable Feature Store now.`;
    } else if (m.precision <= 20 && m.precision <= m.recall) {
      diagnosis = `CRITICAL: ${labels.precision} at ${m.precision.toFixed(0)}% — ${daysLeft} days to survive. Emergency retrain or rollback needed immediately.`;
    } else if (m.recall <= 20) {
      diagnosis = `CRITICAL: ${labels.recall} collapsed to ${m.recall.toFixed(0)}%. Model is missing most positive cases. Rollback strongly advised.`;
    } else {
      diagnosis = `CRITICAL: SLA adherence at ${m.slaAdherence.toFixed(0)}%. Infrastructure is near collapse — scale or roll back immediately.`;
    }
  } else if (m.featureStaleness > 24) {
    severity = "warning";
    diagnosis = `WARNING: Feature staleness at ${m.featureStaleness.toFixed(0)}h (threshold: 32h). Enable Feature Store or force refresh this turn.`;
  } else if (minAccuracy < 65) {
    severity = "warning";
    diagnosis = `WARNING: Model quality degrading (${labels.precision} ${m.precision.toFixed(0)}%, ${labels.recall} ${m.recall.toFixed(0)}%). Retrain or promote a staged candidate before the triggered alert threshold.`;
  } else if (m.slaAdherence < 85) {
    severity = "warning";
    diagnosis = `WARNING: SLA at ${m.slaAdherence.toFixed(0)}% — approaching breach territory. Address root cause before it drops below the 80% trigger threshold.`;
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
    bullets.push(`${labels.recall} hit zero — every output the model was designed to find was missed. Complete detection failure across the board.`);
  }
  if (state.metrics.slaAdherence <= 0) {
    bullets.push("SLA adherence hit zero — a complete production outage. Infrastructure scaling or rollback was critical.");
  }
  if (state.metrics.featureStaleness > 32) {
    bullets.push("Feature staleness exceeded 32 hours — features were stale enough to make training-serving skew catastrophic.");
  }
  if (state.metrics.inferenceCost >= 100) {
    bullets.push("Inference cost hit the limit — unchecked scaling without optimization bankrupted the budget.");
  }
  if (bullets.length === 0) {
    if (state.status === "won") {
      bullets.push("Full MLOps stack maintained throughout the run — Feature Store, CI/CD, and staged models all active. This is the correct operational posture for any production ML system.");
    } else {
      bullets.push("The simulation ended unexpectedly. Review your metric decisions and event choices.");
    }
  }
  return bullets;
}
