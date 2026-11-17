/**
 * @file Decisions.tsx
 * @description AI Cockpit "Kararlar" page: the questions agents asked and the answers given, approved plans and written design files of one project, read from session transcripts. Search runs in memory over one load per project.
 * @author Caglar Ulkuderner
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Download, Loader2, MessageSquareQuote } from "lucide-react";
import { cockpit, type Decision, type DecisionProject, type DesignFile } from "../lib/cockpit";
import { DesignsTable, PlanRow, QuestionRow } from "../components/decisions/Rows";
import { GateCard } from "../components/flows/GateCard";

const TABS = ["pending", "decisions", "plans", "designs"] as const;
type Tab = (typeof TABS)[number];
type StatusFilter = "all" | "resolved" | "cancelled";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const answerOf = (d: Decision) => [d.payload?.answer ?? []].flat().join(" ");
const haystack = (d: Decision) =>
  [d.header, d.message, answerOf(d), d.payload?.note, d.payload?.plan].join(" ").toLowerCase();

export default function Decisions() {
  const { t } = useTranslation("cockpit");
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<DecisionProject[] | null>(null);
  const [data, setData] = useState<{ decisions: Decision[]; designs: DesignFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [menu, setMenu] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const project = params.get("project") ?? projects?.[0]?.root ?? null;
  const tabParam = params.get("tab");
  const tab: Tab = TABS.find((x) => x === tabParam) ?? "decisions";

  const patch = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(k, v);
        return n;
      },
      { replace: true }
    );

  useEffect(() => {
    cockpit
      .decisionProjects()
      .then((d) => setProjects(d.projects))
      .catch((e: Error) => setError(e.message));
  }, [attempt]);

  // One load per project; the first one may read every transcript (10-15 s).
  const load = useCallback(() => {
    if (!project) return;
    setData(null);
    setError(null);
    Promise.all([cockpit.decisions({ project, limit: 5000 }), cockpit.designs(project)])
      .then(([d, g]) => setData({ decisions: d.decisions, designs: g.designs }))
      .catch((e: Error) => setError(e.message));
  }, [project]);
  useEffect(load, [load, attempt]);

  const lists = useMemo(() => {
    const hit = (data?.decisions ?? []).filter((d) => haystack(d).includes(needle));
    const isPlan = (d: Decision) => d.reason === "plan_approval";
    return {
      pending: hit.filter((d) => d.status === "pending" && !isPlan(d)),
      asks: hit.filter((d) => !isPlan(d) && d.status !== "pending"),
      plans: hit.filter(isPlan),
      designs: (data?.designs ?? []).filter((x) =>
        `${x.path} ${x.kind}`.toLowerCase().includes(needle)
      ),
    };
  }, [data, needle]);
  const shownAsks = lists.asks.filter((d) => status === "all" || d.status === status);

  const counts: Record<Tab, number> = {
    pending: lists.pending.length,
    decisions: lists.asks.length,
    plans: lists.plans.length,
    designs: lists.designs.length,
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const n = (next + TABS.length) % TABS.length;
    patch("tab", TABS[n]!);
    tabRefs.current[n]?.focus();
  };

  const doExport = (format: "ag-ui" | "json") => {
    setMenu(false);
    setExportErr(null);
    cockpit
      .exportDecisions(project!, format)
      .catch((e: Error) => setExportErr(t("decisions.exportFailed", { message: e.message })));
  };

  const empty = (text: string) => (
    <p className="px-4 py-8 text-center text-sm text-gray-400">
      {needle ? t("decisions.emptySearch") : text}
    </p>
  );

  const body = () => {
    if (tab === "pending")
      return (
        <>
          <div className="card">
            {lists.pending.length ? (
              <ul className="divide-y divide-border">
                {lists.pending.map((d) =>
                  d.metadata?.kind === "gate" ? (
                    <GateCard key={d.id} d={d} onAnswered={load} />
                  ) : (
                    <QuestionRow key={d.id} d={d} />
                  )
                )}
              </ul>
            ) : (
              empty(t("decisions.emptyPending"))
            )}
          </div>
          {lists.pending.some((d) => d.metadata?.kind !== "gate") && (
            <p className="text-xs text-gray-500">{t("decisions.pendingHint")}</p>
          )}
        </>
      );
    if (tab === "decisions")
      return (
        <>
          <div role="group" aria-label={t("decisions.statusFilter")} className="flex gap-2">
            {(["all", "resolved", "cancelled"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={`rounded-full px-3 py-1 text-sm ${FOCUS} ${status === s ? "bg-surface-4 text-gray-100" : "bg-surface-2 text-gray-400 hover:text-gray-200"}`}
              >
                {t(
                  `decisions.${s === "all" ? "all" : s === "resolved" ? "answered" : "cancelled"}`
                )}
              </button>
            ))}
          </div>
          <div className="card">
            {shownAsks.length ? (
              <ul className="divide-y divide-border">
                {shownAsks.map((d) => (
                  <QuestionRow key={d.id} d={d} />
                ))}
              </ul>
            ) : (
              empty(t("decisions.emptyDecisions"))
            )}
          </div>
        </>
      );
    if (tab === "plans")
      return (
        <div className="card">
          {lists.plans.length ? (
            <ul className="divide-y divide-border">
              {lists.plans.map((d) => (
                <PlanRow key={d.id} d={d} />
              ))}
            </ul>
          ) : (
            empty(t("decisions.emptyPlans"))
          )}
        </div>
      );
    return (
      <div className="card overflow-x-auto">
        {lists.designs.length ? (
          <DesignsTable project={project!} designs={lists.designs} />
        ) : (
          empty(t("decisions.emptyDesigns"))
        )}
      </div>
    );
  };

  const field =
    "bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent";

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-muted flex items-center justify-center">
          <MessageSquareQuote className="w-5 h-5 text-accent" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-100">{t("decisions.title")}</h1>
          <p className="text-sm text-gray-500">{t("decisions.subtitle")}</p>
        </div>
      </header>

      {projects && projects.length === 0 && (
        <p className="card p-5 text-sm text-gray-400">{t("decisions.noProjects")}</p>
      )}

      {project && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label={t("decisions.project")}
              value={project}
              onChange={(e) => patch("project", e.target.value)}
              className={field}
            >
              {(projects ?? []).map((p) => (
                <option key={p.root} value={p.root}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label={t("decisions.search")}
              placeholder={t("decisions.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${field} flex-1 min-w-48`}
            />
            <div className="relative">
              <button
                type="button"
                aria-haspopup="true"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
                onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
                className={`inline-flex items-center gap-1.5 rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-200 hover:bg-surface-3 ${FOCUS}`}
              >
                <Download className="w-4 h-4" aria-hidden />
                {t("decisions.export")}
              </button>
              {menu && (
                <ul
                  className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-border bg-surface-3 p-1 shadow-lg"
                  onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
                >
                  {(["ag-ui", "json"] as const).map((f) => (
                    <li key={f}>
                      <button
                        type="button"
                        onClick={() => doExport(f)}
                        className={`w-full rounded-md px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-surface-5 ${FOCUS}`}
                      >
                        {t(f === "ag-ui" ? "decisions.exportAgUi" : "decisions.exportJson")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {exportErr && (
            <p className="text-sm text-red-400" role="alert">
              {exportErr}
            </p>
          )}

          <div
            role="tablist"
            aria-label={t("decisions.sections")}
            className="inline-flex flex-wrap rounded-lg bg-surface-2 p-1"
          >
            {TABS.map((x, i) => (
              <button
                key={x}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`dec-tab-${x}`}
                aria-controls={`dec-panel-${x}`}
                aria-selected={tab === x}
                tabIndex={tab === x ? 0 : -1}
                onClick={() => patch("tab", x)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`px-3 py-1.5 rounded-md text-sm ${FOCUS} ${tab === x ? "bg-surface-4 text-gray-100" : "text-gray-400 hover:text-gray-200"}`}
              >
                {t(`decisions.tab${x[0]!.toUpperCase()}${x.slice(1)}`)}
                <span className="ml-1.5 text-xs tabular-nums text-gray-500">{counts[x]}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {error && (
        <div
          className="card p-5 text-sm text-red-400 flex flex-wrap items-center gap-3"
          role="alert"
        >
          <span>{t("decisions.loadError", { message: error })}</span>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className={`rounded-lg bg-surface-4 px-3 py-1.5 text-gray-100 hover:bg-surface-5 ${FOCUS}`}
          >
            {t("decisions.retry")}
          </button>
        </div>
      )}

      {project && !error && !data && (
        <p className="card p-5 text-sm text-gray-400 flex items-center gap-2" role="status">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          {t("decisions.loading")}
        </p>
      )}

      {project && data && (
        <div
          role="tabpanel"
          id={`dec-panel-${tab}`}
          aria-labelledby={`dec-tab-${tab}`}
          tabIndex={0}
          className={`space-y-3 ${FOCUS}`}
        >
          {body()}
        </div>
      )}
    </div>
  );
}
