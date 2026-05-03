import { useEffect, useState, useCallback, useRef } from "react";
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

const CODEX_METRICS = [
  {
    name: "PRECISION",
    icon: "◎",
    definition: "Of all predictions your model labels as positive, what fraction are actually positive?",
    formula: "True Positives / (True Positives + False Positives)",
    whyItMatters:
      "Low precision means your model cries wolf — real users get false alarms or irrelevant recommendations, eroding trust fast.",
    causes: [
      "Passive decay — distributions shift daily as user behavior evolves",
      "Overfitting to training data that doesn't match live distribution",
      "Data poisoning contaminating the training pipeline",
      "Concept drift making previously valid signals noise",
    ],
    recovery: [
      "Retrain on a fresh dataset with a larger, more representative sample",
      "Promote a staged model that was trained more recently",
      "Add a validation set that better mirrors production distribution",
      "Enable CI/CD auto-retraining to keep the model current",
    ],
    lossThreshold: "≤ 0%",
  },
  {
    name: "RECALL",
    icon: "◉",
    definition: "Of all actual positives in the world, what fraction does your model successfully detect?",
    formula: "True Positives / (True Positives + False Negatives)",
    whyItMatters:
      "Low recall means you're missing real signals. In fraud detection, that's undetected fraud. In medical AI, that's missed diagnoses. The cost of missing positives is often higher than false alarms.",
    causes: [
      "Overfitting that tunes precision while sacrificing recall on rare classes",
      "Concept drift changing what a 'positive' looks like in production",
      "Data imbalance — the model under-learns the minority class",
      "Passive decay as distribution slowly shifts away from training baseline",
    ],
    recovery: [
      "Adjust the classification threshold (lower it to catch more positives)",
      "Retrain with oversampled minority-class examples",
      "Switch to a model type better suited to imbalanced data (e.g. Ensemble)",
      "Add recall as an explicit optimization target alongside precision",
    ],
    lossThreshold: "≤ 0%",
  },
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
    lossThreshold: "> 48h",
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
      "Your model learned patterns from training data. If the features it sees in production look different, its learned patterns no longer apply — predictions degrade silently without any explicit metric dropping immediately.",
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
      "A continuous integration and deployment pipeline that automatically retrains your model on a schedule or when drift is detected, runs validation tests, and promotes the new model to staging. In the game, enabling it adds +2% Precision per day — simulating the benefit of keeping your model current.",
    benefit: "+2% Precision per day. Counters concept drift automatically over time.",
    cost: "Increased Inference Cost from compute for retraining runs.",
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

const CODEX_WIN_LOSS = [
  { label: "Precision ≤ 0%", type: "loss", note: "Model outputs are effectively random. Immediate retrain or rollback required." },
  { label: "Recall ≤ 0%", type: "loss", note: "Model detects nothing. Complete miss rate on all positive cases." },
  { label: "SLA Adherence ≤ 0%", type: "loss", note: "Complete production outage. No inference requests are completing." },
  { label: "Feature Staleness > 48h", type: "loss", note: "Features are 2+ days old. Model is predicting on a distribution that no longer exists." },
  { label: "Inference Cost ≥ 100", type: "loss", note: "Infrastructure budget exhausted. The cluster shuts down." },
  { label: "Survive all 14 days", type: "win", note: "You maintained production without a critical outage. Congratulations — most models don't." },
];

// ---- Helpers ----

function metricColor(value: number): string {
  if (value > 70) return "text-primary";
  if (value > 30) return "text-yellow-400";
  return "text-destructive";
}

function metricBarColor(value: number): string {
  if (value > 70) return "bg-primary";
  if (value > 30) return "bg-yellow-400";
  return "bg-destructive";
}

function skewBadgeClass(skew: string): string {
  if (skew === "Low") return "bg-primary/20 text-primary border-primary/40";
  if (skew === "Medium") return "bg-yellow-400/20 text-yellow-400 border-yellow-400/40";
  return "bg-destructive/20 text-destructive border-destructive/40";
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
  return (
    <div data-testid={`metric-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className={metricColor(pct)}>{subtitle ?? `${value.toFixed(1)}%`}</span>
      </div>
      <div className="h-1.5 bg-secondary/60 rounded-none overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${metricBarColor(pct)}`}
          style={{ width: `${pct}%` }}
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
  const [codexSection, setCodexSection] = useState<"metrics" | "concepts" | "reference">("metrics");
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
  const [showLeaderboard, setShowLeaderboard] = useState(false);
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
      if (loadData.isDefault && loaded.day === 1 && loaded.eventLog.length === 0) {
        setShowTutorial(true);
      } else if (!playerName) {
        setAuthMode("login");
        setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError("");
        setShowIdentity(true);
      }
      const ev = getEventForDay(loaded);
      setCurrentEvent(ev);
      setEventResolved(false);
    }
  }, [loadData]); // eslint-disable-line react-hooks/exhaustive-deps

  const validateAuthFields = (): string | null => {
    const name = authUsername.trim().toLowerCase();
    if (name.length < 2 || name.length > 24) return "Username must be 2–24 characters.";
    if (!/^[a-z0-9_-]+$/.test(name)) return "Only letters, numbers, _ and - allowed in username.";
    if (authPassword.length < 4) return "Password must be at least 4 characters.";
    if (authMode === "register" && authPassword !== authConfirm) return "Passwords do not match.";
    return null;
  };

  const handleAuthSuccess = (result: { sessionId: string; username: string }) => {
    localStorage.setItem("modelForge_playerName", result.username);
    localStorage.setItem("modelForge_sessionId", result.sessionId);
    setPlayerName(result.username);
    if (result.sessionId !== sessionId) {
      window.location.reload();
    } else {
      setShowIdentity(false);
    }
  };

  const handleRegister = () => {
    const err = validateAuthFields();
    if (err) { setAuthError(err); return; }
    setAuthError("");
    registerMutation.mutate(
      { data: { username: authUsername.trim().toLowerCase(), password: authPassword } },
      {
        onSuccess: handleAuthSuccess,
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
        onSuccess: handleAuthSuccess,
        onError: (e: unknown) => {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setAuthError(msg ?? "Login failed. Please try again.");
        },
      }
    );
  };

  useEffect(() => {
    document.documentElement.classList.add("dark");
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
    // Apply starting handicaps per scenario
    switch (scenario) {
      case "zillow":
      case "tesla":
        base.metrics = { ...base.metrics, recall: 75 };
        break;
      case "tay":
      case "stripe":
      case "amazon":
      case "twitter":
        base.metrics = { ...base.metrics, skew: "Medium" };
        break;
      case "uber":
      case "facebook":
        base.metrics = { ...base.metrics, slaAdherence: 91 };
        break;
      case "netflix":
      case "google":
        base.metrics = { ...base.metrics, precision: 78 };
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
  const postMortem = gameState.status === "lost" ? generatePostMortem(gameState) : [];
  const dailyBrief = gameState.status === "playing" ? generateDailyBrief(gameState) : null;

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

  if (!sessionId) {
    return (
      <div className="min-h-screen bg-background text-primary font-mono flex items-center justify-center">
        <div className="animate-pulse text-lg tracking-widest">INITIALIZING SYSTEM...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      {/* Header */}
      <header className="border-b border-border bg-card/50 px-4 md:px-8 py-4 sticky top-0 z-10 backdrop-blur-sm">
        <div className="max-w-screen-xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tighter leading-none">
              THE MODEL FORGE<span className="animate-pulse ml-0.5">_</span>
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs text-muted-foreground tracking-widest">ML PRODUCTION SIMULATOR</p>
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
                  className="text-[10px] text-muted-foreground/60 border border-border/30 px-1.5 py-0.5 tracking-widest hover:border-primary/40 hover:text-primary/70 transition-colors"
                >
                  SIGN IN
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <div
              data-testid="day-counter"
              className="text-xl font-bold border border-primary/40 px-3 py-1 text-primary"
            >
              DAY {gameState.day}/14
            </div>
            {gameState.wins > 0 && (
              <Badge className="bg-primary/20 text-primary border-primary/40">
                {gameState.wins} WIN{gameState.wins > 1 ? "S" : ""}
              </Badge>
            )}
            <Select value={gameState.scenario} onValueChange={handleScenarioChange}>
              <SelectTrigger className="w-[160px] text-xs" data-testid="select-scenario">
                <SelectValue placeholder="Scenario" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="zillow">Zillow (Overfitting)</SelectItem>
                <SelectItem value="tay">Microsoft Tay (Poisoning)</SelectItem>
                <SelectItem value="amazon">Amazon (Bias)</SelectItem>
                <SelectItem value="uber">Uber (Latency)</SelectItem>
                <SelectItem value="netflix">Netflix (Drift)</SelectItem>
                <SelectItem value="tesla">Tesla (Overfitting)</SelectItem>
                <SelectItem value="twitter">Twitter (Bias)</SelectItem>
                <SelectItem value="facebook">Facebook (Latency)</SelectItem>
                <SelectItem value="google">Google (Drift)</SelectItem>
                <SelectItem value="stripe">Stripe (Poisoning)</SelectItem>
              </SelectContent>
            </Select>
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
            <Button
              variant="outline"
              size="sm"
              className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs"
              onClick={() => { setShowSave(true); setRestoreInput(""); setRestoreError(""); setCodeCopied(false); }}
              data-testid="button-save"
            >
              SAVE
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs"
              onClick={() => setShowCodex(true)}
              data-testid="button-codex"
            >
              CODEX
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-primary/70 border-primary/30 hover:bg-primary/10 hover:text-primary text-xs"
              onClick={() => setShowLeaderboard(true)}
              data-testid="button-leaderboard"
            >
              SCORES
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/40 hover:bg-destructive/10 text-xs"
              onClick={() => setShowReset(true)}
              data-testid="button-reset"
            >
              RESET
            </Button>
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

      <main className="max-w-screen-xl mx-auto p-4 md:p-8 grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* ---- COL 1: Metrics ---- */}
        <div className="space-y-5">
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs tracking-widest text-muted-foreground">SYSTEM METRICS</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <MetricBar label="Precision" value={viewState.metrics.precision} />
              <MetricBar label="Recall" value={viewState.metrics.recall} />
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
                  className={`text-xs font-bold border px-2 py-0.5 ${skewBadgeClass(viewState.metrics.skew)}`}
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
                    <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.05)" />
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
                    <Line type="monotone" dataKey="Precision" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="Recall" stroke="#60a5fa" strokeWidth={1.5} dot={false} />
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
                ? "border-primary/60 shadow-[0_0_20px_rgba(57,255,20,0.08)]"
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
                <div className="space-y-4">
                  <div
                    className={`border p-4 ${
                      gameState.status === "won"
                        ? "border-primary/50 bg-primary/5 text-primary"
                        : "border-destructive/50 bg-destructive/5 text-destructive"
                    }`}
                  >
                    <div className="font-bold text-lg tracking-widest mb-1">
                      {gameState.status === "won" ? "PRODUCTION READY" : "SYSTEM FAILURE"}
                    </div>
                    <p className="text-sm opacity-80">
                      {gameState.status === "won"
                        ? `You survived all 14 days. Final precision: ${gameState.metrics.precision.toFixed(0)}%, recall: ${gameState.metrics.recall.toFixed(0)}%`
                        : "A critical metric reached 0 or exceeded safety thresholds."}
                    </p>
                  </div>
                  <Button
                    className="w-full"
                    variant={gameState.status === "won" ? "default" : "destructive"}
                    onClick={handleReset}
                    data-testid="button-play-again"
                  >
                    {gameState.status === "won" ? "PLAY AGAIN" : "TRY AGAIN"}
                  </Button>
                  {gameState.status === "won" && (
                    <Button variant="outline" className="w-full text-xs" onClick={shareRun}>
                      COPY SHAREABLE LINK
                    </Button>
                  )}
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
              <div ref={logRef} className="h-52 overflow-y-auto px-4 pb-4 space-y-2 text-xs">
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

      {/* Tutorial Modal */}
      {/* Leaderboard Modal */}
      <Dialog open={showLeaderboard} onOpenChange={setShowLeaderboard}>
        <DialogContent className="bg-card border-primary/30 font-mono max-w-2xl w-full">
          <DialogHeader>
            <DialogTitle className="text-primary tracking-widest text-sm">GLOBAL LEADERBOARD</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Top 10 completed runs ranked by days survived, then cumulative wins.
              Sign in to claim your name on the board.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2">
            {!leaderboardData?.entries || leaderboardData.entries.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-xs tracking-widest">
                NO COMPLETED RUNS YET. BE THE FIRST TO SURVIVE ALL 14 DAYS.
              </div>
            ) : (
              <div className="space-y-0">
                {/* Header row */}
                <div className="grid grid-cols-[2rem_1fr_5rem_4rem_4rem_4rem_4rem] gap-2 text-[10px] tracking-widest text-muted-foreground border-b border-border/40 pb-2 mb-1">
                  <span>#</span>
                  <span>PLAYER</span>
                  <span>SCENARIO</span>
                  <span className="text-right">DAY</span>
                  <span className="text-right">WINS</span>
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
                      className={`grid grid-cols-[2rem_1fr_5rem_4rem_4rem_4rem_4rem] gap-2 items-center py-2 text-xs border-b border-border/20 last:border-0 transition-colors ${
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
                      <span className={`text-right font-bold ${e.day >= 14 ? "text-primary" : "text-foreground/60"}`}>
                        {e.day}/14
                      </span>
                      <span className="text-right text-muted-foreground">{e.wins}</span>
                      <span className="text-right">{e.precision.toFixed(1)}%</span>
                      <span className="text-right">{e.recall.toFixed(1)}%</span>
                    </div>
                  );
                })}
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
                if (!playerName) {
                  setAuthMode("register");
                  setAuthUsername(""); setAuthPassword(""); setAuthConfirm(""); setAuthError("");
                  setShowIdentity(true);
                }
              }}
              className="w-full font-bold tracking-widest"
              data-testid="button-start-game"
            >
              ACKNOWLEDGE AND BEGIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scenario Briefing Modal */}
      <Dialog open={!!scenarioBrief} onOpenChange={(open) => { if (!open) setScenarioBrief(null); }}>
        <DialogContent className="bg-card border-primary/40 text-foreground font-mono max-w-lg rounded-none">
          {scenarioBrief && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-[10px] tracking-widest text-muted-foreground border border-border/40 px-2 py-0.5">
                    {scenarioBrief.company.toUpperCase()} &middot; {scenarioBrief.year}
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
                  onClick={() => setScenarioBrief(null)}
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
      <Dialog open={showIdentity} onOpenChange={(open) => { if (!open && playerName) setShowIdentity(false); }}>
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
              <div className="text-[10px] tracking-widest text-muted-foreground mb-1">USERNAME</div>
              <input
                type="text"
                placeholder="e.g. dr_gradient"
                value={authUsername}
                autoFocus
                maxLength={24}
                onChange={(e) => { setAuthUsername(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 tracking-wider"
              />
            </div>

            {/* Password */}
            <div>
              <div className="text-[10px] tracking-widest text-muted-foreground mb-1">PASSWORD</div>
              <input
                type="password"
                placeholder="Min. 4 characters"
                value={authPassword}
                maxLength={72}
                onChange={(e) => { setAuthPassword(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") authMode === "register" ? handleRegister() : handleLogin(); }}
                className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50"
              />
            </div>

            {/* Confirm password (register only) */}
            {authMode === "register" && (
              <div>
                <div className="text-[10px] tracking-widest text-muted-foreground mb-1">CONFIRM PASSWORD</div>
                <input
                  type="password"
                  placeholder="Repeat password"
                  value={authConfirm}
                  maxLength={72}
                  onChange={(e) => { setAuthConfirm(e.target.value); setAuthError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleRegister(); }}
                  className="w-full bg-secondary/40 border border-border/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50"
                />
              </div>
            )}

            {authError && (
              <p className="text-[10px] text-destructive leading-relaxed border-l-2 border-destructive/40 pl-2">{authError}</p>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                className="flex-1 font-bold tracking-widest"
                disabled={authPending}
                onClick={authMode === "register" ? handleRegister : handleLogin}
              >
                {authPending ? "CONNECTING…" : authMode === "register" ? "CREATE ACCOUNT" : "SIGN IN"}
              </Button>
              {playerName && (
                <Button
                  variant="outline"
                  className="border-border/40 text-muted-foreground hover:text-foreground text-xs"
                  onClick={() => setShowIdentity(false)}
                >
                  CANCEL
                </Button>
              )}
            </div>

            <p className="text-[9px] text-muted-foreground/60 text-center leading-relaxed">
              Passwords are hashed and never stored in plain text.
              Wrong password = no access to that account's save.
            </p>
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
            <div className="flex gap-1 pt-2">
              {(["metrics", "concepts", "reference"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setCodexSection(tab)}
                  className={`text-[10px] tracking-widest px-3 py-1 border transition-colors ${
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
                {CODEX_METRICS.map((m) => (
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
                      ["Precision", "−1% per day"],
                      ["Recall", "−1% per day"],
                      ["SLA Adherence", "−0.5% per day"],
                      ["Feature Staleness", "+2h per day (Feature Store OFF)"],
                      ["Feature Staleness", "Reset to 2h per day (Feature Store ON)"],
                      ["Precision (CI/CD ON)", "+2% per day (offsets natural decay)"],
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
                  <div className="text-[10px] tracking-widest text-muted-foreground mb-3">SCENARIO DIFFICULTY</div>
                  <div className="space-y-1.5 text-xs">
                    {[
                      { id: "default", label: "Default", difficulty: "Easy", risk: "No inherited problems" },
                      { id: "netflix-google", label: "Netflix / Google", difficulty: "Medium", risk: "Precision handicap + concept drift event" },
                      { id: "uber-facebook", label: "Uber / Facebook", difficulty: "Medium", risk: "SLA handicap + latency crisis event" },
                      { id: "zillow-tesla", label: "Zillow / Tesla", difficulty: "Hard", risk: "Recall handicap + overfitting event" },
                      { id: "amazon-twitter", label: "Amazon / Twitter", difficulty: "Hard", risk: "Skew handicap + bias audit event" },
                      { id: "tay-stripe", label: "Tay / Stripe", difficulty: "Hard", risk: "Skew handicap + data poisoning event" },
                    ].map((entry) => (
                      <div key={entry.id} className="flex items-start justify-between border-b border-border/20 pb-1.5 gap-3">
                        <div>
                          <div className="font-bold">{entry.label}</div>
                          <div className="text-muted-foreground text-[10px] mt-0.5">{entry.risk}</div>
                        </div>
                        <span className={`text-[10px] border px-1.5 py-0.5 shrink-0 ${
                          entry.difficulty === "Easy"
                            ? "border-primary/40 text-primary"
                            : entry.difficulty === "Medium"
                            ? "border-yellow-400/40 text-yellow-400"
                            : "border-destructive/40 text-destructive"
                        }`}>
                          {entry.difficulty.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
