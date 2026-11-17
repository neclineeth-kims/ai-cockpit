/**
 * @file FlowStatusChip.tsx
 * @description Status chip of flow runs and steps: an icon plus a word, so status is never shown by color alone.
 * @author Caglar Ulkuderner
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Circle, Loader2, Pause, Square, X } from "lucide-react";
import { Chip } from "../decisions/Rows";

const LOOK = {
  running: ["info", Loader2],
  gate: ["warn", Pause],
  done: ["ok", Check],
  failed: ["bad", X],
  stopped: ["plain", Square],
  interrupted: ["warn", AlertTriangle],
  pending: ["plain", Circle],
} as const;

export type ChipStatus = keyof typeof LOOK;

export function FlowStatusChip({ status, label }: { status: ChipStatus; label?: string }) {
  const { t } = useTranslation("cockpit");
  const [tone, Icon] = LOOK[status] ?? LOOK.pending;
  return (
    <Chip tone={tone}>
      <Icon
        className={`mr-1 h-3 w-3 ${status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
        aria-hidden
      />
      {label ?? t(`flows.status.${status}`)}
    </Chip>
  );
}
