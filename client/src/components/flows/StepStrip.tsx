/**
 * @file StepStrip.tsx
 * @description Step strip of a flow run: one node per step with its latest status and round, and an arrow under the nodes for each step that can send the flow back to an earlier one.
 * @author Caglar Ulkuderner
 */

import { useTranslation } from "react-i18next";
import type { FlowRun } from "../../lib/cockpit";
import { Chip } from "../decisions/Rows";
import { FlowStatusChip, type ChipStatus } from "./FlowStatusChip";

const NODE_W = 160;
// The verdict word the reviewer writes on the first line when the work must be redone.
const BACK_LABEL = "DÜZELT";

export function StepStrip({ run }: { run: FlowRun }) {
  const { t } = useTranslation("cockpit");
  const defs = run.flow.adimlar;
  const latest = new Map(run.steps.map((s) => [s.step, s]));
  const cx = (i: number) => NODE_W / 2 + NODE_W * i;
  const edges = defs.flatMap((d, i) => {
    const to = d.basarisizsa ? defs.findIndex((x) => x.id === d.basarisizsa) : -1;
    return to >= 0 && to < i ? [{ from: i, to, fromId: d.id, toId: d.basarisizsa! }] : [];
  });

  return (
    <div
      className="card overflow-x-auto p-4"
      role="region"
      aria-label={t("flows.stripLabel")}
      tabIndex={0}
    >
      <div style={{ width: NODE_W * defs.length }}>
        <ol aria-label={t("flows.stepsLabel")} className="flex">
          {defs.map((d) => {
            const row = latest.get(d.id);
            return (
              <li
                key={d.id}
                style={{ width: NODE_W }}
                className="flex flex-col items-center gap-1.5 px-1"
              >
                <span className="font-mono text-sm text-gray-100">{d.id}</span>
                <FlowStatusChip status={(row?.status ?? "pending") as ChipStatus} />
                {row && row.round > 1 && <Chip>{t("flows.round", { n: row.round })}</Chip>}
              </li>
            );
          })}
        </ol>
        {edges.map((e) => (
          <svg
            key={e.fromId}
            width={NODE_W * defs.length}
            height={40}
            role="img"
            aria-label={t("flows.backEdge", { from: e.fromId, to: e.toId })}
            className="text-accent"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d={`M${cx(e.from)} 2 C${cx(e.from)} 36 ${cx(e.to)} 36 ${cx(e.to)} 8`} />
            <path d={`M${cx(e.to) - 4} 14 L${cx(e.to)} 6 L${cx(e.to) + 4} 14`} />
            <text
              x={(cx(e.from) + cx(e.to)) / 2}
              y={34}
              textAnchor="middle"
              fill="currentColor"
              stroke="none"
              fontSize={11}
            >
              {BACK_LABEL}
            </text>
          </svg>
        ))}
      </div>
    </div>
  );
}
