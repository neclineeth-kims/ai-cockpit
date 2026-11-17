/**
 * @file GateCard.tsx
 * @description Card for a flow (akislar) gate in the Kararlar pending tab: flow approval with the step list, acceptance and other gates with shown files and "send back", round limit and cost cap with their own wording. An answer refetches the decisions.
 * @author Caglar Ulkuderner
 */

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { cockpit, formatDuration, type Decision } from "../../lib/cockpit";
import { Chip } from "../decisions/Rows";
import { FilePanel, type FilePanelState } from "./FilePanel";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const BTN = `rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `${BTN} bg-accent hover:bg-accent-hover font-medium text-white`;
const SECONDARY = `${BTN} bg-surface-4 text-gray-200 hover:bg-surface-5`;

// The server words these two gates itself; the message tells them apart.
const ROUND_LIMIT = "Tur sınırı aşıldı";
const COST_CAP = "Maliyet tavanı aşıldı";

export function GateCard({ d, onAnswered }: { d: Decision; onAnswered: () => void }) {
  const { t } = useTranslation("cockpit");
  const meta = d.metadata ?? {};
  const runId = meta.runId ?? "";
  const sendBack = meta.sendBack ?? [];
  const approval = meta.gate === "flow-approval";
  const kind = approval
    ? "approval"
    : d.message === ROUND_LIMIT
      ? "round"
      : d.message === COST_CAP
        ? "cost"
        : "gate";
  const [form, setForm] = useState(false);
  const [step, setStep] = useState(sendBack[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [panel, setPanel] = useState<FilePanelState | null>(null);

  const answer = async (body: Parameters<typeof cockpit.flowGate>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      await cockpit.flowGate(runId, body);
      onAnswered();
    } catch (e) {
      setErr(t("flows.gate.answerFailed", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const submitBack = (e: FormEvent) => {
    e.preventDefault();
    if (step && note.trim()) void answer({ action: "send_back", step, note: note.trim() });
  };

  const openFile = (name: string) =>
    cockpit
      .flowFile(runId, name)
      .then((text) => setPanel({ title: name, text }))
      .catch((e: Error) =>
        setPanel({ title: name, text: t("flows.fileFailed", { message: e.message }) })
      );

  const head =
    kind === "approval"
      ? t("flows.gate.approval")
      : kind === "round"
        ? t("flows.gate.roundLimit")
        : kind === "cost"
          ? t("flows.gate.costCap")
          : meta.step === "kabul"
            ? t("flows.gate.accept")
            : (meta.step ?? "");
  const tone = { approval: "info", round: "warn", cost: "bad", gate: "ok" }[kind] as
    | "info"
    | "warn"
    | "bad"
    | "ok";
  const lines = d.message.split("\n").filter((l) => l.startsWith("- "));
  const primary = {
    approval: t("flows.gate.approveStart"),
    round: t("flows.gate.continueAnyway"),
    cost: t("flows.gate.raiseCap"),
    gate: t("flows.gate.approve"),
  }[kind];

  return (
    <li className="space-y-3 px-4 py-4" aria-label={`${head} ${d.header ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={tone}>{head}</Chip>
        <h3 className="text-sm text-gray-100">
          <span className="font-mono">{d.header}</span>
          {d.project && <span className="text-gray-400"> · {d.project.split("/").pop()}</span>}
        </h3>
        <span className="ml-auto text-xs text-gray-500">
          {t("decisions.waitingFor", {
            d: formatDuration(Date.now() - Date.parse(d.askedAt), t("h"), t("m")),
          })}
        </span>
      </div>

      {kind === "approval" ? (
        <>
          <ol className="space-y-1">
            {lines.map((l) => (
              <li key={l} className="font-mono text-xs text-gray-300">
                {l.slice(2)}
              </li>
            ))}
          </ol>
          <p className="text-xs text-gray-500">{t("flows.gate.approvalNote")}</p>
        </>
      ) : (
        <p className="text-sm text-gray-300">{d.message}</p>
      )}

      {kind === "gate" && (meta.shown?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t("flows.gate.shownFiles")}
          </span>
          {meta.shown!.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void openFile(f)}
              className={`rounded-full bg-surface-5 px-2.5 py-0.5 font-mono text-xs text-gray-200 ring-1 ring-white/5 hover:bg-surface-4 ${FOCUS}`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void answer({ action: "approve" })}
          className={PRIMARY}
        >
          {primary}
        </button>
        {sendBack.length > 0 && (
          <button
            type="button"
            aria-expanded={form}
            onClick={() => setForm((v) => !v)}
            className={SECONDARY}
          >
            {t("flows.gate.sendBack")}
          </button>
        )}
      </div>

      {form && sendBack.length > 0 && (
        <form onSubmit={submitBack} className="space-y-2 rounded-lg bg-surface-2 p-3">
          <label className="block text-xs text-gray-400">
            {t("flows.gate.sendBackStep")}
            <select
              value={step}
              onChange={(e) => setStep(e.target.value)}
              className={`mt-1 block w-full rounded-md bg-surface-4 px-2 py-1.5 font-mono text-sm text-gray-100 ${FOCUS}`}
            >
              {sendBack.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-gray-400">
            {t("flows.gate.note")}
            <textarea
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("flows.gate.notePlaceholder")}
              className={`mt-1 block w-full rounded-md bg-surface-4 px-2 py-1.5 text-sm text-gray-100 ${FOCUS}`}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !note.trim()} className={PRIMARY}>
              {t("flows.gate.sendBack")}
            </button>
            <button type="button" onClick={() => setForm(false)} className={SECONDARY}>
              {t("flows.gate.cancel")}
            </button>
          </div>
        </form>
      )}

      {err && (
        <p role="alert" className="text-sm text-red-300">
          {err}
        </p>
      )}
      {panel && <FilePanel {...panel} onClose={() => setPanel(null)} />}
    </li>
  );
}
