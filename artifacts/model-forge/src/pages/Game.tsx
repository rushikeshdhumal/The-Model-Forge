import { useEffect, useState, useCallback, useRef } from "react";
import {
  useNewSession,
  useLoadState,
  useSaveState,
  useGetLeaderboard,
  getLoadStateQueryKey,
  getGetLeaderboardQueryKey,
} from "@workspace/api-client-react";
import { GameState, DEFAULT_STATE } from "@/lib/game-types";
import {
  GameEvent,
  DailyBriefData,
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
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

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

  const { data: leaderboardData } = useGetLeaderboard({
    query: { queryKey: getGetLeaderboardQueryKey() },
  });

  useEffect(() => {
    if (loadData) {
      const loaded = (loadData.state ?? DEFAULT_STATE) as GameState;
      setGameState(loaded);
      if (loadData.isDefault && loaded.day === 1 && loaded.eventLog.length === 0) {
        setShowTutorial(true);
      }
      // Compute event for current day
      const ev = getEventForDay(loaded);
      setCurrentEvent(ev);
      setEventResolved(false);
    }
  }, [loadData]);

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

  const handleScenarioChange = (val: string) => {
    const newState: GameState = { ...DEFAULT_STATE, sessionId: sessionId ?? "", scenario: val, wins: gameState.wins };
    persistState(newState);
    setCurrentEvent(getEventForDay(newState));
    setEventResolved(false);
    setHistoryView(null);
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
            <p className="text-xs text-muted-foreground tracking-widest mt-0.5">ML PRODUCTION SIMULATOR</p>
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

          {/* Leaderboard */}
          {leaderboardData?.entries && leaderboardData.entries.length > 0 && (
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs tracking-widest text-muted-foreground">TOP SURVIVORS</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-xs">
                  {leaderboardData.entries.slice(0, 5).map((e, i) => (
                    <div key={e.sessionId} className="flex justify-between items-center">
                      <span className="text-muted-foreground">#{i + 1} {e.scenario}</span>
                      <span className="text-primary">P:{e.precision.toFixed(0)}% R:{e.recall.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

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
              onClick={() => setShowTutorial(false)}
              className="w-full font-bold tracking-widest"
              data-testid="button-start-game"
            >
              ACKNOWLEDGE AND BEGIN
            </Button>
          </DialogFooter>
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
    </div>
  );
}
