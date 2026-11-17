/**
 * @file format.ts
 * @description Small formatters shared by the flow (akislar) screens.
 * @author Caglar Ulkuderner
 */

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Language-neutral clock: m:ss, or h:mm:ss from one hour on. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
