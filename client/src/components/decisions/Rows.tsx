/**
 * @file Rows.tsx
 * @description Row components of the Kararlar page: question rows (pending and answered), plan rows and the design file table.
 * @author Caglar Ulkuderner
 */

import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cockpit, formatDuration, type Decision, type DesignFile } from "../../lib/cockpit";
import { MarkdownContent } from "../conversation/MarkdownContent";

const TONE = {
  plain: "bg-surface-5 text-gray-300 ring-white/5",
  info: "bg-accent-muted text-indigo-200 ring-indigo-400/20",
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  bad: "bg-red-500/15 text-red-300 ring-red-400/30",
};

export function Chip({
  tone = "plain",
  children,
}: {
  tone?: keyof typeof TONE;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ring-1 ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded";

function useDate() {
  const { i18n } = useTranslation("cockpit");
  return (iso?: string) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })
      : "";
}

function SessionLink({ id }: { id: string }) {
  const { t } = useTranslation("cockpit");
  const short = id.slice(0, 8);
  return (
    <Link
      to={`/sessions/${id}`}
      aria-label={t("decisions.session", { id: short })}
      className={`font-mono text-accent hover:underline ${FOCUS}`}
    >
      {short}
    </Link>
  );
}

const answerText = (d: Decision) => [d.payload?.answer ?? []].flat().join(" ");

export function QuestionRow({ d }: { d: Decision }) {
  const { t } = useTranslation("cockpit");
  const date = useDate();
  const [all, setAll] = useState(false);
  const cancelled = d.status === "cancelled";
  const pending = d.status === "pending";
  const options = d.options ?? [];
  const shown = all ? options : options.slice(0, 4);
  const sel = new Set(d.selected);
  return (
    <li className={`px-4 py-4 space-y-2.5 ${cancelled ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {d.header && <Chip tone="info">{d.header}</Chip>}
        <span className="text-sm text-gray-100">{d.message}</span>
        {cancelled && <Chip tone="warn">{t("decisions.cancelled")}</Chip>}
        {pending && <Chip tone="info">{t("decisions.waitingChip")}</Chip>}
        {d.multiSelect && <Chip>{t("decisions.multi")}</Chip>}
      </div>
      {options.length > 0 && (
        <ul className="space-y-1.5">
          {shown.map((o) => {
            const on = sel.has(o.label);
            return (
              <li
                key={o.label}
                className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${on ? "bg-accent-muted ring-indigo-400/30 text-gray-100" : "ring-white/5 text-gray-400"}`}
              >
                <span className={on ? "font-medium" : ""}>
                  {on && <Check className="inline w-3.5 h-3.5 mr-1 text-accent" aria-hidden />}
                  {o.label}
                </span>
                {on && (
                  <span className="ml-2">
                    <Chip tone="info">{t("decisions.selected")}</Chip>
                  </span>
                )}
                {o.description && <div className="text-xs text-gray-500">{o.description}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {options.length > 4 && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className={`text-xs text-accent hover:underline ${FOCUS}`}
        >
          {t("decisions.moreOptions", { count: options.length - 4 })}
        </button>
      )}
      {d.other && (
        <blockquote className="border-l-2 border-accent pl-3 text-sm text-gray-200">
          <span className="block text-xs uppercase tracking-wider text-gray-500">
            {t("decisions.own")}
          </span>
          {answerText(d)}
        </blockquote>
      )}
      {d.payload?.note && (
        <p className="text-sm text-gray-300">
          <b>{t("decisions.note")}</b> {d.payload.note}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span>
          {pending
            ? t("decisions.waitingFor", {
                d: formatDuration(Date.now() - Date.parse(d.askedAt), t("h"), t("m")),
              })
            : date(d.askedAt)}
        </span>
        {d.sessionId && (
          <span>
            {t("decisions.session", { id: "" }).trim()} <SessionLink id={d.sessionId} />
          </span>
        )}
      </div>
    </li>
  );
}

export function PlanRow({ d }: { d: Decision }) {
  const { t } = useTranslation("cockpit");
  const date = useDate();
  const [open, setOpen] = useState(false);
  const plan = d.payload?.plan ?? "";
  const lines = plan.split("\n");
  const title = (lines.find((l) => /^#/.test(l)) ?? d.message).replace(/^#+\s*/, "");
  const lead = lines
    .filter((l) => l.trim() && !/^#/.test(l))
    .slice(0, 2)
    .join(" ");
  const ok = d.status === "resolved";
  return (
    <li className="px-4 py-4">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${title}. ${t("decisions.expandPlan")}`}
        onClick={() => setOpen(!open)}
        className={`block w-full text-left space-y-1 ${FOCUS}`}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          <Chip tone={ok ? "ok" : "bad"}>
            {t(ok ? "decisions.approved" : "decisions.rejected")}
          </Chip>
          <span className="text-xs text-gray-500">{date(d.askedAt)}</span>
        </span>
        <span className="block text-sm text-gray-400">{lead}</span>
      </button>
      {open && (
        <div className="mt-3 rounded-lg bg-surface-2 p-4">
          <MarkdownContent text={plan} />
        </div>
      )}
      {!ok && d.payload?.note && (
        <p className="mt-2 text-sm text-gray-300">
          <b>{t("decisions.rejectNote")}</b> {d.payload.note}
        </p>
      )}
    </li>
  );
}

const KIND_TONE = { spec: "info", taslak: "info", kanvas: "ok", gorsel: "warn" } as const;

export function DesignsTable({ project, designs }: { project: string; designs: DesignFile[] }) {
  const { t } = useTranslation("cockpit");
  const date = useDate();
  const [err, setErr] = useState<string | null>(null);
  const open = (path: string) =>
    cockpit
      .openDesign(project, path)
      .then(() => setErr(null))
      .catch((e: Error) => setErr(t("decisions.openFailed", { message: e.message })));
  return (
    <>
      {err && (
        <p className="px-4 py-2 text-sm text-red-400" role="alert">
          {err}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("decisions.colPath")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("decisions.colKind")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("decisions.colSession")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("decisions.colDate")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {designs.map((x) => (
            <tr key={x.path}>
              <td className="px-4 py-2.5 font-mono text-xs break-all">
                <span className={x.missing ? "line-through text-gray-500" : "text-gray-200"}>
                  {x.path}
                </span>{" "}
                {x.missing && <Chip tone="warn">{t("decisions.missing")}</Chip>}
              </td>
              <td className="px-4 py-2.5">
                <Chip tone={KIND_TONE[x.kind]}>{t(`decisions.kind_${x.kind}`)}</Chip>
                {(x.kind === "taslak" || x.kind === "kanvas") && !x.missing && (
                  <button
                    type="button"
                    onClick={() => open(x.path)}
                    aria-label={`${t("decisions.open")}: ${x.path}`}
                    className={`ml-2 text-xs text-accent hover:underline ${FOCUS}`}
                  >
                    {t("decisions.open")}
                  </button>
                )}
              </td>
              <td className="px-4 py-2.5">
                <SessionLink id={x.sessionId} />
              </td>
              <td className="px-4 py-2.5 text-xs text-gray-500">{date(x.writtenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
