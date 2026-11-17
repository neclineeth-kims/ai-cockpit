/**
 * @file FlowRun.tsx
 * @description AI Cockpit flow (akislar) run page: header with status, cost and time, the step strip with its back arrow, the step table (round, agent, cost, session, Log / Çıktı / Buradan başlat) and a side panel for run files. Polls every 3 seconds while the run is running.
 * @author Caglar Ulkuderner
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { cockpit, type FlowRun as Run, type FlowStepRow } from "../lib/cockpit";
import { Chip } from "../components/decisions/Rows";
import { FilePanel, type FilePanelState } from "../components/flows/FilePanel";
import { FlowStatusChip, type ChipStatus } from "../components/flows/FlowStatusChip";
import { StepStrip } from "../components/flows/StepStrip";
import { clock, usd } from "../components/flows/format";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const BTN = `rounded-lg bg-surface-4 px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-5 disabled:opacity-50 ${FOCUS}`;
const SMALL = `rounded-md bg-surface-4 px-2 py-1 text-xs text-gray-200 hover:bg-surface-5 disabled:opacity-50 ${FOCUS}`;
const POLL_MS = 3000;

// Round 1 of a step re-run later is kept as <name>.tur<N>.<ext> next to the newest output.
function outputPath(cikti: string, round: number, newest: boolean): string {
  if (newest) return cikti;
  const dot = cikti.lastIndexOf(".");
  const [name, ext] = dot > 0 ? [cikti.slice(0, dot), cikti.slice(dot)] : [cikti, ".md"];
  return `${name}.tur${round}${ext}`;
}

export default function FlowRun() {
  const { t } = useTranslation("cockpit");
  const { id = "" } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<FilePanelState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () =>
      cockpit
        .flow(id)
        .then((r) => {
          setRun(r.run);
          setErr(null);
        })
        .catch((e: Error) => setErr(t("flows.loadFailed", { message: e.message }))),
    [id, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const running = run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(t("flows.actionFailed", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const show = (title: string, read: Promise<string>) =>
    read
      .then((text) => setPanel({ title, text }))
      .catch((e: Error) =>
        setPanel({ title, text: t("flows.fileFailed", { message: e.message }) })
      );

  const openLog = (s: FlowStepRow) => {
    const rel = s.log_path?.split(".ai-cockpit/run/")[1] ?? `log/${s.step}-${s.round}.log`;
    return show(t("flows.logTitle", { step: s.step }), cockpit.flowFile(id, rel));
  };

  const openOutput = (s: FlowStepRow, cikti: string) => {
    const newest = !run!.steps.some((x) => x.step === s.step && x.round > s.round);
    return show(
      t("flows.outputTitle", { step: s.step }),
      cockpit.flowFile(id, outputPath(cikti, s.round, newest))
    );
  };

  if (!run)
    return (
      <p
        className={err ? "text-sm text-red-300" : "text-sm text-gray-400"}
        role={err ? "alert" : "status"}
      >
        {err ?? t("flows.loading")}
      </p>
    );

  const defs = new Map(run.flow.adimlar.map((d) => [d.id, d]));
  const started = Date.parse(run.started_at);
  const elapsed = (run.ended_at ? Date.parse(run.ended_at) : now) - started;
  const canRestart = run.status !== "running" && run.status !== "gate";
  const agentOf = (step: string) => {
    const d = defs.get(step);
    if (!d) return t("flows.humanGate");
    if (d.tur === "agent") return [d.ajan, d.model].filter(Boolean).join(" · ");
    return d.tur === "script" ? (d.komut ?? "") : t("flows.humanGate");
  };
  const rowTime = (s: FlowStepRow) =>
    s.started_at
      ? clock((s.ended_at ? Date.parse(s.ended_at) : now) - Date.parse(s.started_at))
      : "";

  return (
    <div className="space-y-5 animate-fade-in">
      <header className="card flex flex-wrap items-start gap-4 p-5">
        <div className="min-w-0 flex-1 space-y-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t("flows.runTitle")}
          </span>
          <h1 className="text-lg font-semibold text-gray-100">
            <span className="font-mono">{run.flow.ad}</span>
            {run.task && <span className="text-gray-400"> · {run.task}</span>}
          </h1>
          <p className="flex flex-wrap gap-x-4 font-mono text-xs text-gray-500">
            <span>{run.repo.split("/").pop()}</span>
            <span className="break-all">{run.cwd}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <FlowStatusChip status={run.status as ChipStatus} />
            <Chip>
              {run.cost_cap_usd != null
                ? t("flows.costCap", { cost: usd(run.cost_usd), cap: usd(run.cost_cap_usd) })
                : t("flows.cost", { cost: usd(run.cost_usd) })}
            </Chip>
            <Chip>{t("flows.elapsed", { d: clock(elapsed) })}</Chip>
          </div>
        </div>
        <div className="flex gap-2">
          {running && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => cockpit.stopFlow(id))}
              className={BTN}
            >
              {t("flows.stop")}
            </button>
          )}
          {(run.status === "failed" || run.status === "interrupted") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => cockpit.retryFlow(id))}
              className={`${BTN} !bg-accent !text-white hover:!bg-accent-hover`}
            >
              {t("flows.retry")}
            </button>
          )}
        </div>
      </header>

      {err && (
        <p role="alert" className="text-sm text-red-300">
          {err}
        </p>
      )}

      <StepStrip run={run} />

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-gray-500">
            <tr>
              {["step", "round", "status", "agent", "duration", "cost", "session", "actions"].map(
                (c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-medium">
                    {t(`flows.col.${c}`)}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {run.steps.map((s) => {
              const def = defs.get(s.step);
              return (
                <tr key={s.id}>
                  <td className="px-3 py-2">
                    <b className="font-mono text-gray-100">{s.step}</b>
                    {s.note && s.status === "failed" && (
                      <div className="text-xs text-red-300">{s.note}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-300">{s.round}</td>
                  <td className="px-3 py-2">
                    <FlowStatusChip status={s.status as ChipStatus} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">{agentOf(s.step)}</td>
                  <td className="px-3 py-2 tabular-nums text-gray-300">{rowTime(s)}</td>
                  <td className="px-3 py-2 tabular-nums text-gray-300">{usd(s.cost_usd)}</td>
                  <td className="px-3 py-2">
                    {s.session_id ? (
                      <Link
                        to={`/sessions/${s.session_id}`}
                        className={`font-mono text-accent hover:underline ${FOCUS}`}
                      >
                        {s.session_id.slice(0, 8)}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {s.log_path && (
                        <button
                          type="button"
                          aria-label={`${t("flows.log")} ${s.step}`}
                          onClick={() => void openLog(s)}
                          className={SMALL}
                        >
                          {t("flows.log")}
                        </button>
                      )}
                      {def?.cikti && (
                        <button
                          type="button"
                          aria-label={`${t("flows.output")} ${s.step}`}
                          onClick={() => void openOutput(s, def.cikti!)}
                          className={SMALL}
                        >
                          {t("flows.output")}
                        </button>
                      )}
                      {s.status === "done" && def && canRestart && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${t("flows.restartHere")} ${s.step}`}
                          onClick={() => act(() => cockpit.restartFlow(id, s.step))}
                          className={SMALL}
                        >
                          {t("flows.restartHere")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {panel && <FilePanel {...panel} onClose={() => setPanel(null)} />}
    </div>
  );
}
