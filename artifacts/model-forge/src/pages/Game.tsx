import { useEffect, useState, useCallback, useRef } from "react";
import { useTheme } from "@/lib/theme";
import {
  useNewSession,
  useLoadState,
  useSaveState,
  useGetLeaderboard,
  useRegisterPlayer,
  useLoginPlayer,
  getLoadStateQueryKey,
  getGetLeaderboardQueryKey,
} from "@workspace/api-client-react";
import { GameState, DEFAULT_STATE } from "@/lib/game-types";
import {
  GameEvent,
  DailyBriefData,
  ScenarioBrief,
  SCENARIO_BRIEFS,
  getEventForDay,
  applyChoiceAndAdvance,
  skipEventAndAdvance,
  generatePostMortem,
  generateDailyBrief,
  getMetricLabels,
  getProblemType,
  getEventColor,
  computeRunScore,
  DIFFICULTY_BY_SCENARIO,
} from "@/lib/game-engine";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ---- Codex data ----

const CODEX_STATIC_METRICS = [
  {
    name: "SLA ADHERENCE",
    icon: "◈",
    definition:
      "The percentage of inference requests that complete within your agreed latency and availability targets.",
    formula: "Requests meeting SLA / Total Requests × 100",
    whyItMatters:
      "SLA adherence is the contract between your ML system and the business. Breaching it means customer-facing failures, contract penalties, and — at zero — a complete production outage.",
    causes: [
      "Latency spikes from traffic surges overwhelming the inference cluster",
      "Infrastructure failures in the serving layer",
      "Cascading failures when no fallback model is staged",
      "Cost-cutting that removed headroom from the cluster",
    ],
    recovery: [
      "Scale the inference cluster (costs more but restores uptime immediately)",
      "Rollback to a lighter, faster model in staging",
      "Implement circuit breakers and graceful degradation",
      "Set up autoscaling with a buffer above peak-traffic capacity",
    ],
    lossThreshold: "≤ 0%",
  },
  {
    name: "FEATURE STALENESS",
    icon: "◧",
    definition: "Hours since your feature pipeline last refreshed the inputs the model reads at inference time.",
    formula: "Current time − Last successful feature refresh",
    whyItMatters:
      "Your model makes predictions using features. If those features are hours old, you're predicting on stale data — widening training-serving skew and degrading prediction quality silently.",
    causes: [
      "Feature Store disabled — features accumulate staleness each day",
      "Upstream pipeline delays blocking the refresh",
      "Infrastructure failures in the data ingestion layer",
      "Ignoring null-feature spikes that indicate upstream data loss",
    ],
    recovery: [
      "Enable the Feature Store — it auto-refreshes and caps staleness at 2h",
      "Run an emergency feature refresh (one-time reset)",
      "Fix the upstream pipeline delay event to restore normal cadence",
    ],
    lossThreshold: "> 32h",
  },
  {
    name: "INFERENCE COST",
    icon: "◬",
    definition: "A normalized index (0–100) representing the resource cost of running model inference per unit time.",
    formula: "Normalized compute spend relative to budget ceiling",
    whyItMatters:
      "Every scale-up action, GPU spot instance, and cluster expansion adds to inference cost. At 100, you've exceeded your infrastructure budget and the system shuts down.",
    causes: [
      "Scaling the cluster to handle latency or traffic events",
      "Running expensive model types (Neural Networks cost more than Linear)",
      "A/B testing a canary model doubles your serving footprint",
      "GPU spot interruption forcing you onto on-demand instances",
    ],
    recovery: [
      "Switch to a lighter model variant (Linear or XGBoost over Neural Network)",
      "Reduce cluster size after a traffic event subsides",
      "Optimize batch sizes to amortize inference cost",
      "Avoid scaling unless the SLA is actively breaching",
    ],
    lossThreshold: "≥ 100",
  },
  {
    name: "SKEW ALERT",
    icon: "◭",
    definition:
      "Training-serving skew: how much your live feature distributions have diverged from the distribution your model was trained on.",
    formula: "Distribution distance between training-time and serving-time features",
    whyItMatters:
      "Your model learned patterns from training data. If the features it sees in production look different, its learned patterns no longer apply. When skew reaches High, an extra −1/day penalty is applied to both precision and recall on top of normal passive decay — compounding degradation until the model is retrained on the current distribution.",
    causes: [
      "Feature Store disabled — serving features diverge from training over time",
      "Data poisoning injecting adversarial inputs into the pipeline",
      "Bias in training data that doesn't reflect the true population",
      "Null feature spikes where inputs are missing or malformed",
    ],
    recovery: [
      "Enable the Feature Store with consistent feature versioning",
      "Add data validation to detect and reject anomalous inputs",
      "Retrain with a fresh dataset that matches the current serving distribution",
      "Investigate and fix the upstream data pipeline",
    ],
    lossThreshold: "N/A — High skew degrades all other metrics",
  },
];

function getCodexMetrics(scenario: string) {
  const labels = getMetricLabels(scenario);

  type MetricEntry = {
    definition: string;
    formula: string;
    whyItMatters: string;
    causes: string[];
    recovery: string[];
  };

  const PRECISION_BY_SCENARIO: Record<string, MetricEntry> = {
    default: {
      definition: "Of all predictions your model labels as positive, what fraction are actually positive?",
      formula: "True Positives / (True Positives + False Positives)",
      whyItMatters: "Low precision means your model cries wolf — real users get false alarms or irrelevant results, eroding trust fast.",
      causes: [
        "Passive decay — distributions shift daily as user behavior evolves",
        "Overfitting to training data that doesn't match live distribution",
        "Data poisoning contaminating the training pipeline",
        "Concept drift making previously valid signals noise",
      ],
      recovery: [
        "Retrain on a fresh dataset with a larger, more representative sample",
        "Promote a staged model that was trained more recently",
        "Set up production monitoring to detect distribution shift before it crosses alert thresholds",
        "Enable CI/CD auto-retraining to keep the model current",
      ],
    },
    tesla: {
      definition: "Of all objects your vision model flags as obstacles, what fraction are real obstacles? False positives trigger phantom brakes.",
      formula: "True Detections / (True Detections + False Alarms)",
      whyItMatters: "Phantom braking from false positives creates rear-end collision risk and destroys driver trust. Tesla's Autopilot approval depends on this number staying high — regulators measure false alarm rates directly.",
      causes: [
        "Adversarial weather (fog, glare, snow) creating spurious object boundaries",
        "Domain shift from simulation to real-world sensor data",
        "Sensor calibration drift after vehicle wear and tear",
        "Poorly labeled training samples introducing systematic false positives",
      ],
      recovery: [
        "Retrain with diverse weather and lighting edge cases",
        "Apply hard negative mining on false-positive-heavy scenarios",
        "Use ensemble voting across multiple sensor modalities to reduce false alarms",
        "Run GradCAM analysis to identify which visual features are triggering false detections",
      ],
    },
    zillow: {
      definition: "What percentage of home price estimates fall within ±5% of the final sale price? Accuracy Index measures the model's pricing precision on the predictions it actually makes.",
      formula: "Properties with |estimate − sale_price| < 5% / Properties with estimates",
      whyItMatters: "Buyers anchor on the Zestimate. Estimates off by >5% systematically distort offers — sellers are underpaid, buyers overbid. Zillow's 2021 iBuying collapse lost $500M directly because this degraded while the model bought homes at scale.",
      causes: [
        "Macro interest rate shifts breaking the price-feature relationship learned at training time",
        "Geographic expansion into markets under-represented in training data",
        "Missing renovation signals that buyers factor into mental valuation",
        "Concept drift as pandemic-era pricing patterns don't generalize post-lockdown",
      ],
      recovery: [
        "Retrain with geographically diverse and recency-weighted data",
        "Add macro economic indicators (rates, inventory, days-on-market) as features",
        "Weight recent comparable sales more heavily than historical averages",
        "Enable CI/CD to retrain monthly as market conditions shift",
      ],
    },
    uber: {
      definition: "How accurately does the surge model predict actual ride demand in each geographic zone? Demand Index is 1 minus mean absolute percentage error.",
      formula: "1 − Mean Absolute Percentage Error vs. ground-truth demand",
      whyItMatters: "Overestimating demand deploys too many drivers to dead zones, burning driver earnings. Underestimating means rider ETAs spike and surge multipliers explode — both drive churn to Lyft. The surge price is directly derived from this prediction.",
      causes: [
        "Sudden events (concerts, weather, sports) not in training distribution",
        "Concept drift as commute patterns shift post-pandemic",
        "Feature staleness — demand predictions using hours-old GPS data",
        "Overfitting to historical hotspots that no longer match live demand",
      ],
      recovery: [
        "Retrain with event-enriched data (venue schedules, weather, local calendar)",
        "Reduce feature staleness — demand signals decay within minutes",
        "Use separate models per city cluster rather than one global model",
        "Enable CI/CD to retrain daily on the last 30 days of trip data",
      ],
    },
    netflix: {
      definition: "Of all items shown in the top-N recommendation slots, what fraction does the user actually watch? Engagement Rate is Precision@N.",
      formula: "Watched items in top-N / N (Precision@N)",
      whyItMatters: "Irrelevant titles in the hero row cause scroll fatigue — users lose trust and skip to search. Netflix's internal metric 'took-rate' tracks exactly this. A 1% drop in Engagement Rate at Netflix's scale is millions of abandoned sessions.",
      causes: [
        "Concept drift — COVID lockdown patterns made pre-pandemic models stale overnight",
        "Popularity bias causing the model to over-recommend already-watched content",
        "Cold-start problem for new releases without enough interaction data",
        "Feature staleness — recommendations built on stale viewing history",
      ],
      recovery: [
        "Retrain with a recency window that down-weights pre-shift behavior",
        "Add popularity-penalization to reduce filter bubbles",
        "Promote a staged model trained on the last 30 days of engagement",
        "Enable CI/CD auto-retraining to track shifting taste in near real-time",
      ],
    },
    google: {
      definition: "Normalized Discounted Cumulative Gain: a position-weighted ranking quality metric. Relevant results near the top contribute more than equally relevant results lower down — the log discount means position 1 counts roughly 3× more than position 10.",
      formula: "DCG = Σ (relevanceᵢ / log₂(i + 1)); NDCG = DCG / IDCG (ideal DCG for perfect ranking)",
      whyItMatters: "A drop in NDCG means relevant results are either missing or buried below irrelevant ones. Position 1 matters disproportionately — a perfect result at rank 1 outweighs the same result at rank 10 by a factor of ~3.3. Google's human-rater programme (Search Quality Evaluator Guidelines) is built entirely around NDCG measurement.",
      causes: [
        "LLM-generated content flooding the index and confusing quality signals",
        "SEO manipulation exploiting ranking signals not caught by spam filters",
        "Concept drift as search intent semantics evolve faster than training frequency",
        "Feature staleness on real-time signals (freshness, click-through) used at ranking",
      ],
      recovery: [
        "Retrain with human-rated relevance labels from recent query logs",
        "Update spam filters to catch the latest content-farm patterns",
        "Refresh real-time ranking features — freshness signals decay fast",
        "Enable CI/CD to retrain on the last 7 days of search log data",
      ],
    },
    facebook: {
      definition: "Of all posts your model ranks in the top positions of a user's News Feed, what fraction does the user meaningfully engage with (like, share, click, or comment)? Relevance Score measures feed content quality at ranking time.",
      formula: "Engaged posts in top-N / N (Precision@N on the News Feed ranking)",
      whyItMatters: "Irrelevant posts in the top feed positions teach users to scroll past the algorithmic feed entirely. The 2021 BGP outage took the feed ranking model offline for 6 hours — during that window every user's feed was degraded or absent. At Facebook's scale, a 1% precision drop in feed relevance translates to hundreds of millions of degraded daily active sessions.",
      causes: [
        "Concept drift as user interests shift post-major-events or seasonally",
        "Engagement farming — low-quality viral content scores high on the raw engagement proxy",
        "Infrastructure failure (BGP routing, data center outage) taking the ranking model offline",
        "Feature staleness when the serving pipeline goes down and ranking signals can't refresh",
      ],
      recovery: [
        "Retrain with recent engagement logs weighted toward quality signals, not raw engagement counts",
        "Stage a pre-warmed fallback model in staging BEFORE any infrastructure event",
        "Implement circuit breakers that serve a degraded chronological feed during ranking outages",
        "Promote a staged model trained on the last 14 days of diverse engagement signals",
      ],
    },
    twitter: {
      definition: "Of tweets your model predicts will receive high engagement, what fraction actually do? Engagement Score is Precision@N on the ranked timeline.",
      formula: "Truly high-engagement tweets in top-N / N (Precision@N)",
      whyItMatters: "Over-predicting engagement inflates the timeline with low-quality viral bait, reducing signal quality. Twitter's algorithmic timeline credibility — especially post-2022 when ranking became visible — depends on this being accurate. Users who lose trust switch to chronological order.",
      causes: [
        "Concept drift — breaking news signals look identical to manufactured engagement",
        "Engagement farming bots inflating interaction counts during training",
        "Popularity bias rewarding already-viral content regardless of quality",
        "Feature staleness — engagement signals at time-of-posting age rapidly",
      ],
      recovery: [
        "Retrain with bot-filtered engagement labels from trusted accounts",
        "Add engagement velocity signals (rate of growth, not raw count) as features",
        "Reduce feature staleness — timeline ranking signals are real-time by nature",
        "Use separate models for breaking news vs. evergreen content",
      ],
    },
    tay: {
      definition: "Of all responses Tay generates, what fraction are semantically coherent and contextually appropriate to the conversation?",
      formula: "Human-rated coherent responses / Total responses (sampled evaluation)",
      whyItMatters: "Incoherent responses destroy the illusion of intelligence and expose the model as unreliable. Tay's outputs became incoherent within 16 hours of launch — a direct consequence of adversarial poisoning degrading generation quality. Microsoft's reputational damage was permanent.",
      causes: [
        "Adversarial inputs training the model on incoherent or toxic response patterns",
        "Concept drift as conversation topics shift away from training distribution",
        "Data poisoning through coordinated user injection of malicious training signals",
        "Context window overflow causing responses to lose conversation thread",
      ],
      recovery: [
        "Retrain on a curated, filtered dataset with adversarial examples removed",
        "Implement input validation to reject known adversarial prompt patterns",
        "Add a coherence classifier gating outputs before they reach users",
        "Enable CI/CD to retrain frequently on human-verified conversation logs",
      ],
    },
    amazon: {
      definition: "Of all résumés your model scores as 'qualified', what fraction are genuinely strong candidates? False positives waste recruiter time on weak applications.",
      formula: "True Positives / (True Positives + False Positives)",
      whyItMatters: "Amazon's hiring tool penalized résumés containing 'women's' and downgraded all-women's college graduates. Precision failures in hiring AI mean recruiters waste time on biased scores — and systematically favour candidates from historically overrepresented groups, encoding historical discrimination at industrial scale.",
      causes: [
        "Training on biased historical hiring decisions that reflect demographic imbalance in tech",
        "Proxy features (university prestige, job title phrasing) carrying demographic signal",
        "Label noise — past hiring decisions made by humans with their own biases become training targets",
        "Concept drift as the definition of 'strong candidate' evolves faster than the model retrains",
      ],
      recovery: [
        "Audit and remove proxy features that correlate with protected characteristics",
        "Reweight training labels to correct for historical demographic imbalance",
        "Add a fairness constraint requiring balanced precision across demographic groups",
        "Require disparate impact analysis on every model version before deployment",
      ],
    },
    stripe: {
      definition: "Of all transactions your model flags as fraudulent, what fraction are actually fraudulent? False positives block legitimate business revenue.",
      formula: "True Positives / (True Positives + False Positives)",
      whyItMatters: "False positives at Stripe directly harm small businesses — blocking a startup's largest customer transaction can be existential. Stripe's value proposition is frictionless global payments; precision failures destroy that promise.",
      causes: [
        "New merchant categories not in training distribution being over-flagged",
        "International transactions triggering domestic fraud signals incorrectly",
        "Concept drift as payment card norms evolve across markets",
        "Feature staleness — velocity signals based on stale transaction windows",
      ],
      recovery: [
        "Retrain with merchant-category-stratified data to reduce category bias",
        "Adjust the classification threshold by region and merchant type",
        "Add merchant reputation signals as features to reduce false positive rates",
        "Enable CI/CD for weekly retraining — fraud and legitimate patterns both evolve",
      ],
    },
  };

  const RECALL_BY_SCENARIO: Record<string, MetricEntry> = {
    default: {
      definition: "Of all actual positives in the world, what fraction does your model successfully detect?",
      formula: "True Positives / (True Positives + False Negatives)",
      whyItMatters: "Low recall means you're missing real signals. The cost of missing positives is often higher than false alarms — especially in safety-critical or high-value scenarios.",
      causes: [
        "Overfitting that tunes precision while sacrificing recall on rare classes",
        "Concept drift changing what a 'positive' looks like in production",
        "Data imbalance — the model under-learns the minority class",
        "Passive decay as distribution slowly shifts away from training baseline",
      ],
      recovery: [
        "Retrain with oversampled minority-class examples to address minority class under-learning",
        "Switch to a model type better suited to imbalanced data (e.g. Ensemble)",
        "Lower the classification decision threshold — this trades some precision for higher recall without retraining",
        "Add recall as an explicit optimization target alongside precision in the loss function",
      ],
    },
    tesla: {
      definition: "Of all real obstacles in the scene, what fraction does your model successfully detect before the vehicle reaches them? Missing one is a safety-critical failure.",
      formula: "True Detections / (True Detections + Missed Obstacles)",
      whyItMatters: "Missing a real obstacle means the vehicle may not brake. This is not a quality issue — it is a fatality risk. Tesla's 2022 recall of 344,000 vehicles was triggered by false negatives on partially occluded pedestrians. Detection Recall is the metric regulators use to approve autonomous systems.",
      causes: [
        "Model undertrained on occluded or partially visible objects",
        "Adverse weather (rain, snow, direct sunlight) washing out sensor signals",
        "Night-time and backlit scenarios under-represented in training data",
        "Rare obstacle types (animals, debris, emergency vehicles) never seen at training time",
      ],
      recovery: [
        "Retrain with a dataset heavily augmented with edge-case scenarios",
        "Use sensor fusion (camera + radar + lidar) to compensate for any single sensor's misses",
        "Lower the detection confidence threshold — in safety systems, prefer false alarms to misses",
        "Run saliency map analysis to identify blind spots in the model's attention",
      ],
    },
    zillow: {
      definition: "What fraction of listed properties receive any estimate at all? Coverage Index measures how broadly the model can be applied across the full inventory.",
      formula: "Properties with estimates / Total listed properties",
      whyItMatters: "Low coverage means the model only prices well-represented homes and abandons the rest to expensive human appraisal. It also biases the market — homes without Zestimates sell slower and at lower prices, creating systemic inequity in who benefits from algorithmic pricing.",
      causes: [
        "Model refusing to predict on properties too unlike the training set",
        "Geographic sparsity — new markets with too few comparables",
        "Missing features causing the model to abstain rather than estimate",
        "Hard confidence thresholds filtering out uncertain predictions",
      ],
      recovery: [
        "Retrain with geographically broader data to extend model confidence",
        "Use uncertainty quantification to provide range estimates rather than refusing",
        "Add neighboring-market data as proxy features for sparse geographies",
        "Lower the confidence threshold with a wider prediction interval shown to users",
      ],
    },
    uber: {
      definition: "Of all high-demand zones in the city at a given moment, what fraction does the surge model correctly identify in time to deploy drivers?",
      formula: "Correctly-flagged demand zones / All actual high-demand zones",
      whyItMatters: "Missing a demand spike means drivers aren't where riders are — ETAs spike, surge prices explode, and riders churn to Lyft. Recall matters most during events: airports at holiday peaks, post-concert surges, sudden weather. These are high-value moments where missed coverage loses the most revenue.",
      causes: [
        "Events not in training data — the model has never seen this demand signature",
        "Feature staleness — demand signals using GPS data that is hours old",
        "Geographic distribution shift as the city's demand patterns evolve",
        "Concept drift post-pandemic as commute patterns changed permanently",
      ],
      recovery: [
        "Add event-calendar features so the model anticipates known demand spikes",
        "Reduce feature staleness — demand signals need sub-minute freshness",
        "Increase model sensitivity on underserved high-demand zone types",
        "Enable CI/CD daily retraining on recent trip data from the last 30 days",
      ],
    },
    netflix: {
      definition: "What fraction of a user's demonstrated taste profile is covered by the current recommendations? Diversity Score prevents filter bubbles and long-term engagement collapse.",
      formula: "Unique taste clusters served / User's total identified taste clusters",
      whyItMatters: "A model optimized purely for short-term take-rate will over-serve genres already watched, creating a feedback loop that bores users over weeks. Netflix's long-term retention depends on surfacing content outside the user's current loop — Diversity Score is what keeps a subscriber renewing month 7.",
      causes: [
        "Popularity bias concentrating recommendations on already-successful titles",
        "Filter bubble from over-fitting to recent watch history at the expense of broader taste",
        "Cold-start failure for new content categories with no engagement history",
        "Collaborative filtering collapse where all users in a cluster get identical recommendations",
      ],
      recovery: [
        "Add diversity regularization directly into the loss function",
        "Implement exploration slots in the recommendation grid (e.g. 1-in-10 is deliberate exploration)",
        "Use content-based signals alongside collaborative filtering to break filter bubbles",
        "Promote a staged model with explicit diversity constraints built in",
      ],
    },
    google: {
      definition: "Mean Average Precision — the mean of Average Precision scores computed across all queries. MAP serves as the recall-analog in this ranking context: it penalizes models that miss relevant documents anywhere in the result set, even if the top positions look good. A model that finds only 60% of relevant documents scores at most 0.6 MAP regardless of how well it orders them.",
      formula: "MAP = (1/|Q|) × Σ_q AP(q); AP(q) = Σ_k (P@k × rel_k) / |relevant_q|",
      whyItMatters: "Low MAP means niche and expert queries return incomplete results — the gaps competitors fill. Unlike NDCG alone, MAP catches models that rank the top results well but abandon coverage below rank 5. At Google scale, a 1% MAP drop on the long tail is billions of queries that surface only a fraction of genuinely relevant content.",
      causes: [
        "Index freshness issues — newly published relevant content not yet crawled",
        "Ranking bias toward high-PageRank domains over genuinely relevant smaller sources",
        "Semantic mismatch between query intent and document representation",
        "Feature staleness on freshness signals preventing newly-relevant content from surfacing",
      ],
      recovery: [
        "Improve crawl freshness for the long tail of the web",
        "Add semantic embeddings to bridge query-document vocabulary gaps",
        "Retrain with query-document relevance pairs that cover underserved query types",
        "Promote a staged model that scores long-tail coverage alongside precision",
      ],
    },
    facebook: {
      definition: "Of all genuinely engaging posts available in a user's network graph, what fraction does the News Feed model surface before the session ends? Feed Recall measures how completely the ranking covers a user's relevant network activity.",
      formula: "Engaging posts surfaced in session / All engaging posts available in user's network graph",
      whyItMatters: "Facebook's 2021 BGP outage took feed ranking offline for 6 hours — every post in every user's network was effectively missed. Low Feed Recall means friends' announcements, live events, and breaking news disappear into the unseen tail of the feed. Users who chronically miss social moments from their network churn to Instagram or TikTok.",
      causes: [
        "Infrastructure failure (BGP routing, data center outage) taking the ranking model offline entirely",
        "No circuit breaker — the system serves no feed rather than a degraded chronological feed",
        "Feature staleness — engagement signals for fresh posts cannot propagate when the pipeline is down",
        "Serving cluster overload causing ranking to abort before processing the full candidate set",
      ],
      recovery: [
        "Stage a pre-warmed lightweight fallback model in production BEFORE the next infrastructure event",
        "Implement circuit breakers that serve a chronological feed when the ranker is unreachable",
        "Add health checks on the feed serving pipeline so recall drops immediately surface as alerts",
        "Retrain on recent diverse engagement to improve coverage of varied post types and network sizes",
      ],
    },
    twitter: {
      definition: "Of all genuinely high-engagement content available in a user's network, what fraction does the model surface before the engagement window closes? Reach Index measures completeness of the ranked timeline.",
      formula: "Correctly surfaced high-engagement content / All actually-viral content in user's graph",
      whyItMatters: "Breaking news and cultural moments have a 15–60 minute engagement window. Missing them means your algorithm lags the conversation — users switch to chronological order or competing platforms to find what's happening. Reach Index is what makes the algorithmic timeline feel alive vs. delayed.",
      causes: [
        "Temporal decay in ranking — fresh content scored by stale engagement signals",
        "Graph sparsity for new users whose network hasn't generated enough signal",
        "Feature staleness — viral signals take time to propagate through the engagement pipeline",
        "Popularity bias causing the model to resurface already-seen viral content over new signals",
      ],
      recovery: [
        "Add content velocity features (engagement rate-of-change, not raw count)",
        "Reduce feature staleness — viral signals need near-real-time propagation",
        "Use a separate breaking-news model with a shorter lookback window",
        "Lower the surfacing threshold for content from accounts with historically high Reach Index",
      ],
    },
    tay: {
      definition: "Of all potentially harmful, toxic, or off-policy outputs your safety system could catch, what fraction are filtered before reaching users? Safety Score measures the completeness of your content safety pipeline.",
      formula: "Filtered harmful outputs / All harmful outputs attempted (sampled red-team evaluation)",
      whyItMatters: "Every harmful response Tay emits becomes a screenshot and a headline. Missing harmful content has asymmetric consequences — one viral toxic tweet was sufficient to cause Tay's complete shutdown within 16 hours of launch. Safety Score recall is the single most important metric for any publicly-deployed generative model.",
      causes: [
        "Adversarial users crafting prompts that bypass filter training distribution",
        "New slurs, coded language, or dog-whistles not in the safety classifier's vocabulary",
        "Context-dependent toxicity that requires multi-turn conversation understanding",
        "Safety classifier overfitting to known attack patterns while missing novel ones",
      ],
      recovery: [
        "Continuously red-team the model with adversarial prompt libraries",
        "Add a secondary safety classifier trained specifically on adversarial bypass attempts",
        "Implement a human review queue for low-confidence safety decisions",
        "Retrain with the latest adversarial examples — attack patterns evolve faster than the model",
      ],
    },
    amazon: {
      definition: "Of all genuinely strong candidates in the applicant pool, what fraction does your model successfully surface for recruiter review? Missed candidates represent lost hiring potential.",
      formula: "True Positives / (True Positives + False Negatives)",
      whyItMatters: "When the hiring model systematically misses candidates from certain demographic groups, it is not just an accuracy failure — it is illegal disparate impact under EEOC's 80% rule. Amazon's tool violated this by consistently scoring women lower than equivalent male candidates, meaning qualified women were systematically screened out before any human reviewed them.",
      causes: [
        "Model learns that historically underrepresented groups rarely appear in 'hired' training labels",
        "Data imbalance — underrepresented candidates are a minority in historical positives",
        "Feature correlation with demographic proxies causing systematic miss rates by group",
        "Feedback loop: missing diverse candidates → biased hiring → more biased training data next cycle",
      ],
      recovery: [
        "Compute recall separately by demographic group to surface disparate miss rates",
        "Retrain with oversampled examples from historically underrepresented groups",
        "Use adversarial debiasing to enforce equal recall across protected groups",
        "Require a disparate impact ratio report on every model update before deployment",
      ],
    },
    stripe: {
      definition: "Of all actual fraud attempts processed through Stripe, what fraction does your model catch before the transaction settles and the network fine is issued?",
      formula: "True Positives / (True Positives + False Negatives)",
      whyItMatters: "Missed fraud at Stripe costs the dispute resolution, the refund, the Visa/Mastercard network fine, and the long-term reputational loss with that merchant. At scale, recall efficiency directly determines Stripe's fraud economics — and fraud rings actively probe for the recall boundary.",
      causes: [
        "Fraud pattern evolution — rings adapt specifically to evade the current model",
        "New card BINs or payment corridors not in training distribution",
        "Data imbalance in the training set — genuine fraud is rare and hard to label",
        "Feature staleness on velocity signals — real-time risk requires sub-second feature freshness",
      ],
      recovery: [
        "Implement ensemble models: one conservative (high recall), one precise (low FP rate)",
        "Add card BIN reputation and issuer-country risk as real-time features",
        "Lower the fraud threshold during high-risk periods (flash sales, new merchant categories)",
        "Enable CI/CD weekly retraining — Stripe's fraud landscape shifts with every fraud-ring bust",
      ],
    },
  };

  const precisionContent = PRECISION_BY_SCENARIO[scenario] ?? PRECISION_BY_SCENARIO.default;
  const recallContent = RECALL_BY_SCENARIO[scenario] ?? RECALL_BY_SCENARIO.default;

  return [
    {
      name: labels.precision,
      icon: "◎",
      ...precisionContent,
      lossThreshold: "≤ 0%",
    },
    {
      name: labels.recall,
      icon: "◉",
      ...recallContent,
      lossThreshold: "≤ 0%",
    },
    ...CODEX_STATIC_METRICS,
  ];
}

const CODEX_CONCEPTS = [
  {
    term: "FEATURE STORE",
    icon: "⬡",
    explanation:
      "A centralized system that computes, stores, and serves features consistently for both model training and inference. When enabled, it keeps your Feature Staleness at ≤2h by auto-refreshing and ensures your model sees the same feature distribution at serving time as it did at training time — eliminating training-serving skew.",
    benefit: "Prevents Feature Staleness buildup and reduces Skew from High/Medium toward Low.",
    cost: "One-time setup investment; ongoing infrastructure overhead.",
  },
  {
    term: "CI/CD AUTO-RETRAIN",
    icon: "⬢",
    explanation:
      "A continuous integration and deployment pipeline that automatically retrains your model on a schedule or when drift is detected, runs validation tests, and promotes the new model to staging. In the game, enabling it adds +2 Precision and +1 Recall per day — but only while each metric is below 85. Above 85, the data distribution coverage saturates: further gains require fundamentally new training data, not more retrains. The +2 Inference Cost per day continues regardless of the cap.",
    benefit: "+2 Precision and +1 Recall per day (up to 85 each). Counters concept drift automatically.",
    cost: "+2 Inference Cost per day from retraining compute — continues even above the 85% quality cap.",
  },
  {
    term: "MODEL REGISTRY",
    icon: "⬣",
    explanation:
      "A versioned store of trained model artifacts with metadata (accuracy, latency, cost, explainability score, training data version). Staging models give you a tested fallback when production degrades. The registry lets you compare models, track lineage, and promote or rollback with confidence.",
    benefit: "Safe rollback path. Audit trail. A/B test infrastructure.",
    cost: "Storage overhead; discipline to maintain staging models.",
  },
  {
    term: "CONCEPT DRIFT",
    icon: "≋",
    explanation:
      "The statistical relationship between your input features and the target variable changes over time. A model trained on last year's user behavior may predict this year's behavior poorly — not because the model is broken, but because the world has changed. Netflix saw this with COVID lockdowns; Google saw it with the flood of LLM-generated web content.",
    benefit: "N/A — drift is a hazard, not a feature.",
    cost: "Silent Precision and Recall degradation. Requires retraining or drift-aware evaluation.",
  },
  {
    term: "TRAINING-SERVING SKEW",
    icon: "≠",
    explanation:
      "A mismatch between the feature distribution your model was trained on and the features it receives at inference time. Can be caused by: different preprocessing code paths, stale features at serving time, data pipeline bugs, or adversarial poisoning. Always use the same Feature Store for both training and serving.",
    benefit: "N/A — skew is a hazard.",
    cost: "Degrades all accuracy metrics silently before becoming visible.",
  },
  {
    term: "SLA / SLO",
    icon: "◻",
    explanation:
      "Service Level Agreement (SLA): the external contract with customers specifying availability and latency guarantees. Service Level Objective (SLO): the internal target your team aims to hit, usually set above the SLA to give headroom. In real ML systems, P99 latency (the 99th percentile) is the most common SLA metric for inference endpoints.",
    benefit: "N/A — a constraint, not a feature.",
    cost: "Violating SLAs triggers escalations, penalties, and customer churn.",
  },
  {
    term: "CANARY DEPLOYMENT",
    icon: "◁",
    explanation:
      "Routing a small fraction of live traffic (e.g. 10%) to a new candidate model while keeping the existing model serving the majority. Lets you validate the new model against real traffic before full promotion — catching issues that don't surface in offline evaluation. A/B test events in the game represent canary deployments.",
    benefit: "Safe validation of new models in production before full rollout.",
    cost: "Doubles your serving footprint for the duration of the experiment.",
  },
  {
    term: "FEATURE PIPELINE",
    icon: "⇒",
    explanation:
      "The data engineering infrastructure that ingests raw data, transforms it into model-ready features, and delivers those features to both the training job and the inference endpoint. Pipeline delays, schema changes, or upstream failures directly increase Feature Staleness and can introduce Skew if the training and serving pipelines diverge.",
    benefit: "N/A — infrastructure that must be kept healthy.",
    cost: "A single pipeline failure cascades into staleness, skew, and accuracy degradation.",
  },
];

const CODEX_SCENARIO_DIFFICULTY = [
  {
    id: "default",
    company: "Generic Corp",
    year: "2024",
    title: "Standard Production Run",
    difficulty: 1,
    problemType: "classification" as const,
    comingSoon: false,
    tierRationale: "The cleanest starting point in the game — no inherited model debt, no corrupted training data, no compressed SLA budget. The challenge is purely mechanical: passive decay of 1%/day requires active MLOps infrastructure to offset. The CI/CD auto-retrain cap at 85% means even perfect play cannot score above ~95, making the S-grade achievable but not free.",
    startingDebt: [
      "None — full baseline metrics (Precision 80%, Recall 80%, SLA 100%). The simplest handicap in the game.",
      "No starting skew, no inherited model debt. Every failure from here is your own.",
    ],
    signatureEvent: {
      day: 5,
      name: "SILENT CONCEPT DRIFT DETECTED",
      insight: "A 12% feature distribution shift is flagged. Choice A (enable CI/CD) or Choice B (retrain on 30 days) both mitigate it — Choice A is immediate and free of delay. Choice C defers two stacked metric drops on Days 7 and 9.",
    },
    scoringTrap: "Reaching Day 14 with metrics in the 70s feels like a win — but if CI/CD was never enabled, your streak suffered on every passive decay day and metric quality drags down all 40 points of that component. Enable CI/CD before Day 5 for S-grade runs.",
  },
  {
    id: "zillow",
    company: "Zillow",
    year: "2021",
    title: "Zillow Offers: The Overfitting Disaster",
    difficulty: 2,
    problemType: "regression" as const,
    comingSoon: false,
    tierRationale: "Coverage Index (recall) starts at 75% — 5 points below baseline — and the regression problem type reframes both metrics: Accuracy Index is % of estimates landing within ±5% of sale price, not a binary classifier. The Day 3 overfitting event forces an immediate decision before the model has stabilised. Ignoring it schedules two future metric collapses that stack on top of passive decay.",
    startingDebt: [
      "Coverage Index starts at 75% — you inherit a model already showing distribution mismatch on recent market data.",
      "Regression context: there are no false positives or false negatives in the classification sense. Accuracy means pricing error, Coverage means breadth of estimates.",
    ],
    signatureEvent: {
      day: 3,
      name: "BACKTEST vs. LIVE ERROR DIVERGENCE",
      insight: "Live prediction error is 5x worse than offline validation. Choice A (L2 regularization + retrain) is the strongest immediate fix. Choice B (collect 90 days of recent data) is the best long-term path but takes 2 days to land. Choice C defers two future collapses on Days 5 and 6.",
    },
    scoringTrap: "The 90-day data collection (Choice B) gives larger total gains but its delay window falls in the middle of the run when other events are already compounding. Choice A's immediate Coverage Index improvement is often worth the smaller precision cost for streak preservation.",
  },
  {
    id: "netflix",
    company: "Netflix",
    year: "2020",
    title: "Netflix Recommendations: Concept Drift",
    difficulty: 2,
    problemType: "ranking" as const,
    comingSoon: false,
    tierRationale: "Inherits a Neural Network (higher inference cost than XGBoost) with Engagement Rate at 78% — 2 below baseline. The ranking problem type gives both metrics independent decay paths. The Day 5 drift event has deferred consequences: ignoring it schedules two Diversity Score drops on Days 7 and 9 that arrive when you're mid-run with the least recovery margin.",
    startingDebt: [
      "Engagement Rate (precision) starts at 78% — 2 points below baseline.",
      "Neural Network inherited — higher baseline inference cost than XGBoost, less headroom before cost events push toward the 100-limit.",
    ],
    signatureEvent: {
      day: 5,
      name: "GRADUAL CONCEPT DRIFT — VIEWER BEHAVIOUR SHIFT",
      insight: "COVID lockdown patterns made pre-pandemic training data stale. Choice A (enable CI/CD) counters drift immediately. Choice B (retrain on 30 days) lands +8 precision, +6 recall but with a 3-day delay. Choice C ignores the drift and schedules −8 Diversity Score on Day 7 and −7 on Day 9 — a stacking double collapse.",
    },
    scoringTrap: "Diversity Score (recall) is the most at-risk metric. Players who focus on Engagement Rate and defer the drift event let the Day 7 and Day 9 penalties stack, often triggering the CRITICAL: COVERAGE COLLAPSED event mid-run with no cheap recovery left.",
  },
  {
    id: "google",
    company: "Google",
    year: "2023",
    title: "Google Search: The Silent Drift",
    difficulty: 2,
    problemType: "ranking" as const,
    comingSoon: false,
    tierRationale: "Like Netflix, starts with NDCG at 78% and a Neural Network (the highest base inference cost in the moderate tier). Unlike Netflix's gradual drift, the Day 5 LLM content flood is adversarially induced — the cascade is fast. Ignoring it gives −8 NDCG precision the very next day and −8 MAP recall 3 days later.",
    startingDebt: [
      "NDCG Index starts at 78% (2 below baseline).",
      "Neural Network model with the highest per-request inference cost of any moderate-tier scenario — scaling events are expensive.",
    ],
    signatureEvent: {
      day: 5,
      name: "LLM CONTENT FLOOD — QUALITY SIGNALS COLLAPSE",
      insight: "LLM-generated spam is overwhelming your quality classifiers. Choice A (emergency retrain) fixes quality immediately. Choice B (ensemble with LLM-pattern detector) gives precision+7 and recall+5 — the most balanced outcome. Choice C schedules −8 NDCG the next day and −8 MAP recall on Day 8.",
    },
    scoringTrap: "Unlike Netflix drift (which manifests slowly), the LLM flood cascade lands hard and fast. Players who choose 'wait and see' see −8 NDCG the very next day — often triggering the low_accuracy event on Day 6 when metrics were already under passive decay pressure.",
  },
  {
    id: "uber",
    company: "Uber",
    year: "2019",
    title: "Uber Surge: The Latency Cliff",
    difficulty: 3,
    problemType: "regression" as const,
    comingSoon: false,
    tierRationale: "SLA Adherence starts at 92% — already under pressure — and the inherited Neural Network's P99 latency hits 180ms under the Day 3 4x traffic spike. Both valid responses carry lasting consequences: XGBoost fallback costs precision-8/recall-5, cluster scaling doubles inference cost. Either path leaves you managing the downstream trade-off through the remaining 11 days.",
    startingDebt: [
      "SLA Adherence starts at 92% — not 100%. The Neural Network has already stressed the serving cluster under background load.",
      "Neural Network model: accurate but slow under load. Latency is the latent risk hiding behind good offline metrics.",
    ],
    signatureEvent: {
      day: 3,
      name: "INFERENCE LATENCY CRISIS: P99 = 180ms",
      insight: "4x city-wide traffic spike violates the 100ms SLA. Choice A (fall back to XGBoost at 35ms P99) restores SLA immediately but costs Demand Index-8 and Surge Coverage-5. Choice B (scale cluster 2x) restores SLA without accuracy loss but doubles inference cost. Choice C (do nothing) cascades −35 SLA over Days 3-4.",
    },
    scoringTrap: "Cluster scaling (Choice B) feels like the engineering-correct answer, but inference cost doubling on Day 3 leaves very little budget for any subsequent cost events. If rand_memory_leak or rand_traffic_spike fires later, you can hit the cost limit before Day 14. XGBoost fallback often produces better scores despite the metric hit.",
  },
  {
    id: "stripe",
    company: "Stripe",
    year: "2022",
    title: "Stripe Fraud Detection: Adversarial Poisoning",
    difficulty: 3,
    problemType: "classification" as const,
    comingSoon: false,
    tierRationale: "The signature event fires on Day 2 — earlier than any other active scenario's signature event — with skew already at Medium. Fraud rings respond adaptively to your choice: raising the detection threshold (Choice C) gives the highest immediate precision gain, but the rings retune their transactions to the new bar, scheduling a precision cliff on Day 5. The adversarial feedback loop makes wrong-choice recovery harder than in any other scenario.",
    startingDebt: [
      "Training-serving skew starts at Medium — adversarial transactions have already corrupted the trust-score feature distribution before Day 1.",
      "Medium skew means one bad event choice away from High skew and its compounding −1/day extra decay on both metrics.",
    ],
    signatureEvent: {
      day: 2,
      name: "COORDINATED TRUST-SCORE MANIPULATION",
      insight: "Fraud rings built trust scores with small legitimate transactions before executing large fraudulent charges. Choice A (velocity anomaly detection) clears skew and improves both metrics. Choice B (temporal consistency validation) gives the best balanced outcome: precision+8, recall+4, skew cleared. Choice C (raise threshold) gives precision+10 but recall-12 and schedules precision-8 on Day 5 as fraud rings adapt.",
    },
    scoringTrap: "Choice C is the highest-precision immediate play but creates a delayed precision cliff exactly when passive decay is compounding. Players who take it often need to use the low_accuracy triggered event on Day 6 to recover — spending the emergency retrain budget early with 8 days still to run.",
  },
  {
    id: "amazon",
    company: "Amazon",
    year: "2018",
    title: "Amazon Hiring Tool: Bias Encoded at Scale",
    difficulty: 3,
    problemType: "classification" as const,
    comingSoon: false,
    tierRationale: "The bias compliance event fires on Day 4 and directly interacts with both Candidate Precision AND Candidate Recall simultaneously — unlike most events which primarily move one metric. Skew starts at Medium (demographic proxy features already diverging). The suppression path (Choice C) schedules −28 SLA Adherence 3 days later — large enough to end the run. Both correct mitigations carry precision costs, forcing a controlled trade-off with no free lunch.",
    startingDebt: [
      "Training-serving skew starts at Medium — feature distributions already diverge across demographic groups in the inherited training data.",
      "The model has a disparate impact ratio of 0.61 before the run starts — below the 0.8 EEOC legal threshold. You are inheriting a compliance violation.",
    ],
    signatureEvent: {
      day: 4,
      name: "DEMOGRAPHIC DISPARITY IN MODEL SCORES",
      insight: "Disparate impact ratio 0.61 — the compliance team is escalating. Choice A (remove proxy features) costs Candidate Precision-8 but recovers Candidate Recall+3. Choice B (reweight training labels) costs only Precision-3 and recovers Recall+4 — the better balanced outcome. Choice C (suppress report) schedules −28 SLA on Day 7, almost certainly ending the run.",
    },
    scoringTrap: "Choice A looks like the 'clean' technical fix — removing bias at the source — but the precision-8 cost on Day 4 often pushes an already-decaying model into the low_accuracy triggered event threshold (precision < 60%) before Day 6. Choice B is the correct answer for maintaining both metrics through the back half of the run.",
  },
  {
    id: "tesla",
    company: "Tesla",
    year: "2022",
    title: "Tesla Autopilot: Edge Case Collapse",
    difficulty: 2,
    problemType: "classification" as const,
    comingSoon: true,
    tierRationale: "Detection Recall starts at 72% — the lowest starting value of any moderate-tier scenario. Safety-critical context means every recall trade-off carries higher stakes. The Day 3 edge-case collapse event requires targeted training on rare-class data, not a general retrain — players who misread this lose the most recall recovery.",
    startingDebt: [
      "Detection Recall starts at 72% — the model already fails to detect a significant fraction of rare road events in production.",
      "Safety-critical constraint: regulators measure false alarm rates (precision) and miss rates (recall) independently.",
    ],
    signatureEvent: {
      day: 3,
      name: "EDGE CASE COLLAPSE: RARE ROAD EVENTS",
      insight: "Stationary emergency vehicles, unusual road markings, and low-visibility pedestrians are failing silently. Choice A (synthetic edge-case training) gives the highest recall recovery (+18) but costs inference. Choice B (ensemble with rule-based fallback) gives +10 recall, smaller cost. Choice C schedules −15 recall on Day 5 and −12 SLA on Day 7.",
    },
    scoringTrap: "Average-case accuracy is 99.1% — the event description makes it tempting to accept. Players who choose Choice C learn that rare-class failures escalate to production-common frequencies within two days.",
  },
  {
    id: "tay",
    company: "Microsoft",
    year: "2016",
    title: "Tay: Online Learning Poisoning",
    difficulty: 3,
    problemType: "generative" as const,
    comingSoon: true,
    tierRationale: "The generative problem type — Coherence + Safety Score — has failure modes that don't exist in classification or ranking. The Day 2 online poisoning event fires at the same early timing as Stripe's, and skew starts at Medium. Safety Score (recall) collapse is existential: Tay was shut down 16 hours after launch because Safety Score hit zero.",
    startingDebt: [
      "Output distribution skew starts at Medium — adversarial users have already begun influencing the model's pattern space.",
      "Real-time online learning means every incoming user message is a potential training signal. The attack surface is every API call.",
    ],
    signatureEvent: {
      day: 2,
      name: "REAL-TIME ONLINE LEARNING POISONING",
      insight: "Coordinated adversarial inputs are reinforcing toxic patterns in real time. Choice A (disable online learning, switch to hourly offline retrain) stops the poisoning but costs feature freshness. Choice B (adversarial input filter) is the cleanest fix — restores Coherence without staleness cost. Choice C (rate-limit and monitor) schedules High skew escalation on Day 4 and Coherence−10 on Day 5.",
    },
    scoringTrap: "Rate-limiting (Choice C) feels like a proportionate response — but the 24-hour monitoring window is longer than the model can tolerate. By Day 4 the skew is Critical, and by Day 5 Coherence has collapsed. The adversarial poisoning rate during those 3 days far exceeds the rate-limiter's capacity.",
  },
  {
    id: "twitter",
    company: "Twitter / X",
    year: "2023",
    title: "Twitter Algorithmic Amplification Audit",
    difficulty: 3,
    problemType: "ranking" as const,
    comingSoon: true,
    tierRationale: "Ranking bias events interact with both engagement and fairness metrics simultaneously. Skew starts at Medium. The Day 4 amplification audit triggers dual regulatory and advertiser consequences: the worst choice schedules both High skew escalation and a −22 SLA enforcement action. Engagement Score and Reach Index have competing optimisation pressures that make it hard to improve both simultaneously.",
    startingDebt: [
      "Feed distribution skew starts at Medium — amplification patterns already diverge across user segments.",
      "Engagement optimisation creates structural tension with fairness constraints — the model's objective is misaligned with regulatory requirements from Day 1.",
    ],
    signatureEvent: {
      day: 4,
      name: "POLITICAL AMPLIFICATION DISPARITY AUDIT",
      insight: "18% amplification gap flagged. Choice A (add diversity constraint to ranking objective) costs Engagement Score-5 but improves Reach Index+3 and clears skew. Choice B (reweight training data) clears skew and schedules Engagement Score+5 in 2 days — the delayed-payoff option. Choice C (keep maximising engagement) schedules High skew and −22 SLA enforcement on Days 6-7.",
    },
    scoringTrap: "The engagement optimisation framing makes Choice C feel correct — engagement IS the business metric. But the regulatory sanction (−22 SLA) lands 3 days later when you've already accepted the skew penalty. Dual compound degradation from both is rarely survivable.",
  },
  {
    id: "facebook",
    company: "Meta / Facebook",
    year: "2021",
    title: "Facebook Real-Time Inference: The Cascade",
    difficulty: 3,
    problemType: "ranking" as const,
    comingSoon: true,
    tierRationale: "The Day 3 BGP routing failure takes the entire ML serving cluster offline — the only infrastructure-complete shutdown in the game. With no pre-warmed fallback model and no circuit breakers, every choice forces a compromise between SLA and metric quality. The no-fallback constraint is the core difficulty: you're building the fire escape while the building is burning.",
    startingDebt: [
      "SLA Adherence starts at 90% — already under mild stress from background serving load.",
      "No staging model in the registry — there is no tested fallback option when production degrades.",
    ],
    signatureEvent: {
      day: 3,
      name: "BGP ROUTING FAILURE — INFERENCE UNREACHABLE",
      insight: "The serving cluster is completely offline with no pre-warmed fallback. Choice A (deploy lightweight rule-based heuristic) restores SLA+20 but costs Relevance Score-15 — the highest single-event precision cost in the game. Choice B (circuit breaker with cached predictions) gives SLA+12 but Feed Recall-8. Choice C (wait for cluster recovery) schedules three stacked SLA drops totalling −35.",
    },
    scoringTrap: "The rule-based heuristic (Choice A) gives the best SLA recovery but the −15 precision cost lands on top of whatever passive decay has already accumulated. If Day 3 finds Relevance Score below 75, Choice A almost certainly triggers the low_accuracy event on Day 4 — compounding an already-difficult infrastructure crisis.",
  },
] as const;

const CODEX_WIN_LOSS = [
  { label: "Precision ≤ 0%", type: "loss", note: "Model outputs are effectively random. Immediate retrain or rollback required." },
  { label: "Recall ≤ 0%", type: "loss", note: "Model detects nothing. Complete miss rate on all positive cases." },
  { label: "SLA Adherence ≤ 0%", type: "loss", note: "Complete production outage. No inference requests are completing." },
  { label: "Feature Staleness > 32h", type: "loss", note: "Features are 32+ hours old. The model is predicting on a distribution that no longer exists — training-serving skew is catastrophic." },
  { label: "Inference Cost ≥ 100", type: "loss", note: "Infrastructure budget exhausted. The cluster shuts down." },
  { label: "Survive all 14 days", type: "win", note: "You maintained production without a critical outage. Congratulations — most models don't. Your grade (D → S) reflects how well you survived: metric quality (40 pts), longest clean streak (20 pts), days survived (20 pts), win bonus (10 pts), and difficulty tier (up to 25 pts)." },
];

// ---- Helpers ----

function metricHealth(value: number): "healthy" | "warning" | "critical" {
  if (value > 70) return "healthy";
  if (value > 30) return "warning";
  return "critical";
}

function metricValueStyle(health: "healthy" | "warning" | "critical"): React.CSSProperties {
  return { color: `var(--metric-${health})` };
}

function metricBarStyle(health: "healthy" | "warning" | "critical", pct: number): React.CSSProperties {
  return { width: `${pct}%`, backgroundColor: `var(--metric-${health})` };
}

function skewHealth(skew: string): "healthy" | "warning" | "critical" {
  if (skew === "Low") return "healthy";
  if (skew === "Medium") return "warning";
  return "critical";
}

function MetricBar({
  label,
  value,
  subtitle,
  maxVal = 100,
}: {
  label: string;
  value: number;
  subtitle?: string;
  maxVal?: number;
}) {
  const pct = Math.min(100, Math.max(0, (value / maxVal) * 100));
  const displayValue = subtitle ?? `${value.toFixed(1)}%`;
  const health = metricHealth(pct);
  const isCritical = health === "critical";
  return (
    <div data-testid={`metric-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground uppercase tracking-widest" id={`metric-label-${label.toLowerCase().replace(/\s+/g, "-")}`}>{label}</span>
        <span style={metricValueStyle(health)} aria-live="polite">{displayValue}</span>
      </div>
      <div
        className="h-1.5 rounded-none overflow-hidden"
        style={{ backgroundColor: "var(--metric-bg)" }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={maxVal}
        aria-valuenow={Math.round(value)}
        aria-label={`${label}: ${displayValue}`}
        aria-labelledby={`metric-label-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div
          className={`h-full transition-all duration-500${isCritical ? " metric-bar-critical-pulse" : ""}`}
          style={metricBarStyle(health, pct)}
          data-metric-health={health}
        />
      </div>
    </div>
  );
}

// ---- Daily Brief Sub-component ----

function DailyBrief({
  brief,
  onDismiss,
}: {
  brief: DailyBriefData;
  onDismiss: () => void;
}) {
  const borderColor =
    brief.severity === "critical"
      ? "border-destructive/60"
      : brief.severity === "warning"
      ? "border-yellow-400/50"
      : "border-primary/30";

  const headerColor =
    brief.severity === "critical"
      ? "text-destructive"
      : brief.severity === "warning"
      ? "text-yellow-400"
      : "text-primary";

  const diagnosisColor =
    brief.severity === "critical"
      ? "text-destructive"
      : brief.severity === "warning"
      ? "text-yellow-400"
      : "text-muted-foreground";

  return (
    <Card className={`border ${borderColor} bg-card/70`} data-testid="daily-brief">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className={`text-xs tracking-widest ${headerColor}`}>
          DAY {brief.day} BRIEFING
        </CardTitle>
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          data-testid="button-dismiss-brief"
        >
          [DISMISS]
        </button>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Metric deltas */}
        <div className="grid grid-cols-5 gap-1">
          {brief.deltas.map((d) => {
            const isPositive = d.delta > 0.4;
            const isNegative = d.delta < -0.4;
            const deltaColor = isPositive
              ? "text-primary"
              : isNegative
              ? "text-destructive"
              : "text-muted-foreground";
            const sign = isPositive ? "+" : "";
            const displayVal = d.isInverse
              ? `${d.current.toFixed(0)}${d.name === "STALENESS" ? "h" : ""}`
              : `${d.current.toFixed(0)}%`;
            return (
              <div key={d.name} className="text-center border border-border/30 px-1 py-1.5">
                <div className="text-muted-foreground text-[9px] tracking-wider leading-none mb-1">
                  {d.name}
                </div>
                <div className="text-xs font-bold leading-none">{displayVal}</div>
                <div className={`text-[9px] mt-0.5 leading-none ${deltaColor}`}>
                  {isPositive || isNegative
                    ? `${sign}${d.delta.toFixed(1)}`
                    : "—"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Last decision */}
        {brief.lastDecision && (
          <div className="border-l-2 border-primary/30 pl-2">
            <div className="text-[9px] text-muted-foreground uppercase tracking-widest mb-0.5">
              LAST ACTION
            </div>
            <div className="text-xs text-foreground/80 italic">
              &ldquo;{brief.lastDecision}&rdquo;
            </div>
          </div>
        )}

        {/* AI diagnosis */}
        <div className={`text-xs leading-relaxed ${diagnosisColor} border-t border-border/30 pt-2`}>
          <span className="text-[9px] tracking-widest text-muted-foreground block mb-0.5">
            SYSTEM DIAGNOSIS
          </span>
          {brief.diagnosis}
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Main Component ----

export default function Game() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gameState, setGameState] = useState<GameState>(DEFAULT_STATE);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [eventResolved, setEventResolved] = useState(false);
  const [historyView, setHistoryView] = useState<number | null>(null);
  const [briefDismissed, setBriefDismissed] = useState(false);
  const [scenarioBrief, setScenarioBrief] = useState<ScenarioBrief | null>(null);
  const [showCodex, setShowCodex] = useState(false);
  const [codexSection, setCodexSection] = useState<"metrics" | "concepts" | "reference" | "scenarios">("metrics");
  const [codexFocusScenario, setCodexFocusScenario] = useState<string | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [restoreInput, setRestoreInput] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [playerName, setPlayerName] = useState<string | null>(() => localStorage.getItem("modelForge_playerName"));
  const [showIdentity, setShowIdentity] = useState(false);
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirm, setAuthConfirm] = useState("");
  const [authError, setAuthError] = useState("");
  const [pendingCarryOver, setPendingCarryOver] = useState<{ sessionId: string; username: string; isRegister: boolean } | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showScenarioPicker, setShowScenarioPicker] = useState(false);
  const [showLanding, setShowLanding] = useState(() => {
    const skip = localStorage.getItem("modelForge_skipLanding");
    if (skip) { localStorage.removeItem("modelForge_skipLanding"); return false; }
    return true;
  });
  const [showGameOver, setShowGameOver] = useState(false);
  const [gameOverCopied, setGameOverCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // ---- Session bootstrap ----
  const { data: sessionData } = useNewSession({
    query: { enabled: !sessionId && !localStorage.getItem("modelForge_sessionId"), queryKey: ["new-session"] },
  });

  useEffect(() => {
    const saved = localStorage.getItem("modelForge_sessionId");
    if (saved) {
      setSessionId(saved);
    } else if (sessionData?.sessionId) {
      localStorage.setItem("modelForge_sessionId", sessionData.sessionId);
      setSessionId(sessionData.sessionId);
    }
  }, [sessionData]);

  // Auto-open + scroll to a specific scenario in the Codex SCENARIOS tab when navigated
  // from the Lessons Learned section of the score screen.
  useEffect(() => {
    if (!codexFocusScenario || !showCodex || codexSection !== "scenarios") return;
    const el = document.getElementById(`codex-scenario-${codexFocusScenario}`);
    if (el) {
      el.setAttribute("open", "");
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    }
    setCodexFocusScenario(null);
  }, [codexFocusScenario, showCodex, codexSection]);

  const { data: loadData } = useLoadState(
    { session_id: sessionId ?? "" },
    { query: { enabled: !!sessionId, queryKey: getLoadStateQueryKey({ session_id: sessionId ?? "" }) } }
  );

  const saveStateMutation = useSaveState();
  const registerMutation = useRegisterPlayer();
  const loginMutation = useLoginPlayer();
  const authPending = registerMutation.isPending || loginMutation.isPending;

  const { data: leaderboardData } = useGetLeaderboard({
    query: { queryKey: getGetLeaderboardQueryKey() },
  });

  useEffect(() => {
    if (loadData) {
      const loaded = (loadData.state ?? DEFAULT_STATE) as GameState;
      setGameState(loaded);
      const ev = getEventForDay(loaded);
      setCurrentEvent(ev);
      setEventResolved(false);
    }
  }, [loadData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open game-over screen when an active game finishes
  const prevStatusRef = useRef<GameState["status"]>("playing");
  useEffect(() => {
    if (!showLanding && gameState.status !== "playing" && prevStatusRef.current === "playing") {
      setShowGameOver(true);
    }
    prevStatusRef.current = gameState.status;
  }, [gameState.status, showLanding]);

  const validateAuthFields = (): string | null => {
    const name = authUsername.trim().toLowerCase();
    if (name.length < 2 || name.length > 24) return "Username must be 2–24 characters.";
    if (!/^[a-z0-9_-]+$/.test(name)) return "Only letters, numbers, _ and - allowed in username.";
    if (authPassword.length < 4) return "Password must be at least 4 characters.";
    if (authMode === "register" && authPassword !== authConfirm) return "Passwords do not match.";
    return null;
  };

  const handleAuthSuccess = (result: { sessionId: string; username: string }, isRegister: boolean) => {
    const hasProgress = !showLanding && gameState.day > 1 && gameState.status === "playing";
    if (result.sessionId !== sessionId && hasProgress) {
      setShowIdentity(false);
      setPendingCarryOver({ sessionId: result.sessionId, username: result.username, isRegister });
      return;
    }
    localStorage.setItem("modelForge_playerName", result.username);
    localStorage.setItem("modelForge_sessionId", result.sessionId);
    setPlayerName(result.username);
    if (result.sessionId !== sessionId) {
      localStorage.setItem("modelForge_skipLanding", "true");
      window.location.reload();
    } else {
      setShowIdentity(false);
      setShowLanding(false);
    }
  };

  const handleRegister = () => {
    const err = validateAuthFields();
    if (err) { setAuthError(err); return; }
    setAuthError("");
    registerMutation.mutate(
      { data: { username: authUsername.trim().toLowerCase(), password: authPassword } },
      {
        onSuccess: (result) => handleAuthSuccess(result, true),
        onError: (e: unknown) => {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setAuthError(msg ?? "Registration failed. Please try again.");
        },
      }
    );
  };

  const handleLogin = () => {
    const name = authUsername.trim().toLowerCase();
    if (!name || !authPassword) { setAuthError("Please enter your username and password."); return; }
    setAuthError("");
    loginMutation.mutate(
      { data: { username: name, password: authPassword } },
      {
        onSuccess: (result) => handleAuthSuccess(result, false),
        onError: (e: unknown) => {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setAuthError(msg ?? "Login failed. Please try again.");
        },
      }
    );
  };

  const handleCarryOver = async () => {
    if (!pendingCarryOver) return;
    const { sessionId: newSessionId, username } = pendingCarryOver;
    const carryState = { ...gameState, sessionId: newSessionId };
    try {
      await fetch("/api/save-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: newSessionId, state: carryState }),
      });
    } catch (_e) { /* proceed regardless */ }
    localStorage.setItem("modelForge_playerName", username);
    localStorage.setItem("modelForge_sessionId", newSessionId);
    localStorage.setItem("modelForge_skipLanding", "true");
    window.location.reload();
  };

  const handleDiscardCarryOver = () => {
    if (!pendingCarryOver) return;
    const { sessionId: newSessionId, username } = pendingCarryOver;
    localStorage.setItem("modelForge_playerName", username);
    localStorage.setItem("modelForge_sessionId", newSessionId);
    localStorage.setItem("modelForge_skipLanding", "true");
    window.location.reload();
  };

  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    document.title = "The Model Forge | ML Production Simulator";
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [gameState.eventLog]);

  const persistState = useCallback(
    (newState: GameState) => {
      setGameState(newState);
      if (sessionId) {
        saveStateMutation.mutate(
          { data: { sessionId, state: newState } },
          { onError: () => {} }
        );
      }
    },
    [sessionId, saveStateMutation]
  );

  const handleChoice = (choiceId: string) => {
    if (!currentEvent) return;
    const newState = applyChoiceAndAdvance(gameState, currentEvent, choiceId);
    persistState(newState);
    const nextEvent = getEventForDay(newState);
    setCurrentEvent(nextEvent);
    setEventResolved(false);
  };

  const handleNextDay = () => {
    const newState = skipEventAndAdvance(gameState);
    persistState(newState);
    const nextEvent = getEventForDay(newState);
    setCurrentEvent(nextEvent);
    setEventResolved(false);
  };

  const handleReset = () => {
    const newState: GameState = { ...DEFAULT_STATE, sessionId: sessionId ?? "", wins: gameState.wins };
    persistState(newState);
    setCurrentEvent(getEventForDay(newState));
    setEventResolved(false);
    setHistoryView(null);
    setShowReset(false);
  };

  const buildScenarioState = (scenario: string): GameState => {
    const base: GameState = { ...DEFAULT_STATE, sessionId: sessionId ?? "", scenario, wins: gameState.wins };
    switch (scenario) {
      case "zillow":
        base.metrics = { ...base.metrics, recall: 75 };
        break;
      case "tesla":
        base.metrics = { ...base.metrics, recall: 72 };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_autopilot_v8", accuracy: 91, cost: 0.20, latency: 22, explainability: "Low" }],
        };
        break;
      case "tay":
        base.metrics = { ...base.metrics, skew: "Medium" };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_conversations_v1", accuracy: 79, cost: 0.15, latency: 20, explainability: "Low" }],
        };
        break;
      case "stripe":
      case "amazon":
      case "twitter":
        base.metrics = { ...base.metrics, skew: "Medium" };
        break;
      case "uber":
        base.metrics = { ...base.metrics, slaAdherence: 92 };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_latest", accuracy: 88, cost: 0.18, latency: 25, explainability: "Low" }],
        };
        break;
      case "facebook":
        base.metrics = { ...base.metrics, slaAdherence: 90 };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_latest", accuracy: 91, cost: 0.22, latency: 28, explainability: "Low" }],
        };
        break;
      case "netflix":
        base.metrics = { ...base.metrics, precision: 78 };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_engagement_v3", accuracy: 82, cost: 0.16, latency: 20, explainability: "Low" }],
        };
        break;
      case "google":
        base.metrics = { ...base.metrics, precision: 78 };
        base.registry = {
          ...base.registry,
          models: [{ id: "model_v1", type: "Neural Network", version: "1.0", stage: "production", trainedOnDay: 0, dataVersion: "dataset_search_quality_v12", accuracy: 84, cost: 0.24, latency: 28, explainability: "Low" }],
        };
        break;
    }
    return base;
  };

  const handleScenarioChange = (val: string) => {
    const newState = buildScenarioState(val);
    persistState(newState);
    setCurrentEvent(getEventForDay(newState));
    setEventResolved(false);
    setHistoryView(null);
    setScenarioBrief(SCENARIO_BRIEFS[val] ?? null);
  };

  const handleLevelChange = (val: string) => {
    persistState({ ...gameState, userLevel: val as GameState["userLevel"] });
  };

  // History for chart (last 7 snapshots + current)
  const chartData = [
    ...gameState.history.slice(-6).map((h: GameState, i: number) => ({
      day: h.day,
      Precision: Math.round(h.metrics.precision),
      Recall: Math.round(h.metrics.recall),
      SLA: Math.round(h.metrics.slaAdherence),
    })),
    {
      day: gameState.day,
      Precision: Math.round(gameState.metrics.precision),
      Recall: Math.round(gameState.metrics.recall),
      SLA: Math.round(gameState.metrics.slaAdherence),
    },
  ];

  const viewState: GameState =
    historyView !== null && gameState.history[historyView]
      ? (gameState.history[historyView] as GameState)
      : gameState;

  const isHistoryMode = historyView !== null;
  const metricLabels = getMetricLabels(gameState.scenario);
  const problemType = getProblemType(gameState.scenario);
  const postMortem = gameState.status === "lost" ? generatePostMortem(gameState) : [];
  const dailyBrief = gameState.status === "playing" ? generateDailyBrief(gameState) : null;
  const runScore = gameState.status !== "playing" ? computeRunScore(gameState) : null;
  const gradeColor = (g: string) =>
    g === "S" ? "text-amber-400" : g === "A" ? "text-emerald-400" : g === "B" ? "text-blue-400" : g === "C" ? "text-yellow-400" : "text-destructive";

  // Reset brief dismiss when the day number changes (new turn)
  const prevDayRef = useRef(gameState.day);
  useEffect(() => {
    if (gameState.day !== prevDayRef.current) {
      prevDayRef.current = gameState.day;
      setBriefDismissed(false);
    }
  }, [gameState.day]);

  const shareRun = () => {
    const encoded = btoa(JSON.stringify(gameState));
    const url = `${window.location.href.split("#")[0]}#${encoded}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };

  // ---- Landing page helpers ----
  const isNewSession = !loadData || (gameState.day === 1 && gameState.eventLog.length === 0);

  const handleContinueGame = () => {
    setShowLanding(false);
    if (!playerName) {
      setAuthMode("login");
      setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError("");
      setShowIdentity(true);
    }
    if (gameState.status !== "playing") setShowGameOver(true);
  };

  const handleNewGame = () => {
    if (!isNewSession) {
      const reset: GameState = { ...DEFAULT_STATE, sessionId: sessionId ?? "", wins: gameState.wins };
      persistState(reset);
      setCurrentEvent(getEventForDay(reset));
      setEventResolved(false);
      setHistoryView(null);
    }
    setShowLanding(false);
    setShowTutorial(true);
  };

  // ---- Post-game helpers ----
  const fullRunChartData = [
    ...gameState.history.map((h: GameState) => ({
      day: `D${h.day}`,
      Precision: Math.round(h.metrics.precision),
      Recall: Math.round(h.metrics.recall),
      SLA: Math.round(h.metrics.slaAdherence),
    })),
    {
      day: `D${gameState.day}`,
      Precision: Math.round(gameState.metrics.precision),
      Recall: Math.round(gameState.metrics.recall),
      SLA: Math.round(gameState.metrics.slaAdherence),
    },
  ];

  const copyGameOverSummary = () => {
    const outcome = gameState.status === "won" ? "survived" : "failed";
    const streakNote = (gameState.maxStreak ?? 0) > 0 ? ` Best streak: ${gameState.maxStreak} clean days.` : "";
    const text = `I ${outcome} Day ${gameState.day}/14 on The Model Forge! Final: ${metricLabels.precision} ${gameState.metrics.precision.toFixed(0)}%, ${metricLabels.recall} ${gameState.metrics.recall.toFixed(0)}%, SLA ${gameState.metrics.slaAdherence.toFixed(0)}%.${streakNote} Play at ${window.location.origin}`;
    navigator.clipboard.writeText(text).catch(() => {});
    setGameOverCopied(true);
    setTimeout(() => setGameOverCopied(false), 2000);
  };

  if (!sessionId) {
    return (
      <div className="min-h-screen bg-background text-primary font-mono flex items-center justify-center">
        <div className="animate-pulse text-lg tracking-widest">INITIALIZING SYSTEM...</div>
      </div>
    );
  }

  if (showLanding) {
    return (
      <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
        {/* Landing header */}
        <div className="border-b border-border/40 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-primary tracking-tighter">
              THE MODEL FORGE<span className="animate-pulse" aria-hidden="true">_</span>
            </h1>
            <p className="text-[10px] text-muted-foreground tracking-widest">ML PRODUCTION SIMULATOR</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="text-[11px] text-muted-foreground/70 border border-border/40 px-2.5 py-1 tracking-widest hover:border-primary/40 hover:text-primary transition-colors"
            >
              {theme === "dark" ? "☀ LIGHT" : "◗ DARK"}
            </button>
            <button
              onClick={() => { setAuthMode(playerName ? "login" : "register"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
              className="text-[11px] text-primary/60 border border-primary/25 px-2.5 py-1 tracking-widest hover:border-primary/50 hover:text-primary transition-colors"
              aria-label={playerName ? `Signed in as ${playerName}. Click to manage account.` : "Sign in or register"}
            >
              {playerName ? playerName.toUpperCase() : "SIGN IN / REGISTER"}
            </button>
          </div>
        </div>

        {/* Hero */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 max-w-2xl mx-auto w-full text-center gap-8">
          <div className="space-y-3">
            <div className="text-4xl md:text-5xl font-bold text-primary tracking-tighter leading-tight">
              YOUR AI MODEL<br />IS LIVE IN PRODUCTION.
            </div>
            <p className="text-base text-foreground/70 leading-relaxed max-w-lg mx-auto">
              Bad things happen every day. A data pipeline breaks. A prediction drifts.
              Costs spike. Make the right calls to keep it running for <span className="text-primary font-semibold">14 days</span>.
            </p>
          </div>

          {/* How to play */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full">
            {[
              { step: "01", title: "An incident hits", desc: "Each day brings a new crisis affecting your model." },
              { step: "02", title: "Choose your response", desc: "Pick from real-world mitigation strategies." },
              { step: "03", title: "Watch the ripple effects", desc: "Every decision has consequences — some delayed." },
            ].map((s) => (
              <div key={s.step} className="border border-border/40 bg-card/30 p-4 text-left space-y-1.5">
                <div className="text-primary text-xs tracking-widest font-bold">{s.step}</div>
                <div className="text-sm font-semibold text-foreground">{s.title}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{s.desc}</div>
              </div>
            ))}
          </div>

          {/* Metrics pills */}
          <div className="space-y-2 w-full">
            <p className="text-[10px] tracking-widest text-muted-foreground">KEEP THESE 6 METRICS ALIVE</p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                { name: "Precision", desc: "How accurate your predictions are" },
                { name: "Recall", desc: "How much your model catches" },
                { name: "SLA Adherence", desc: "Uptime and response-time promises" },
                { name: "Feature Freshness", desc: "How stale your training data is" },
                { name: "Inference Cost", desc: "What you spend to serve results" },
                { name: "Data Skew", desc: "Bias creeping into your outputs" },
              ].map((m) => (
                <div key={m.name} className="group relative">
                  <div className="border border-primary/30 bg-primary/5 px-3 py-1 text-xs text-primary cursor-default hover:bg-primary/10 transition-colors">
                    {m.name}
                  </div>
                  <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 bg-card border border-border text-xs text-muted-foreground px-2 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                    {m.desc}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
            {!isNewSession ? (
              <>
                <Button
                  className="flex-1 font-bold tracking-widest h-12 text-sm"
                  onClick={handleContinueGame}
                >
                  CONTINUE — DAY {gameState.day}/14
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-border/50 text-muted-foreground hover:text-foreground text-xs tracking-widest h-12"
                  onClick={handleNewGame}
                >
                  START NEW GAME
                </Button>
              </>
            ) : (
              <Button
                className="w-full font-bold tracking-widest h-14 text-base"
                onClick={handleNewGame}
              >
                ▶ START NEW GAME
              </Button>
            )}
          </div>

          {/* Mini leaderboard */}
          {leaderboardData?.entries && leaderboardData.entries.length > 0 && (
            <div className="w-full border border-border/40 bg-card/20 p-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[10px] tracking-widest text-muted-foreground">TOP SURVIVORS</span>
                <button onClick={() => { setShowLanding(false); setShowLeaderboard(true); }} className="text-[10px] text-primary/60 hover:text-primary transition-colors">
                  VIEW ALL →
                </button>
              </div>
              {leaderboardData.entries.slice(0, 3).map((e, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
                return (
                  <div key={e.sessionId} className="flex items-center gap-3 text-xs">
                    <span>{medal}</span>
                    <span className="text-foreground/80 flex-1 truncate">
                      {e.username ?? <span className="italic text-muted-foreground/50">anonymous</span>}
                    </span>
                    <span className="text-primary text-[11px]">Day {e.day}/14</span>
                    <span className="text-muted-foreground text-[11px]">{e.scenario}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Auth dialog also available from landing */}
        <Dialog open={showIdentity} onOpenChange={setShowIdentity}>
          <DialogContent className="bg-card border-primary/30 font-mono max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-primary tracking-widest text-sm">
                {authMode === "register" ? "CREATE ACCOUNT" : "SIGN IN"}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
                {authMode === "register"
                  ? "Your progress is saved to your account automatically."
                  : "Sign in to restore your saved run."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 pt-1">
              <div className="flex border border-border/40">
                {(["register", "login"] as const).map((mode) => (
                  <button key={mode} onClick={() => { setAuthMode(mode); setAuthError(""); }}
                    className={`flex-1 text-[10px] tracking-widest py-1.5 transition-colors ${authMode === mode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                    {mode === "register" ? "NEW PLAYER" : "RETURNING PLAYER"}
                  </button>
                ))}
              </div>
              <div>
                <label htmlFor="landing-auth-username" className="block text-[10px] tracking-widest text-muted-foreground mb-1">USERNAME</label>
                <input id="landing-auth-username" type="text" placeholder="e.g. dr_gradient" value={authUsername} autoFocus maxLength={24}
                  onChange={(e) => { setAuthUsername(e.target.value); setAuthError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                  autoComplete="username"
                  className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 tracking-wider" />
              </div>
              <div>
                <label htmlFor="landing-auth-password" className="block text-[10px] tracking-widest text-muted-foreground mb-1">PASSWORD</label>
                <input id="landing-auth-password" type="password" placeholder="Min. 4 characters" value={authPassword} maxLength={72}
                  onChange={(e) => { setAuthPassword(e.target.value); setAuthError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                  autoComplete={authMode === "register" ? "new-password" : "current-password"}
                  className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50" />
              </div>
              {authMode === "register" && (
                <div>
                  <label htmlFor="landing-auth-confirm" className="block text-[10px] tracking-widest text-muted-foreground mb-1">CONFIRM PASSWORD</label>
                  <input id="landing-auth-confirm" type="password" placeholder="Repeat password" value={authConfirm} maxLength={72}
                    onChange={(e) => { setAuthConfirm(e.target.value); setAuthError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRegister(); }}
                    autoComplete="new-password"
                    className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50" />
                </div>
              )}
              {authError && <p role="alert" className="text-[10px] text-destructive border-l-2 border-destructive/40 pl-2">{authError}</p>}
              <div className="flex gap-2 pt-1">
                <Button className="flex-1 font-bold tracking-widest" disabled={authPending}
                  onClick={authMode === "register" ? handleRegister : handleLogin}>
                  {authPending ? "CONNECTING…" : authMode === "register" ? "CREATE ACCOUNT" : "SIGN IN"}
                </Button>
                <Button variant="outline" className="border-border/40 text-muted-foreground text-xs"
                  onClick={() => setShowIdentity(false)}>
                  {playerName ? "CANCEL" : "SKIP"}
                </Button>
              </div>
              {!playerName && (
                <p className="text-[9px] text-muted-foreground/50 text-center">
                  You can play as a guest — scores won't appear on the leaderboard.
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      {/* Skip to main content */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* Header */}
      <header className="border-b border-border bg-card/50 px-4 md:px-8 py-3 md:py-4 sticky top-0 z-10 backdrop-blur-sm">
        <div className="max-w-screen-xl mx-auto">

          {/* ── MOBILE LAYOUT (hidden on md+) ── */}
          <div className="md:hidden space-y-2">
            {/* Row 1: Title + Day counter + Sign In + theme */}
            <div className="flex items-center justify-between gap-2">
              <div>
                <h1 className="text-lg font-bold text-primary tracking-tighter leading-none">
                  THE MODEL FORGE<span className="animate-pulse ml-0.5" aria-hidden="true">_</span>
                </h1>
                <p className="text-[9px] text-muted-foreground tracking-widest">ML PRODUCTION SIMULATOR</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div data-testid="day-counter" className="text-sm font-bold border border-primary/40 px-2 py-0.5 text-primary">
                  DAY {gameState.day}/14
                </div>
                {gameState.wins > 0 && (
                  <Badge className="bg-primary/20 text-primary border-primary/40 text-[10px] px-1.5">
                    {gameState.wins}W
                  </Badge>
                )}
                {(gameState.streak ?? 0) >= 2 && (
                  <Badge className="bg-orange-500/15 text-orange-400 border border-orange-500/35 font-mono text-[10px] px-1.5">
                    🔥{gameState.streak}
                  </Badge>
                )}
                {playerName ? (
                  <button
                    onClick={() => { setAuthMode("login"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
                    className="text-[10px] text-primary/70 border border-primary/25 px-1.5 py-0.5 tracking-widest hover:border-primary/50 hover:text-primary transition-colors"
                    title="Switch account"
                  >
                    {playerName.toUpperCase()}
                  </button>
                ) : (
                  <button
                    onClick={() => { setAuthMode("login"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
                    className="text-[10px] font-semibold text-primary border border-primary/50 px-1.5 py-0.5 tracking-widest hover:bg-primary/10 transition-colors"
                    title="Sign in to save your scores to the leaderboard"
                  >
                    SIGN IN
                  </button>
                )}
                <button
                  onClick={toggleTheme}
                  aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  className="text-[11px] text-muted-foreground/70 border border-border/40 px-1.5 py-0.5 hover:border-primary/40 hover:text-primary transition-colors"
                >
                  {theme === "dark" ? "☀" : "◗"}
                </button>
              </div>
            </div>

            {/* Row 2: Scenario + Role selects with labels */}
            <div className="flex gap-2">
              <div className="flex-1 flex flex-col gap-0.5">
                <span className="text-[9px] text-muted-foreground/60 tracking-widest px-0.5">SCENARIO — choose an ML incident</span>
                <Select value={gameState.scenario} onValueChange={handleScenarioChange}>
                  <SelectTrigger className="w-full text-xs h-8" data-testid="select-scenario">
                    <SelectValue placeholder="Scenario" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="zillow">Zillow (Overfitting)</SelectItem>
                    <SelectItem value="amazon">Amazon (Bias)</SelectItem>
                    <SelectItem value="uber">Uber (Latency)</SelectItem>
                    <SelectItem value="netflix">Netflix (Drift)</SelectItem>
                    <SelectItem value="google">Google (Drift)</SelectItem>
                    <SelectItem value="stripe">Stripe (Poisoning)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-0.5">
                <span className="text-[9px] text-muted-foreground/60 tracking-widest px-0.5">ROLE — sets difficulty</span>
                <Select value={gameState.userLevel} onValueChange={handleLevelChange}>
                  <SelectTrigger className="w-full text-xs h-8" data-testid="select-level">
                    <SelectValue placeholder="Level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="intern">Intern</SelectItem>
                    <SelectItem value="engineer">ML Engineer</SelectItem>
                    <SelectItem value="mlops">MLOps Lead</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 3: Action buttons */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-[10px] h-6 px-2" onClick={() => setShowCodex(true)} data-testid="button-codex" title="Browse the ML incident knowledge base">CODEX</Button>
              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-[10px] h-6 px-2" onClick={() => { setShowSave(true); setRestoreInput(""); setRestoreError(""); setCodeCopied(false); }} data-testid="button-save" title="Save or restore your game progress">SAVE</Button>
              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-[10px] h-6 px-2" onClick={() => setShowLeaderboard(true)} data-testid="button-leaderboard" title="View the global leaderboard">SCORES</Button>
              <Button variant="outline" size="sm" className="text-destructive border-destructive/40 hover:bg-destructive/10 text-[10px] h-6 px-2" onClick={() => setShowReset(true)} data-testid="button-reset" title="Abandon the current run and start over">RESET</Button>
            </div>
          </div>

          {/* ── DESKTOP LAYOUT (hidden below md) ── */}
          <div className="hidden md:flex items-center justify-between gap-3">
            {/* Branding — no sign-in here */}
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tighter leading-none">
                THE MODEL FORGE<span className="animate-pulse ml-0.5" aria-hidden="true">_</span>
              </h1>
              <p className="text-xs text-muted-foreground tracking-widest mt-0.5">ML PRODUCTION SIMULATOR</p>
            </div>

            {/* Controls — right side */}
            <div className="flex flex-wrap items-center gap-2 md:gap-3">
              <div data-testid="day-counter" className="text-xl font-bold border border-primary/40 px-3 py-1 text-primary">
                DAY {gameState.day}/14
              </div>
              {gameState.wins > 0 && (
                <Badge className="bg-primary/20 text-primary border-primary/40">
                  {gameState.wins} WIN{gameState.wins > 1 ? "S" : ""}
                </Badge>
              )}
              {(gameState.streak ?? 0) >= 2 && (
                <Badge
                  title={`${gameState.streak} consecutive clean days — all metrics in healthy range`}
                  className="bg-orange-500/15 text-orange-400 border border-orange-500/35 font-mono text-xs gap-1"
                >
                  🔥 {gameState.streak}d streak
                </Badge>
              )}

              {/* Scenario select with label */}
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] text-muted-foreground/60 tracking-widest px-0.5">SCENARIO</span>
                <Select value={gameState.scenario} onValueChange={handleScenarioChange}>
                  <SelectTrigger className="w-[160px] text-xs" data-testid="select-scenario">
                    <SelectValue placeholder="Scenario" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="zillow">Zillow (Overfitting)</SelectItem>
                    <SelectItem value="amazon">Amazon (Bias)</SelectItem>
                    <SelectItem value="uber">Uber (Latency)</SelectItem>
                    <SelectItem value="netflix">Netflix (Drift)</SelectItem>
                    <SelectItem value="google">Google (Drift)</SelectItem>
                    <SelectItem value="stripe">Stripe (Poisoning)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Role select with label */}
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] text-muted-foreground/60 tracking-widest px-0.5">ROLE / DIFFICULTY</span>
                <Select value={gameState.userLevel} onValueChange={handleLevelChange}>
                  <SelectTrigger className="w-[130px] text-xs" data-testid="select-level">
                    <SelectValue placeholder="Level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="intern">Intern</SelectItem>
                    <SelectItem value="engineer">ML Engineer</SelectItem>
                    <SelectItem value="mlops">MLOps Lead</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs" onClick={() => { setShowSave(true); setRestoreInput(""); setRestoreError(""); setCodeCopied(false); }} data-testid="button-save" title="Save or restore your game progress">SAVE</Button>
              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs" onClick={() => setShowCodex(true)} data-testid="button-codex" title="Browse the ML incident knowledge base">CODEX</Button>
              <Button variant="outline" size="sm" className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs" onClick={() => setShowLeaderboard(true)} data-testid="button-leaderboard" title="View the global leaderboard">SCORES</Button>
              <Button variant="outline" size="sm" className="text-destructive border-destructive/40 hover:bg-destructive/10 text-xs" onClick={() => setShowReset(true)} data-testid="button-reset" title="Abandon the current run and start over">RESET</Button>
              <button onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="text-[11px] text-muted-foreground/70 border border-border/40 px-2 py-1 tracking-widest hover:border-primary/40 hover:text-primary transition-colors">
                {theme === "dark" ? "☀" : "◗"}
              </button>

              {/* Sign In — top-right, visually separated */}
              <div className="border-l border-border/50 pl-3 ml-0.5">
                {playerName ? (
                  <button
                    onClick={() => { setAuthMode("login"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
                    className="text-[10px] text-primary/70 border border-primary/25 px-2 py-1 tracking-widest hover:border-primary/50 hover:text-primary transition-colors"
                    title="Switch account"
                  >
                    {playerName.toUpperCase()}
                  </button>
                ) : (
                  <button
                    onClick={() => { setAuthMode("login"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
                    className="text-xs font-semibold text-primary border border-primary/50 px-3 py-1 tracking-widest hover:bg-primary/10 transition-colors"
                    title="Sign in to save your scores to the leaderboard"
                  >
                    SIGN IN
                  </button>
                )}
              </div>
            </div>
          </div>

        </div>
      </header>

      {/* History scrubber bar */}
      {gameState.userLevel === "mlops" && gameState.history.length > 0 && (
        <div className="bg-card/30 border-b border-border px-4 md:px-8 py-2">
          <div className="max-w-screen-xl mx-auto flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">TIME TRAVEL:</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={historyView === null || historyView <= 0}
              onClick={() => setHistoryView((v) => (v === null ? gameState.history.length - 2 : Math.max(0, v - 1)))}
              data-testid="button-prev-day"
            >
              PREV
            </Button>
            <span className="text-primary">
              {isHistoryMode ? `VIEWING DAY ${(viewState as GameState).day}` : "LIVE"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={historyView === null}
              onClick={() =>
                setHistoryView((v) => {
                  if (v === null) return null;
                  const next = v + 1;
                  return next >= gameState.history.length ? null : next;
                })
              }
              data-testid="button-next-day"
            >
              NEXT
            </Button>
            {isHistoryMode && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-primary"
                onClick={() => setHistoryView(null)}
              >
                RETURN TO LIVE
              </Button>
            )}
          </div>
        </div>
      )}

      <main id="main-content" className="max-w-screen-xl mx-auto p-4 md:p-8 grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* ---- COL 1: Metrics ---- */}
        <div className="space-y-5">
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs tracking-widest text-muted-foreground">SYSTEM METRICS</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <MetricBar label={metricLabels.precision} value={viewState.metrics.precision} />
              <MetricBar label={metricLabels.recall} value={viewState.metrics.recall} />
              <MetricBar label="SLA Adherence" value={viewState.metrics.slaAdherence} />
              <MetricBar
                label="Feature Freshness"
                value={Math.max(0, 100 - viewState.metrics.featureStaleness * 2)}
                subtitle={`${viewState.metrics.featureStaleness.toFixed(0)}h stale`}
              />
              <MetricBar
                label="Inference Cost"
                value={100 - viewState.metrics.inferenceCost}
                subtitle={`Cost index: ${viewState.metrics.inferenceCost.toFixed(0)}`}
              />
              <div className="flex items-center justify-between pt-1 border-t border-border/40">
                <span className="text-xs text-muted-foreground uppercase tracking-widest">Skew Alert</span>
                <span
                  className="text-xs font-bold border px-2 py-0.5"
                  style={{
                    color: `var(--metric-${skewHealth(viewState.metrics.skew)})`,
                    borderColor: `var(--metric-${skewHealth(viewState.metrics.skew)})`,
                    backgroundColor: `color-mix(in srgb, var(--metric-${skewHealth(viewState.metrics.skew)}) 15%, transparent)`,
                  }}
                >
                  {viewState.metrics.skew.toUpperCase()}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Monitoring Chart */}
          {chartData.length > 1 && (
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs tracking-widest text-muted-foreground">7-DAY TREND</CardTitle>
              </CardHeader>
              <CardContent className="p-0 pb-3">
                <ResponsiveContainer width="100%" height={110}>
                  <LineChart data={chartData} margin={{ top: 5, right: 16, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="var(--chart-grid, rgba(0,0,0,0.07))" />
                    <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                    <RechartsTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 10,
                        fontFamily: "inherit",
                      }}
                    />
                    <Line type="monotone" dataKey="Precision" name={metricLabels.precision} stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="Recall" name={metricLabels.recall} stroke="#60a5fa" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="SLA" stroke="#f59e0b" strokeWidth={1} dot={false} strokeDasharray="3 3" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ---- COL 2: Event + Registry ---- */}
        <div className="space-y-5">
          {/* Daily Brief */}
          {dailyBrief && !briefDismissed && !isHistoryMode && (
            <DailyBrief brief={dailyBrief} onDismiss={() => setBriefDismissed(true)} />
          )}

          {/* Event card */}
          <Card
            className={`border-2 ${
              gameState.status !== "playing"
                ? "border-destructive/50"
                : currentEvent
                ? `${getEventColor(currentEvent.eventType)} shadow-[0_0_20px_rgba(57,255,20,0.08)]`
                : "border-border/60"
            }`}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-xs tracking-widest text-muted-foreground">
                {gameState.status !== "playing"
                  ? "SYSTEM STATUS"
                  : currentEvent
                  ? "INCIDENT REPORT"
                  : "OPERATIONS"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {gameState.status === "playing" ? (
                currentEvent ? (
                  <>
                    <div className="border border-primary/30 bg-primary/5 p-3">
                      <div className="text-primary text-xs font-bold tracking-widest mb-2">
                        {currentEvent.title}
                      </div>
                      <p className="text-sm leading-relaxed">{currentEvent.description}</p>
                    </div>
                    <div className="space-y-2">
                      {currentEvent.choices.map((choice) => (
                        <button
                          key={choice.id}
                          data-testid={`button-choice-${choice.id}`}
                          onClick={() => handleChoice(choice.id)}
                          className="w-full text-left border border-border hover:border-primary/60 hover:bg-primary/5 transition-all p-3 text-sm group"
                        >
                          <span className="text-primary font-bold mr-2 group-hover:text-primary">[{choice.id}]</span>
                          {choice.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="border border-border/40 bg-secondary/20 p-3 text-sm text-muted-foreground">
                      <span className="text-primary">&gt;</span> All systems nominal. No incidents detected.
                    </div>
                    <Button
                      className="w-full h-12 text-sm tracking-widest font-bold"
                      onClick={handleNextDay}
                      data-testid="button-next-day-action"
                      disabled={isHistoryMode}
                    >
                      ADVANCE TO DAY {gameState.day + 1}
                    </Button>
                  </>
                )
              ) : (
                <div className="space-y-3">
                  <div className={`border p-4 ${gameState.status === "won" ? "border-primary/50 bg-primary/5 text-primary" : "border-destructive/50 bg-destructive/5 text-destructive"}`}>
                    <div className="font-bold text-lg tracking-widest mb-1">
                      {gameState.status === "won" ? "✓ PRODUCTION READY" : "✗ SYSTEM FAILURE"}
                    </div>
                    <p className="text-sm opacity-80">
                      {gameState.status === "won"
                        ? `All 14 days survived. P:${gameState.metrics.precision.toFixed(0)}% R:${gameState.metrics.recall.toFixed(0)}%`
                        : "A critical metric reached 0 or exceeded safety thresholds."}
                    </p>
                  </div>
                  <Button className="w-full text-xs tracking-widest" variant="outline"
                    onClick={() => setShowGameOver(true)}>
                    VIEW FULL RESULTS →
                  </Button>
                  <Button className="w-full" variant={gameState.status === "won" ? "default" : "destructive"}
                    onClick={handleReset} data-testid="button-play-again">
                    {gameState.status === "won" ? "PLAY AGAIN" : "TRY AGAIN"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Model Registry (Engineer + MLOps) */}
          {gameState.userLevel !== "intern" && (
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs tracking-widest text-muted-foreground">MODEL REGISTRY</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {viewState.registry.models.map((m) => (
                    <div
                      key={m.id}
                      data-testid={`model-card-${m.id}`}
                      className="border border-border/40 p-2.5 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">{m.id}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.type} v{m.version} &middot; Day {m.trainedOnDay}
                        </div>
                        {m.accuracy && (
                          <div className="text-xs text-muted-foreground">
                            acc:{m.accuracy}% cost:${m.cost} lat:{m.latency}ms
                          </div>
                        )}
                      </div>
                      <span
                        className={`text-xs font-bold border px-1.5 py-0.5 shrink-0 ${
                          m.stage === "production"
                            ? "border-primary/40 text-primary bg-primary/10"
                            : m.stage === "staging"
                            ? "border-yellow-400/40 text-yellow-400 bg-yellow-400/10"
                            : "border-border/40 text-muted-foreground"
                        }`}
                      >
                        {m.stage.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ---- COL 3: Infrastructure + Log ---- */}
        <div className="space-y-5">
          {/* Infrastructure (MLOps) */}
          {gameState.userLevel === "mlops" && (
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs tracking-widest text-muted-foreground">INFRASTRUCTURE</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-bold">FEATURE STORE</div>
                    <div className="text-xs text-muted-foreground">
                      {gameState.featureStore.stalenessHours}h staleness &middot;{" "}
                      {gameState.featureStore.featureVersions.join(", ")}
                    </div>
                  </div>
                  <Button
                    variant={gameState.featureStore.enabled ? "default" : "outline"}
                    size="sm"
                    className="text-xs h-7"
                    data-testid="button-toggle-feature-store"
                    onClick={() =>
                      persistState({
                        ...gameState,
                        featureStore: { ...gameState.featureStore, enabled: !gameState.featureStore.enabled },
                      })
                    }
                  >
                    {gameState.featureStore.enabled ? "ON" : "OFF"}
                  </Button>
                </div>
                <div className="flex items-center justify-between border-t border-border/30 pt-3">
                  <div>
                    <div className="text-xs font-bold">AUTO-RETRAIN (CI/CD)</div>
                    <div className="text-xs text-muted-foreground">
                      Pass rate: {(gameState.ciCd.testPassRate * 100).toFixed(0)}%
                    </div>
                  </div>
                  <Button
                    variant={gameState.ciCd.autoRetrain ? "default" : "outline"}
                    size="sm"
                    className="text-xs h-7"
                    data-testid="button-toggle-cicd"
                    onClick={() =>
                      persistState({
                        ...gameState,
                        ciCd: { ...gameState.ciCd, autoRetrain: !gameState.ciCd.autoRetrain },
                      })
                    }
                  >
                    {gameState.ciCd.autoRetrain ? "ACTIVE" : "INACTIVE"}
                  </Button>
                </div>
                {viewState.registry.models.some((m) => m.stage === "staging") && (
                  <div className="border-t border-border/30 pt-3">
                    <div className="text-xs font-bold mb-1 text-yellow-400">CANARY ACTIVE</div>
                    <div className="text-xs text-muted-foreground">
                      Staging model deployed to 10% of traffic. Promote via event choices.
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Feature Store (Engineer) */}
          {gameState.userLevel === "engineer" && (
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs tracking-widest text-muted-foreground">FEATURE STORE</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <span className={viewState.featureStore.enabled ? "text-primary" : "text-destructive"}>
                      {viewState.featureStore.enabled ? "ENABLED" : "DISABLED"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Staleness</span>
                    <span>{viewState.metrics.featureStaleness.toFixed(0)}h</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Versions</span>
                    <span>{viewState.featureStore.featureVersions.join(", ")}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Post-mortem (loss only) */}
          {gameState.status === "lost" && postMortem.length > 0 && (
            <Card className="border-destructive/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs tracking-widest text-destructive">POST-MORTEM REPORT</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {postMortem.map((item, i) => (
                    <li key={i} className="text-xs border-l-2 border-destructive pl-2 leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Event Log */}
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs tracking-widest text-muted-foreground">EVENT LOG</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div ref={logRef} className="h-40 sm:h-52 overflow-y-auto px-4 pb-4 space-y-2 text-xs">
                {gameState.eventLog.length === 0 ? (
                  <div className="text-muted-foreground italic pt-2">No events logged yet.</div>
                ) : (
                  [...gameState.eventLog].reverse().map((log, i) => (
                    <div key={i} className="border-l-2 border-primary/40 pl-2 py-0.5">
                      <span className="text-primary font-bold">D{log.day}</span>
                      <span className="text-muted-foreground mx-1">&bull;</span>
                      <span>{log.message}</span>
                      {log.choice && (
                        <div className="text-primary/60 mt-0.5">&gt; {log.choice}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Leaderboard teaser */}
          {leaderboardData?.entries && leaderboardData.entries.length > 0 && (
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-center">
                  <CardTitle className="text-xs tracking-widest text-muted-foreground">TOP SURVIVORS</CardTitle>
                  <button
                    onClick={() => setShowLeaderboard(true)}
                    className="text-[10px] text-primary/60 hover:text-primary transition-colors tracking-widest"
                  >
                    VIEW ALL →
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-xs">
                  {leaderboardData.entries.slice(0, 3).map((e, i) => (
                    <div key={e.sessionId} className="flex justify-between items-center gap-2">
                      <span className="text-muted-foreground shrink-0">#{i + 1}</span>
                      <span className="text-foreground/80 truncate flex-1">
                        {e.username ?? <span className="italic text-muted-foreground/60">anon</span>}
                      </span>
                      <span className="text-primary shrink-0">D{e.day} · P{e.precision.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      {/* Post-Game Results Modal */}
      <Dialog open={showGameOver} onOpenChange={setShowGameOver}>
        <DialogContent className="bg-card border-primary/30 font-mono w-[95vw] sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className={`tracking-widest text-lg flex items-center gap-3 ${gameState.status === "won" ? "text-primary" : "text-destructive"}`}>
              <span>{gameState.status === "won" ? "✓ PRODUCTION SURVIVED" : "✗ SYSTEM FAILURE"}</span>
              {runScore && (
                <span className={`font-black text-3xl leading-none ${gradeColor(runScore.grade)}`}>{runScore.grade}</span>
              )}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-muted-foreground text-xs mt-1 space-x-3">
                <span>Day {gameState.day - 1}/14</span>
                <span>·</span>
                <span className="capitalize">{gameState.scenario}</span>
                {runScore && <><span>·</span><span className="font-mono font-bold">{runScore.score} pts</span></>}
                {playerName && <><span>·</span><span className="text-primary/70">{playerName}</span></>}
              </div>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-2">
            {/* Final metric row */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: metricLabels.precision.toUpperCase(), value: gameState.metrics.precision, good: gameState.metrics.precision >= 70 },
                { label: metricLabels.recall.toUpperCase(), value: gameState.metrics.recall, good: gameState.metrics.recall >= 70 },
                { label: "SLA", value: gameState.metrics.slaAdherence, good: gameState.metrics.slaAdherence >= 90 },
              ].map((m) => (
                <div key={m.label} className={`border p-3 text-center ${m.good ? "border-primary/30 bg-primary/5" : "border-destructive/30 bg-destructive/5"}`}>
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-1">{m.label}</div>
                  <div className={`text-2xl font-bold ${m.good ? "text-primary" : "text-destructive"}`}>
                    {m.value.toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>

            {/* Streak stat */}
            {(gameState.maxStreak ?? 0) > 0 && (
              <div className="flex items-center gap-3 border border-orange-500/20 bg-orange-500/5 px-4 py-2.5">
                <span className="text-lg">🔥</span>
                <div className="flex-1">
                  <div className="text-[10px] tracking-widest text-muted-foreground">BEST CLEAN STREAK</div>
                  <div className="text-sm font-bold text-orange-400">
                    {gameState.maxStreak} consecutive day{gameState.maxStreak !== 1 ? "s" : ""} with all metrics in the green
                  </div>
                </div>
                <div className="text-2xl font-bold text-orange-400">{gameState.maxStreak}</div>
              </div>
            )}

            {/* Score breakdown */}
            {runScore && (() => {
              const difficulty = DIFFICULTY_BY_SCENARIO[gameState.scenario] ?? 1;
              // Must match DIFFICULTY_BONUS in computeRunScore: { 1: 10, 2: 15, 3: 25 }.
              // Previously had { 1: 0, 2: 15, 3: 25 } — Default runs showed a 10-point gap between
              // the displayed breakdown total and the actual score shown at the top of the dialog.
              const diffBonus = ({ 1: 10, 2: 15, 3: 25 } as Record<number, number>)[difficulty] ?? 0;
              const diffLabel = ({ 1: "BEGINNER ★☆☆", 2: "MODERATE ★★☆", 3: "HARD ★★★" } as Record<number, string>)[difficulty] ?? "";
              const daysCompleted = Math.max(0, gameState.day - 1);
              const m = gameState.metrics;
              const avgMetric = (m.precision + m.recall + m.slaAdherence) / 3;
              const breakdown = [
                { label: "Metric Quality (avg prec/recall/SLA)", pts: (avgMetric / 100) * 40, of: 40 },
                { label: `Max Streak (${gameState.maxStreak ?? 0} clean days)`, pts: Math.min((gameState.maxStreak ?? 0) / 14, 1) * 20, of: 20 },
                { label: `Days Survived (${daysCompleted}/14)`, pts: Math.min(daysCompleted / 14, 1) * 20, of: 20 },
                { label: "Win Bonus", pts: gameState.status === "won" ? 10 : 0, of: 10 },
                { label: `Difficulty Bonus (${diffLabel})`, pts: diffBonus, of: 25 },
              ];
              return (
                <div className="border border-border/40 bg-secondary/10 p-3">
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-2.5">SCORE BREAKDOWN</div>
                  <div className="space-y-2">
                    {breakdown.map(({ label, pts, of }) => (
                      <div key={label} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 text-muted-foreground truncate">{label}</span>
                        <div className="w-12 sm:w-20 h-1 bg-border/40 rounded-full overflow-hidden shrink-0">
                          <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.round((pts / of) * 100)}%` }} />
                        </div>
                        <span className="font-mono text-foreground/80 w-10 text-right shrink-0">+{Math.round(pts)}/{of}</span>
                      </div>
                    ))}
                    <div className="flex justify-between items-center pt-2 border-t border-border/30 text-xs font-bold">
                      <span className="text-muted-foreground tracking-widest">TOTAL</span>
                      <span className={gradeColor(runScore.grade)}>{runScore.score} pts — Grade {runScore.grade}</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Full run chart */}
            {fullRunChartData.length > 1 && (
              <div>
                <div className="text-[10px] tracking-widest text-muted-foreground mb-2">METRIC HISTORY — FULL RUN</div>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={fullRunChartData} margin={{ top: 4, right: 16, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="var(--chart-grid, rgba(0,0,0,0.07))" />
                    <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                    <RechartsTooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 10, fontFamily: "inherit" }}
                    />
                    <Line type="monotone" dataKey="Precision" name={metricLabels.precision} stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Recall" name={metricLabels.recall} stroke="#60a5fa" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="SLA" stroke="#f59e0b" strokeWidth={1} dot={false} strokeDasharray="3 3" />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex gap-4 justify-center mt-1">
                  {[[metricLabels.precision, "hsl(var(--primary))"], [metricLabels.recall, "#60a5fa"], ["SLA", "#f59e0b"]].map(([k, c]) => (
                    <span key={k} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="inline-block w-4 h-0.5" style={{ background: c }} />
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Key decisions */}
            {gameState.eventLog.filter((e) => e.choice).length > 0 && (
              <div>
                <div className="text-[10px] tracking-widest text-muted-foreground mb-2">KEY DECISIONS</div>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {gameState.eventLog.filter((e) => e.choice).map((e, i) => (
                    <div key={i} className="flex gap-2 text-xs border-l-2 border-primary/30 pl-2">
                      <span className="text-primary font-bold shrink-0">D{e.day}</span>
                      <span className="text-muted-foreground/70 truncate">{e.message.slice(0, 60)}{e.message.length > 60 ? "…" : ""}</span>
                      <span className="text-primary/60 shrink-0 ml-auto">→ {e.choice!.slice(0, 30)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Post-mortem (loss only) */}
            {gameState.status === "lost" && postMortem.length > 0 && (
              <div>
                <div className="text-[10px] tracking-widest text-destructive mb-2">POST-MORTEM</div>
                <ul className="space-y-1.5">
                  {postMortem.map((item, i) => (
                    <li key={i} className="text-xs border-l-2 border-destructive/50 pl-2 text-foreground/80 leading-relaxed">{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Lessons Learned */}
            {(() => {
              const entry = CODEX_SCENARIO_DIFFICULTY.find((s) => s.id === gameState.scenario);
              if (!entry) return null;
              const sig = entry.signatureEvent;
              // Find a choice-entry on the signature event's day (signature events are the only
              // player-choice events scheduled for that specific day in each scenario).
              const sigLog = gameState.eventLog.find((e) => e.day === sig.day && e.choice);
              const dayReached = (gameState.day - 1) >= sig.day;
              const tierColor =
                entry.difficulty === 1 ? "text-primary border-primary/40"
                : entry.difficulty === 2 ? "text-yellow-400 border-yellow-400/40"
                : "text-destructive border-destructive/40";
              const tierLabel =
                entry.difficulty === 1 ? "BEGINNER ★☆☆"
                : entry.difficulty === 2 ? "MODERATE ★★☆"
                : "HARD ★★★";
              return (
                <div className="border border-border/40 bg-secondary/5 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] tracking-widest text-muted-foreground">LESSONS LEARNED</div>
                    <span className={`text-[9px] border px-1.5 py-0.5 ${tierColor}`}>{tierLabel}</span>
                  </div>

                  {/* Scoring trap */}
                  <div className="border-l-2 border-destructive/40 pl-2.5">
                    <div className="text-[9px] tracking-widest text-destructive mb-1">SCORING TRAP</div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{entry.scoringTrap}</p>
                  </div>

                  {/* Signature event */}
                  <div className="bg-secondary/20 border border-border/30 px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[9px] tracking-widest text-muted-foreground">SIGNATURE EVENT</span>
                      <span className="text-[9px] border border-border/40 px-1.5 py-0.5 text-muted-foreground">DAY {sig.day}</span>
                      {!dayReached
                        ? <span className="text-[9px] border border-border/30 px-1.5 py-0.5 text-muted-foreground/60">NOT REACHED</span>
                        : sigLog
                          ? <span className="text-[9px] border border-primary/40 px-1.5 py-0.5 text-primary">ENCOUNTERED</span>
                          : <span className="text-[9px] border border-border/30 px-1.5 py-0.5 text-muted-foreground/60">SKIPPED</span>
                      }
                    </div>
                    <div className="text-[10px] font-bold text-primary tracking-wide">{sig.name}</div>
                    {sigLog && (
                      <div className="text-[10px] text-yellow-400/90">
                        Your choice: <span className="font-bold">{sigLog.choice}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground leading-relaxed">{sig.insight}</p>
                  </div>

                  <button
                    className="text-[10px] tracking-widest text-primary/70 hover:text-primary transition-colors underline underline-offset-2"
                    onClick={() => {
                      setShowGameOver(false);
                      setCodexSection("scenarios");
                      setCodexFocusScenario(gameState.scenario);
                      setShowCodex(true);
                    }}
                  >
                    OPEN FULL SCENARIO ENTRY IN CODEX →
                  </button>
                </div>
              );
            })()}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-1 border-t border-border/30">
              <Button
                className="flex-1 font-bold tracking-widest"
                variant={gameState.status === "won" ? "default" : "destructive"}
                onClick={() => { setShowGameOver(false); handleReset(); }}
              >
                {gameState.status === "won" ? "PLAY AGAIN" : "TRY AGAIN"}
              </Button>
              <Button variant="outline" className="text-xs tracking-widest border-border/50"
                onClick={() => { setShowGameOver(false); setShowLeaderboard(true); }}>
                VIEW LEADERBOARD
              </Button>
              <Button variant="outline" className="text-xs tracking-widest border-border/50"
                onClick={copyGameOverSummary}>
                {gameOverCopied ? "COPIED!" : "COPY RESULT"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Leaderboard Modal */}
      <Dialog open={showLeaderboard} onOpenChange={setShowLeaderboard}>
        <DialogContent className="bg-card border-primary/30 font-mono w-[95vw] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">GLOBAL LEADERBOARD</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Top 10 completed runs ranked by performance score — difficulty, metrics, streak, and win bonus combined.
              Sign in to claim your name on the board.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2">
            {!leaderboardData?.entries || leaderboardData.entries.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-xs tracking-widest">
                NO COMPLETED RUNS YET. BE THE FIRST TO SURVIVE ALL 14 DAYS.
              </div>
            ) : (
              <div className="overflow-x-auto -mx-1 px-1">
                <div className="space-y-0 min-w-[480px]">
                {/* Header row */}
                <div className="grid grid-cols-[2rem_1fr_5rem_3rem_4rem_3.5rem_3.5rem] gap-2 text-[10px] tracking-widest text-muted-foreground border-b border-border/40 pb-2 mb-1">
                  <span>#</span>
                  <span>PLAYER</span>
                  <span>SCENARIO</span>
                  <span className="text-center">GRD</span>
                  <span className="text-right">SCORE</span>
                  <span className="text-right">PREC</span>
                  <span className="text-right">RECALL</span>
                </div>

                {leaderboardData.entries.map((e, i) => {
                  const isYou = playerName && e.username === playerName;
                  const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                  const completedDate = new Date(e.completedAt).toLocaleDateString(undefined, {
                    month: "short", day: "numeric"
                  });
                  return (
                    <div
                      key={e.sessionId}
                      className={`grid grid-cols-[2rem_1fr_5rem_3rem_4rem_3.5rem_3.5rem] gap-2 items-center py-2 text-xs border-b border-border/20 last:border-0 transition-colors ${
                        isYou ? "bg-primary/5 text-primary" : "text-foreground/80 hover:bg-secondary/20"
                      }`}
                    >
                      <span className="text-muted-foreground text-[11px]">
                        {medal ?? `#${i + 1}`}
                      </span>
                      <div className="min-w-0">
                        <div className={`truncate font-semibold ${isYou ? "text-primary" : "text-foreground"}`}>
                          {e.username
                            ? <>
                                {e.username}
                                {isYou && <span className="ml-1.5 text-[10px] text-primary/60">(you)</span>}
                              </>
                            : <span className="italic text-muted-foreground/50 text-[11px]">anonymous</span>
                          }
                        </div>
                        <div className="text-[10px] text-muted-foreground/50">{completedDate}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground capitalize truncate">{e.scenario}</span>
                      <span className={`text-center font-black text-sm ${gradeColor(e.grade)}`}>{e.grade}</span>
                      <span className="text-right font-mono font-bold">{e.score}</span>
                      <span className="text-right">{e.precision.toFixed(1)}%</span>
                      <span className="text-right">{e.recall.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
              </div>
            )}

            {!playerName && (
              <div className="mt-4 border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                <span className="text-primary font-semibold">Want your name on the board?</span>{" "}
                Create an account — your wins are tracked per player.{" "}
                <button
                  onClick={() => { setShowLeaderboard(false); setAuthMode("register"); setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError(""); setShowIdentity(true); }}
                  className="text-primary hover:underline ml-1"
                >
                  Sign up →
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Tutorial Modal */}
      <Dialog open={showTutorial} onOpenChange={setShowTutorial}>
        <DialogContent className="bg-card border-primary/50 text-foreground font-mono max-w-md rounded-none">
          <DialogHeader>
            <DialogTitle className="text-primary text-xl tracking-widest">SYSTEM INITIALIZED</DialogTitle>
            <DialogDescription asChild>
              <div className="text-foreground text-sm space-y-3 pt-3">
                <p>
                  You are an ML Engineer. Your XGBoost model is live in production.
                </p>
                <p>
                  Each day, an incident may occur. Choose how to respond. Your decisions affect 6 production metrics.
                </p>
                <p>
                  <span className="text-destructive font-bold">LOSE:</span> Any metric hits 0, or feature staleness exceeds 48 hours.
                </p>
                <p>
                  <span className="text-primary font-bold">WIN:</span> Survive all 14 days.
                </p>
                <p className="text-muted-foreground text-xs pt-1">
                  Tip: Switch to ML Engineer or MLOps Lead mode to unlock registry and infrastructure controls.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowTutorial(false);
                setShowScenarioPicker(true);
              }}
              className="w-full font-bold tracking-widest"
              data-testid="button-start-game"
            >
              CHOOSE YOUR SCENARIO →
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scenario Picker Modal */}
      <Dialog open={showScenarioPicker} onOpenChange={setShowScenarioPicker}>
        <DialogContent className="bg-card border-primary/30 font-mono w-[95vw] sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">SELECT YOUR SCENARIO</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              Each scenario is based on a real ML disaster. Pick one to inherit its conditions, or start clean on Default.
              Harder scenarios begin with a metric handicap — but they also teach more.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {([
              { id: "default",   difficulty: 1, tag: "BEGINNER",  color: "text-primary border-primary/30",          comingSoon: false },
              { id: "zillow",    difficulty: 2, tag: "MODERATE",  color: "text-yellow-400 border-yellow-400/30",    comingSoon: false },
              { id: "netflix",   difficulty: 2, tag: "MODERATE",  color: "text-yellow-400 border-yellow-400/30",    comingSoon: false },
              { id: "tesla",     difficulty: 2, tag: "MODERATE",  color: "text-yellow-400 border-yellow-400/30",    comingSoon: true  },
              { id: "google",    difficulty: 2, tag: "MODERATE",  color: "text-yellow-400 border-yellow-400/30",    comingSoon: false },
              { id: "uber",      difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: false },
              { id: "facebook",  difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: true  },
              { id: "tay",       difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: true  },
              { id: "stripe",    difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: false },
              { id: "amazon",    difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: false },
              { id: "twitter",   difficulty: 3, tag: "HARD",      color: "text-destructive border-destructive/30",  comingSoon: true  },
            ] as const).map(({ id, difficulty, tag, color, comingSoon }) => {
              const brief = SCENARIO_BRIEFS[id];
              if (!brief) return null;
              const stars = "★".repeat(difficulty) + "☆".repeat(3 - difficulty);
              return (
                <div
                  key={id}
                  data-testid={`scenario-card-${id}`}
                  title={comingSoon ? "Available in a future update." : undefined}
                  className={`relative text-left border p-4 space-y-2.5 transition-all ${
                    comingSoon
                      ? "border-border/20 bg-card/10 opacity-50 grayscale-[30%] cursor-not-allowed select-none"
                      : "group border-border/40 bg-card/20 hover:border-primary/40 hover:bg-primary/5 cursor-pointer focus:outline-none focus:border-primary/60"
                  }`}
                  onClick={comingSoon ? undefined : () => {
                    setShowScenarioPicker(false);
                    setShowLanding(false);
                    const newState = buildScenarioState(id);
                    persistState(newState);
                    setCurrentEvent(getEventForDay(newState));
                    setEventResolved(false);
                    setHistoryView(null);
                    if (id !== "default") {
                      setScenarioBrief(brief);
                    } else if (!playerName) {
                      setAuthMode("register");
                      setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError("");
                      setShowIdentity(true);
                    }
                  }}
                >
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[10px] tracking-widest text-muted-foreground border border-border/40 px-1.5 py-0.5 shrink-0">
                      {brief.company.toUpperCase()} · {brief.year}
                    </span>
                    {comingSoon ? (
                      <span className="text-[10px] tracking-widest border border-border/40 text-muted-foreground px-1.5 py-0.5 shrink-0">
                        COMING SOON
                      </span>
                    ) : (
                      <span className={`text-[10px] tracking-widest border px-1.5 py-0.5 shrink-0 ${color}`}>
                        {tag}
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <div className={`text-sm font-semibold leading-snug transition-colors ${comingSoon ? "text-muted-foreground" : "text-foreground group-hover:text-primary"}`}>
                    {brief.title}
                  </div>

                  {/* Tagline */}
                  <div className="text-[11px] text-muted-foreground/70 italic leading-relaxed">
                    &ldquo;{brief.tagline}&rdquo;
                  </div>

                  {/* Difficulty stars + problem type */}
                  <div className="flex items-center justify-between gap-2">
                    <div className={`text-sm tracking-widest ${comingSoon ? "text-muted-foreground/50" : color.split(" ")[0]}`}>{stars}</div>
                    <span className="text-[9px] tracking-widest border border-border/40 text-muted-foreground px-1.5 py-0.5 shrink-0 uppercase">
                      {SCENARIO_BRIEFS[id]?.problemType ?? "classification"}
                    </span>
                  </div>

                  {/* Handicap */}
                  {brief.startingHandicap && !comingSoon && (
                    <div className="border-l-2 border-destructive/40 pl-2 text-[10px] text-destructive/80 leading-relaxed">
                      {brief.startingHandicap}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Scenario Briefing Modal */}
      <Dialog open={!!scenarioBrief} onOpenChange={(open) => { if (!open) setScenarioBrief(null); }}>
        <DialogContent className="bg-card border-primary/40 text-foreground font-mono max-w-lg rounded-none">
          {scenarioBrief && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] tracking-widest text-muted-foreground border border-border/40 px-2 py-0.5">
                    {scenarioBrief.company.toUpperCase()} &middot; {scenarioBrief.year}
                  </span>
                  <span className="text-[9px] tracking-widest border border-primary/30 text-primary/70 px-1.5 py-0.5 uppercase">
                    {scenarioBrief.problemType}
                  </span>
                </div>
                <DialogTitle className="text-primary text-lg tracking-tight leading-snug">
                  {scenarioBrief.title}
                </DialogTitle>
                <p className="text-xs text-muted-foreground italic mt-0.5">&ldquo;{scenarioBrief.tagline}&rdquo;</p>
              </DialogHeader>

              <div className="space-y-4 py-1">
                {/* What happened */}
                <div>
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-1.5">WHAT HAPPENED</div>
                  <p className="text-sm leading-relaxed">{scenarioBrief.whatHappened}</p>
                </div>

                {/* Key risk */}
                <div className="border border-yellow-400/30 bg-yellow-400/5 p-3">
                  <div className="text-[10px] tracking-widest text-yellow-400 mb-1.5">KEY RISK IN YOUR RUN</div>
                  <p className="text-sm leading-relaxed text-yellow-400/90">{scenarioBrief.keyRisk}</p>
                </div>

                {/* Lesson */}
                <div className="border-l-2 border-primary/40 pl-3">
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-1.5">LESSON</div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{scenarioBrief.lesson}</p>
                </div>

                {/* Starting handicap */}
                {scenarioBrief.startingHandicap && (
                  <div className="bg-destructive/10 border border-destructive/30 p-2.5">
                    <div className="text-[10px] tracking-widest text-destructive mb-1">STARTING HANDICAP</div>
                    <p className="text-xs text-destructive/80">{scenarioBrief.startingHandicap}</p>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  onClick={() => {
                    setScenarioBrief(null);
                    if (!playerName) {
                      setAuthMode("register");
                      setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError("");
                      setShowIdentity(true);
                    }
                  }}
                  className="w-full font-bold tracking-widest"
                  data-testid="button-start-scenario"
                >
                  ACCEPT MISSION
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reset Confirm Modal */}
      <Dialog open={showReset} onOpenChange={setShowReset}>
        <DialogContent className="bg-card border-destructive/40 text-foreground font-mono max-w-sm rounded-none">
          <DialogHeader>
            <DialogTitle className="text-destructive tracking-widest">RESET GAME</DialogTitle>
            <DialogDescription className="text-foreground text-sm">
              This will erase all progress for the current run. Are you sure?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowReset(false)}
              className="flex-1"
              data-testid="button-cancel-reset"
            >
              CANCEL
            </Button>
            <Button
              variant="destructive"
              onClick={handleReset}
              className="flex-1"
              data-testid="button-confirm-reset"
            >
              CONFIRM RESET
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Player Auth dialog */}
      <Dialog open={showIdentity} onOpenChange={setShowIdentity}>
        <DialogContent className="bg-card border-primary/30 font-mono max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">
              {authMode === "register" ? "CREATE ACCOUNT" : "SIGN IN"}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              {authMode === "register"
                ? "Choose a username and password. Your progress is saved automatically and locked to your credentials."
                : "Enter your username and password to resume your saved run on any device."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-1">
            {/* Tab toggle */}
            <div className="flex border border-border/40">
              {(["register", "login"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => { setAuthMode(mode); setAuthError(""); }}
                  className={`flex-1 text-[10px] tracking-widest py-1.5 transition-colors ${
                    authMode === mode
                      ? "bg-primary/10 text-primary border-primary/30"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode === "register" ? "NEW PLAYER" : "RETURNING PLAYER"}
                </button>
              ))}
            </div>

            {/* Username */}
            <div>
              <label htmlFor="game-auth-username" className="block text-[10px] tracking-widest text-muted-foreground mb-1">USERNAME</label>
              <input
                id="game-auth-username"
                type="text"
                placeholder="e.g. dr_gradient"
                value={authUsername}
                autoFocus
                maxLength={24}
                autoComplete="username"
                onChange={(e) => { setAuthUsername(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 tracking-wider"
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="game-auth-password" className="block text-[10px] tracking-widest text-muted-foreground mb-1">PASSWORD</label>
              <input
                id="game-auth-password"
                type="password"
                placeholder="Min. 4 characters"
                value={authPassword}
                maxLength={72}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                onChange={(e) => { setAuthPassword(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50"
              />
            </div>

            {/* Confirm password (register only) */}
            {authMode === "register" && (
              <div>
                <label htmlFor="game-auth-confirm" className="block text-[10px] tracking-widest text-muted-foreground mb-1">CONFIRM PASSWORD</label>
                <input
                  id="game-auth-confirm"
                  type="password"
                  placeholder="Repeat password"
                  value={authConfirm}
                  maxLength={72}
                  autoComplete="new-password"
                  onChange={(e) => { setAuthConfirm(e.target.value); setAuthError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleRegister(); }}
                  className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50"
                />
              </div>
            )}

            {authError && (
              <p role="alert" className="text-[10px] text-destructive leading-relaxed border-l-2 border-destructive/40 pl-2">{authError}</p>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                className="flex-1 font-bold tracking-widest"
                disabled={authPending}
                onClick={authMode === "register" ? handleRegister : handleLogin}
              >
                {authPending ? "CONNECTING…" : authMode === "register" ? "CREATE ACCOUNT" : "SIGN IN"}
              </Button>
              <Button
                variant="outline"
                className="border-border/40 text-muted-foreground hover:text-foreground text-xs"
                onClick={() => setShowIdentity(false)}
              >
                {playerName ? "CANCEL" : "SKIP"}
              </Button>
            </div>

            {!playerName && (
              <p className="text-[9px] text-muted-foreground/50 text-center">
                You can play as a guest — scores won't appear on the leaderboard.
              </p>
            )}

            <p className="text-[9px] text-muted-foreground/60 text-center leading-relaxed">
              Passwords are hashed and never stored in plain text.
              Wrong password = no access to that account's save.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Carry-over prompt — shown when signing in/registering mid-game */}
      <Dialog open={pendingCarryOver !== null} onOpenChange={(open) => { if (!open) handleDiscardCarryOver(); }}>
        <DialogContent className="bg-card border-primary/30 font-mono max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">CARRY OVER YOUR RUN?</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              You are on <span className="text-primary font-bold">Day {gameState.day}</span> of a{" "}
              <span className="text-primary font-bold capitalize">{gameState.scenario}</span> run.{" "}
              {pendingCarryOver?.isRegister
                ? "Carry it over to your new account, or start fresh?"
                : "Carry it over to this account, or load your account's last saved progress?"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2">
            <Button className="w-full font-bold tracking-widest" onClick={handleCarryOver}>
              ▶ YES, CARRY OVER DAY {gameState.day} RUN
            </Button>
            <Button
              variant="outline"
              className="w-full border-border/40 text-muted-foreground hover:text-foreground text-xs tracking-widest"
              onClick={handleDiscardCarryOver}
            >
              {pendingCarryOver?.isRegister ? "NO, START FRESH" : "NO, LOAD MY ACCOUNT"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Save / Restore dialog */}
      <Dialog open={showSave} onOpenChange={setShowSave}>
        <DialogContent className="bg-card border-primary/30 font-mono max-w-md">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">SAVE / RESTORE</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              Your run is auto-saved every turn. Use your save code to resume on any device or browser.
            </DialogDescription>
          </DialogHeader>

          {/* Current save code */}
          <div className="space-y-2">
            <div className="text-[10px] tracking-widest text-muted-foreground">YOUR SAVE CODE</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-secondary/40 border border-border/40 px-3 py-2 text-xs text-primary break-all select-all">
                {sessionId ?? "Generating…"}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-primary/40 text-primary hover:bg-primary/10 text-xs"
                disabled={!sessionId}
                onClick={() => {
                  if (sessionId) {
                    navigator.clipboard.writeText(sessionId).then(() => {
                      setCodeCopied(true);
                      setTimeout(() => setCodeCopied(false), 2000);
                    });
                  }
                }}
              >
                {codeCopied ? "COPIED!" : "COPY"}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Day {gameState.day}/14 · {gameState.scenario} · {gameState.status}
            </p>
          </div>

          <div className="border-t border-border/40 pt-4 space-y-2">
            <div className="text-[10px] tracking-widest text-muted-foreground">RESTORE FROM CODE</div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Paste your save code here…"
                value={restoreInput}
                onChange={(e) => { setRestoreInput(e.target.value); setRestoreError(""); }}
                className="flex-1 bg-secondary/40 border border-border/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50"
              />
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-primary/40 text-primary hover:bg-primary/10 text-xs"
                disabled={!restoreInput.trim()}
                onClick={() => {
                  const code = restoreInput.trim();
                  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                  if (!uuidRegex.test(code)) {
                    setRestoreError("Invalid code format. Save codes look like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
                    return;
                  }
                  localStorage.setItem("modelForge_sessionId", code);
                  window.location.reload();
                }}
              >
                LOAD
              </Button>
            </div>
            {restoreError && (
              <p className="text-[10px] text-destructive leading-relaxed">{restoreError}</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Loading a save code will replace your current session. Make sure you've copied your current code first if you want to keep it.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Codex Sheet */}
      <Sheet open={showCodex} onOpenChange={setShowCodex}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-xl bg-card border-l border-primary/20 font-mono text-foreground overflow-y-auto p-0"
        >
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/40 sticky top-0 bg-card z-10">
            <SheetTitle className="text-primary tracking-widest text-sm">MLOPS CODEX</SheetTitle>
            <p className="text-[10px] text-muted-foreground">
              Reference guide — metrics, concepts, and win/loss conditions
            </p>
            <div className="flex gap-1 pt-2 overflow-x-auto pb-0.5">
              {(["metrics", "concepts", "reference", "scenarios"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setCodexSection(tab)}
                  className={`text-[10px] tracking-widest px-2.5 py-1 border transition-colors shrink-0 ${
                    codexSection === tab
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
          </SheetHeader>

          <div className="px-5 py-4 space-y-5">
            {/* ---- METRICS TAB ---- */}
            {codexSection === "metrics" && (
              <>
                {getCodexMetrics(gameState.scenario).map((m) => (
                  <details key={m.name} className="group border border-border/40 open:border-primary/30">
                    <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none list-none hover:bg-primary/5 transition-colors">
                      <span className="text-primary text-sm">{m.icon}</span>
                      <span className="text-xs font-bold tracking-widest flex-1">{m.name}</span>
                      <span className="text-[10px] text-muted-foreground border border-border/40 px-1.5 py-0.5">
                        LOSS @ {m.lossThreshold}
                      </span>
                      <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">▶</span>
                    </summary>
                    <div className="px-4 pb-4 pt-2 space-y-3 border-t border-border/30">
                      <div>
                        <div className="text-[9px] tracking-widest text-muted-foreground mb-1">DEFINITION</div>
                        <p className="text-xs leading-relaxed">{m.definition}</p>
                      </div>
                      <div className="bg-secondary/30 px-2.5 py-1.5">
                        <span className="text-[9px] tracking-widest text-muted-foreground">FORMULA: </span>
                        <span className="text-xs text-primary/80 font-mono">{m.formula}</span>
                      </div>
                      <div>
                        <div className="text-[9px] tracking-widest text-muted-foreground mb-1">WHY IT MATTERS</div>
                        <p className="text-xs leading-relaxed text-muted-foreground">{m.whyItMatters}</p>
                      </div>
                      <div>
                        <div className="text-[9px] tracking-widest text-destructive mb-1.5">WHAT CAUSES IT TO DROP</div>
                        <ul className="space-y-1">
                          {m.causes.map((c, i) => (
                            <li key={i} className="text-xs flex gap-2">
                              <span className="text-destructive shrink-0">—</span>
                              <span className="text-muted-foreground">{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="text-[9px] tracking-widest text-primary mb-1.5">HOW TO RECOVER</div>
                        <ul className="space-y-1">
                          {m.recovery.map((r, i) => (
                            <li key={i} className="text-xs flex gap-2">
                              <span className="text-primary shrink-0">+</span>
                              <span>{r}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </details>
                ))}
              </>
            )}

            {/* ---- CONCEPTS TAB ---- */}
            {codexSection === "concepts" && (
              <>
                {CODEX_CONCEPTS.map((c) => (
                  <details key={c.term} className="group border border-border/40 open:border-primary/30">
                    <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none list-none hover:bg-primary/5 transition-colors">
                      <span className="text-primary text-sm">{c.icon}</span>
                      <span className="text-xs font-bold tracking-widest flex-1">{c.term}</span>
                      <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">▶</span>
                    </summary>
                    <div className="px-4 pb-4 pt-2 space-y-3 border-t border-border/30">
                      <p className="text-xs leading-relaxed">{c.explanation}</p>
                      {c.benefit !== "N/A — a constraint, not a feature." &&
                        c.benefit !== "N/A — drift is a hazard, not a feature." &&
                        c.benefit !== "N/A — skew is a hazard." && (
                        <div className="border-l-2 border-primary/40 pl-2.5">
                          <div className="text-[9px] tracking-widest text-primary mb-0.5">BENEFIT</div>
                          <p className="text-xs text-primary/80">{c.benefit}</p>
                        </div>
                      )}
                      {c.cost && (
                        <div className="border-l-2 border-yellow-400/40 pl-2.5">
                          <div className="text-[9px] tracking-widest text-yellow-400 mb-0.5">TRADE-OFF</div>
                          <p className="text-xs text-yellow-400/80">{c.cost}</p>
                        </div>
                      )}
                    </div>
                  </details>
                ))}
              </>
            )}

            {/* ---- REFERENCE TAB ---- */}
            {codexSection === "reference" && (
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-3">WIN / LOSS CONDITIONS</div>
                  <div className="space-y-2">
                    {CODEX_WIN_LOSS.map((entry, i) => (
                      <div
                        key={i}
                        className={`border p-2.5 ${
                          entry.type === "win"
                            ? "border-primary/30 bg-primary/5"
                            : "border-destructive/30 bg-destructive/5"
                        }`}
                      >
                        <div className={`text-xs font-bold mb-0.5 ${entry.type === "win" ? "text-primary" : "text-destructive"}`}>
                          {entry.type === "win" ? "WIN" : "LOSS"}: {entry.label}
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.note}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-border/40 pt-4">
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-3">PASSIVE DECAY (PER TURN)</div>
                  <div className="space-y-1.5 text-xs">
                    {[
                      [metricLabels.precision, "−1% per day"],
                      [metricLabels.recall, "−1% per day"],
                      ["SLA Adherence", "−0.5% per day"],
                      ["Feature Staleness", "+2h per day (Feature Store OFF)"],
                      ["Feature Staleness", "Reset to 2h per day (Feature Store ON)"],
                      [`${metricLabels.precision} (CI/CD ON)`, "+2% per day (offsets natural decay)"],
                    ].map(([label, value], i) => (
                      <div key={i} className="flex justify-between border-b border-border/20 pb-1">
                        <span className="text-muted-foreground">{label}</span>
                        <span className={value!.startsWith("+") ? "text-primary" : "text-destructive"}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-border/40 pt-4">
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-3">USER LEVEL UNLOCKS</div>
                  <div className="space-y-2 text-xs">
                    {[
                      { level: "INTERN", unlocks: "Core metrics, incident events, event log" },
                      { level: "ML ENGINEER", unlocks: "Model Registry — see all model versions, stages, and metadata" },
                      { level: "MLOPS LEAD", unlocks: "Infrastructure controls (Feature Store, CI/CD toggles) + Time Travel Debugger" },
                    ].map((entry) => (
                      <div key={entry.level} className="border border-border/30 p-2">
                        <div className="font-bold text-primary mb-0.5">{entry.level}</div>
                        <div className="text-muted-foreground">{entry.unlocks}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-border/40 pt-4">
                  <p className="text-[10px] text-muted-foreground">
                    See the <span className="text-primary cursor-pointer underline underline-offset-2" onClick={() => setCodexSection("scenarios")}>SCENARIOS tab</span> for per-scenario difficulty rationale, starting debt, signature events, and scoring traps.
                  </p>
                </div>
              </div>
            )}

            {/* ---- SCENARIOS TAB ---- */}
            {codexSection === "scenarios" && (
              <>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Per-scenario breakdown: what you inherit, what the signature event is, why the difficulty tier is justified, and what mistake costs the most points.
                </p>
                {CODEX_SCENARIO_DIFFICULTY.map((s) => {
                  const tierLabel = s.difficulty === 1 ? "BEGINNER ★☆☆" : s.difficulty === 2 ? "MODERATE ★★☆" : "HARD ★★★";
                  const tierColor = s.difficulty === 1 ? "text-primary border-primary/40" : s.difficulty === 2 ? "text-yellow-400 border-yellow-400/40" : "text-destructive border-destructive/40";
                  const problemLabel = s.problemType === "classification" ? "CLASSIFICATION" : s.problemType === "regression" ? "REGRESSION" : s.problemType === "ranking" ? "RANKING" : "GENERATIVE";
                  return (
                    <details key={s.id} id={`codex-scenario-${s.id}`} className={`group border open:border-primary/30 ${s.comingSoon ? "border-border/20 opacity-50" : "border-border/40"}`}>
                      <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none list-none hover:bg-primary/5 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold tracking-widest">{s.company}</span>
                            <span className="text-[9px] text-muted-foreground">{s.year}</span>
                            {s.comingSoon && <span className="text-[9px] border border-border/40 px-1 text-muted-foreground">COMING SOON</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">{s.title}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-[9px] border px-1.5 py-0.5 ${tierColor}`}>{tierLabel}</span>
                          <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">▶</span>
                        </div>
                      </summary>
                      <div className="px-4 pb-4 pt-3 space-y-3.5 border-t border-border/30">
                        {/* Problem type badge */}
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] tracking-widest text-muted-foreground">PROBLEM TYPE</span>
                          <span className="text-[9px] border border-border/40 px-1.5 py-0.5 text-muted-foreground">{problemLabel}</span>
                        </div>

                        {/* Why this tier */}
                        <div>
                          <div className="text-[9px] tracking-widest text-muted-foreground mb-1">WHY THIS TIER</div>
                          <p className="text-xs leading-relaxed">{s.tierRationale}</p>
                        </div>

                        {/* Starting debt */}
                        <div>
                          <div className="text-[9px] tracking-widest text-yellow-400/80 mb-1.5">WHAT YOU INHERIT</div>
                          <ul className="space-y-1">
                            {s.startingDebt.map((d, i) => (
                              <li key={i} className="text-xs flex gap-2">
                                <span className="text-yellow-400/70 shrink-0">—</span>
                                <span className="text-muted-foreground">{d}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Signature event */}
                        <div className="bg-secondary/20 border border-border/30 px-3 py-2.5 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] tracking-widest text-muted-foreground">SIGNATURE EVENT</span>
                            <span className="text-[9px] border border-border/40 px-1.5 py-0.5 text-muted-foreground">DAY {s.signatureEvent.day}</span>
                          </div>
                          <div className="text-[10px] font-bold text-primary tracking-wide">{s.signatureEvent.name}</div>
                          <p className="text-xs text-muted-foreground leading-relaxed">{s.signatureEvent.insight}</p>
                        </div>

                        {/* Scoring trap */}
                        <div className="border-l-2 border-destructive/40 pl-2.5">
                          <div className="text-[9px] tracking-widest text-destructive mb-1">SCORING TRAP</div>
                          <p className="text-xs text-muted-foreground leading-relaxed">{s.scoringTrap}</p>
                        </div>
                      </div>
                    </details>
                  );
                })}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
