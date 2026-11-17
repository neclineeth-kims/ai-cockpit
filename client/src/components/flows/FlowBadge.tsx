/**
 * @file FlowBadge.tsx
 * @description Flow badge on the right of a community task row: "Akışla başlat" with a template menu for my tasks without a run, otherwise the latest run's status linking to the run page.
 * @author Caglar Ulkuderner
 */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Workflow } from "lucide-react";
import { cockpit, type FlowRunSummary, type FlowTemplate } from "../../lib/cockpit";
import { announceAction } from "../../lib/appEvents";
import { Chip } from "../decisions/Rows";
import { FlowStatusChip } from "./FlowStatusChip";
import { usd } from "./format";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

function StartMenu({ task, onStarted }: { task: number; onStarted: () => void }) {
  const { t } = useTranslation("cockpit");
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<FlowTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => !v);
    if (!templates)
      cockpit
        .flowTemplates()
        .then((r) => setTemplates(r.templates))
        .catch((e: Error) => announceAction(t("flows.startFailed", { message: e.message })));
  };

  const start = async (flow: string) => {
    setBusy(true);
    try {
      const { run } = await cockpit.startFlow({ task, flow });
      setOpen(false);
      onStarted();
      navigate(`/flows/${run.id}`);
    } catch (e) {
      announceAction(t("flows.startFailed", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className={`inline-flex items-center gap-1.5 rounded-lg bg-accent hover:bg-accent-hover px-3 py-1.5 text-xs font-medium text-white ${FOCUS}`}
      >
        <Workflow className="h-3.5 w-3.5" aria-hidden />
        {t("flows.startWith")}
      </button>
      {open && (
        <ul
          aria-label={t("flows.templatesLabel")}
          className="card absolute right-0 z-20 mt-1 w-72 divide-y divide-border p-0 shadow-lg"
        >
          {templates?.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-400">{t("flows.noTemplates")}</li>
          )}
          {(templates ?? []).map((f) => (
            <li key={f.ad}>
              <button
                type="button"
                disabled={busy}
                onClick={() => start(f.ad)}
                className={`block w-full px-3 py-2 text-left hover:bg-surface-5 disabled:opacity-50 ${FOCUS}`}
              >
                <b className="font-mono text-sm text-gray-100">{f.ad}</b>
                {f.aciklama && <small className="block text-xs text-gray-400">{f.aciklama}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FlowBadge({
  task,
  mine,
  run,
  onStarted,
}: {
  task: number;
  mine: boolean;
  run?: FlowRunSummary;
  onStarted: () => void;
}) {
  const { t } = useTranslation("cockpit");
  if (!run) return mine ? <StartMenu task={task} onStarted={onStarted} /> : null;
  const gate = run.status === "gate";
  return (
    <Link
      to={`/flows/${run.id}`}
      aria-label={t("flows.openRun", { flow: run.flow })}
      className={`flex flex-wrap items-center gap-1.5 rounded ${FOCUS}`}
    >
      <FlowStatusChip
        status={run.status}
        label={
          gate
            ? t("flows.waitingDecision")
            : run.status === "running"
              ? `${run.flow} · ${run.current_step ?? ""}`
              : undefined
        }
      />
      {run.status === "done" && <Chip>{t("flows.total", { cost: usd(run.cost_usd) })}</Chip>}
    </Link>
  );
}
