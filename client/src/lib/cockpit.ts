/**
 * @file cockpit.ts
 * @description AI Cockpit REST client: plan view (`server/routes/plan.js`) and usage limits (`/api/limits`).
 * @author Caglar Ulkuderner
 */

import { dashboardToken, request } from "./api";

export type TaskStatus = "todo" | "running" | "done" | "blocked";

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  running: string[];
  spent_ms: number;
  remaining_ms: number | null;
  started_at: string | null;
  done_at?: string | null;
}

export interface DecisionOption {
  label: string;
  description?: string;
}

/** One agent question (input_required) or plan approval (plan_approval) read from a transcript. */
export interface Decision {
  id: string;
  sessionId: string;
  project: string;
  agent: string;
  reason: "input_required" | "plan_approval" | "confirmation";
  header?: string;
  message: string;
  options?: DecisionOption[];
  multiSelect?: boolean;
  askedAt: string;
  status: "pending" | "resolved" | "cancelled";
  selected: string[];
  other: boolean;
  payload?: { answer?: string | string[]; note?: string; plan?: string };
  resolvedAt?: string;
  /** Set on flow (akislar) gates: `kind` is "gate", `gate` "flow-approval" for the start approval. */
  metadata?: {
    kind?: string;
    gate?: string;
    runId?: string;
    step?: string;
    shown?: string[];
    sendBack?: string[];
  };
}

export type FlowStatus = "running" | "gate" | "done" | "failed" | "stopped" | "interrupted";

export interface FlowStepDef {
  id: string;
  tur: "agent" | "script" | "gate";
  ajan?: string;
  model?: string;
  komut?: string;
  cikti?: string;
  basarisizsa?: string;
  mesaj?: string;
}

export interface FlowStepRow {
  id: number;
  run_id: string;
  step: string;
  round: number;
  status: "running" | "gate" | "done" | "failed" | "interrupted" | "stopped";
  exit_code: number | null;
  session_id: string | null;
  log_path: string | null;
  note: string | null;
  cost_usd: number;
  started_at: string | null;
  ended_at: string | null;
}

/** A run as the list returns it (`flow` is the flow name). */
export interface FlowRunSummary {
  id: string;
  repo: string;
  cwd: string;
  task: string | null;
  flow: string;
  status: FlowStatus;
  current_step: string | null;
  cost_usd: number;
  cost_cap_usd: number | null;
  started_at: string;
  ended_at: string | null;
}

/** One run with its parsed flow and every step row. */
export interface FlowRun extends Omit<FlowRunSummary, "flow"> {
  flow: { ad: string; maliyet_tavani?: number; adimlar: FlowStepDef[] };
  steps: FlowStepRow[];
}

export interface FlowTemplate {
  ad: string;
  aciklama?: string;
  adimlar: Array<{ id: string; tur: string }>;
}

export interface DesignFile {
  path: string;
  kind: "spec" | "taslak" | "kanvas" | "gorsel";
  sessionId: string;
  writtenAt: string;
  missing: boolean;
}

export interface DecisionProject {
  root: string;
  name: string;
  lastAt: string | null;
}

const qs = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(o).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]]))
  ).toString();

/** Authenticated GET of a raw file (the token goes in a header, never in a URL). */
async function fetchBlob(path: string): Promise<Blob> {
  const token = dashboardToken();
  const res = await fetch(`/api${path}`, token ? { headers: { "x-dashboard-token": token } } : {});
  if (res.status === 401) window.dispatchEvent(new Event("cockpit:unauthorized"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export interface Plan {
  id: string;
  name: string;
  file: string;
  /** Found in a repo agents work in, not configured by hand. */
  discovered?: boolean;
  error?: string;
  /** A live session works in the plan's repo. */
  active?: boolean;
  active_sessions?: string[];
  /** Last line of the plan's SDD progress ledger. */
  last_step?: string | null;
  phases: Array<{ title: string; tasks: PlanTask[] }>;
  queue: string[];
  typical_task_ms: number | null;
  totals?: {
    tasks: number;
    done: number;
    running: number;
    blocked: number;
    remaining_ms: number | null;
    done_spent_ms?: number;
    estimate_basis?: "agent" | "plan" | "calendar" | null;
    pace_ms?: number | null;
    started_basis?: "sessions" | "git" | null;
    started_at?: string | null;
  };
}

export interface LimitWindow {
  used_percent: number;
  resets_at: number;
}

export interface ProviderLimits {
  five_hour: LimitWindow | null;
  seven_day: LimitWindow | null;
  updated_at?: string | number | null;
}

export interface LimitsPayload {
  claude: ProviderLimits | null;
  codex: ProviderLimits | null;
}

export interface TelemetryTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  cost: number;
  no_cache_cost: number;
  cache_hit: number | null;
  /** null when the model has no rate card, so savings are unknown. */
  saved: number | null;
}

export interface TelemetryPayload {
  sample_ms: number;
  window_started_at: number;
  all_time: TelemetryTotals;
  window: TelemetryTotals;
  series: Array<TelemetryTotals & { t: number }>;
  models: Array<{
    provider: string;
    model: string;
    all_time: TelemetryTotals;
    window: TelemetryTotals;
  }>;
}

export interface CommunityTask {
  number: number;
  title: string;
  url: string | null;
  body: string;
  assignees: string[];
  /** "Alan:" patterns from the issue body; empty for legacy issues without fields. */
  area: string[];
  /** "Bağlı:" dependency issue numbers from the issue body. */
  deps: number[];
  /** "Kabul:" acceptance criteria lines from the issue body. */
  acceptance: string[];
  estimate_ms: number | null;
  branch: string;
  state: "open" | "mine" | "taken" | "review";
  claimed_at: string | null;
  updated_at: string | null;
  /** Open dependencies that must finish before this task can be claimed. */
  blocked_by: number[];
  /** Tasks currently being worked on whose area overlaps this one's. */
  conflicts_with: number[];
  /** Open, unblocked and free of area clashes. */
  ready: boolean;
  /** Claimed, no live agent session and idle past the configured threshold. */
  stale: boolean;
  last_activity_at: string | null;
  /** Uncommitted changes in the task worktree (Worktrunk path only). */
  dirty?: boolean;
  pr: {
    number: number;
    url: string | null;
    author: string | null;
    created_at: string | null;
    draft: boolean;
    review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  } | null;
}

export interface CommunityBoard {
  provider: CommunityProvider;
  review_name: string;
  me: string;
  tasks: CommunityTask[];
  done: Array<{ number: number; title: string; url: string | null; at: string; by: string[] }>;
  progress: { done: number; total: number; ratio: number | null };
  totals: {
    open: number;
    mine: number;
    taken: number;
    review: number;
    ready: number;
    open_estimate_ms: number;
    open_unestimated: number;
  };
}

export type CommunityProvider = "github" | "gitlab" | "local";

export interface CommunityConfig {
  provider: CommunityProvider;
  localPath: string;
  repo?: string;
  label?: string;
  host?: string;
  planFile?: string;
  /** Hours before a claimed task with no activity counts as stale (1-168, default 4). */
  staleHours?: number;
  /** "auto": use Worktrunk for task worktrees when installed; "off": plain git. */
  worktrunk?: "auto" | "off";
  /** Run repository Worktrunk hooks when opening worktrees (opt-in, untrusted by default). */
  worktrunkHooks?: boolean;
}

/** Plan-sync preview: unmarked plan tasks to open, marked ones to refresh. */
export interface CommunityPlanSyncPreview {
  create: Array<{ id: string; title: string }>;
  update: Array<{ id: string; title: string; number: number }>;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const cockpit = {
  /** `unplanned`: repos with a live session where no plan file was found on its own. */
  plans: () =>
    request<{ plans: Plan[]; unplanned?: Array<{ root: string; name: string }> }>("/plan"),
  savePlans: (plans: Array<{ id?: string; name?: string; file: string }>) =>
    request<{ plans: Plan[] }>("/plan/config", { method: "PUT", ...json({ plans }) }),
  setStatus: (planId: string, taskId: string, status: "todo" | "done" | "blocked") =>
    request(`/plan/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      ...json({ status }),
    }),
  setOrder: (planId: string, order: string[]) =>
    request(`/plan/${encodeURIComponent(planId)}/order`, { method: "PUT", ...json({ order }) }),
  limits: () => request<LimitsPayload>("/limits"),
  telemetry: () => request<TelemetryPayload>("/telemetry"),
  communityConfig: () => request<CommunityConfig | null>("/community/config"),
  communitySave: (cfg: CommunityConfig) =>
    request<CommunityConfig>("/community/config", { method: "PUT", ...json(cfg) }),
  communityMembers: () =>
    request<{
      provider: CommunityProvider;
      members: Array<{
        login: string;
        name?: string;
        role: string | null;
        url: string | null;
        commits?: number;
      }>;
    }>("/community/members"),
  communityDirs: (path?: string) =>
    request<{
      path: string;
      parent: string | null;
      git: boolean;
      dirs: Array<{ name: string; path: string; git: boolean }>;
    }>(`/community/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  communityBoard: () => request<CommunityBoard>("/community/board"),
  communityClaim: (n: number) =>
    request<{ number: number; branch: string; cwd: string; prompt: string }>(
      `/community/tasks/${n}/claim`,
      { method: "POST" }
    ),
  communityRelease: (n: number, note: string) =>
    request<{ ok: boolean; comment: string }>(`/community/tasks/${n}/release`, {
      method: "POST",
      ...json({ note }),
    }),
  communityReleasePreview: (n: number, note: string) =>
    request<{ comment: string }>(`/community/tasks/${n}/release/preview`, {
      method: "POST",
      ...json({ note }),
    }),
  communityPlanSyncPreview: () => request<CommunityPlanSyncPreview>("/community/plan-sync"),
  communityPlanSync: () =>
    request<{ created: number[]; updated: number[]; skipped: number[] }>("/community/plan-sync", {
      method: "POST",
    }),
  communityPrPreview: (n: number) =>
    request<{
      branch: string;
      title: string;
      body: string;
      commands: string[][];
      commits: string[];
    }>(`/community/tasks/${n}/pr`),
  flows: (a: { repo?: string; task?: number } = {}) =>
    request<{ runs: FlowRunSummary[] }>(`/flows?${qs(a)}`),
  flow: (id: string) => request<{ run: FlowRun }>(`/flows/${id}`),
  startFlow: (a: { task: number; flow: string }) =>
    request<{ run: FlowRun }>("/flows", { method: "POST", ...json(a) }),
  flowGate: (id: string, body: { action: "approve" | "send_back"; step?: string; note?: string }) =>
    request<{ run: FlowRun }>(`/flows/${id}/gate`, { method: "POST", ...json(body) }),
  retryFlow: (id: string) => request<{ run: FlowRun }>(`/flows/${id}/retry`, { method: "POST" }),
  restartFlow: (id: string, step: string) =>
    request<{ run: FlowRun }>(`/flows/${id}/restart`, { method: "POST", ...json({ step }) }),
  stopFlow: (id: string) => request<{ run: FlowRun }>(`/flows/${id}/stop`, { method: "POST" }),
  /** Run files are plain text, so this reads the body as text (request() would parse JSON). */
  flowFile: async (id: string, path: string) =>
    (await fetchBlob(`/flows/${id}/file?${qs({ path })}`)).text(),
  flowTemplates: () => request<{ templates: FlowTemplate[] }>("/flows/templates"),
  installFlows: () =>
    request<{ copied: string[]; skipped: string[] }>("/flows/install", {
      method: "POST",
      ...json({ repo: true }),
    }),
  decisionProjects: () => request<{ projects: DecisionProject[] }>("/decisions/projects"),
  decisions: (a: { project: string; status?: string; q?: string; limit?: number }) =>
    request<{ decisions: Decision[]; pending: number }>(`/decisions?${qs(a)}`),
  designs: (project: string) =>
    request<{ designs: DesignFile[] }>(`/decisions/designs?${qs({ project })}`),
  /** Relative URL only: the API may need a token header, so open files with {@link openDesign}. */
  designFileUrl: (project: string, path: string) =>
    `/api/decisions/designs/file?${qs({ project, path })}`,
  /** Fetches the file with auth and shows it in a new tab inside a sandboxed iframe (no app origin). */
  openDesign: async (project: string, path: string) => {
    // Open before the fetch: after an await the click no longer counts and the popup is blocked.
    const w = window.open("about:blank", "_blank");
    if (!w) throw new Error("popup blocked");
    let blob: Blob;
    try {
      blob = await fetchBlob(`/decisions/designs/file?${qs({ project, path })}`);
    } catch (e) {
      w.close();
      throw e;
    }
    const frame = w.document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "border:0;width:100%;height:100vh";
    if (blob.type.startsWith("image/")) frame.src = URL.createObjectURL(blob);
    else frame.srcdoc = await blob.text();
    w.document.body.style.margin = "0";
    w.document.body.append(frame);
  },
  /** Downloads the export through fetch (auth header) and a blob link. */
  exportDecisions: async (project: string, format: "ag-ui" | "json") => {
    const blob = await fetchBlob(`/decisions/export?${qs({ project, format })}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kararlar-${project.split("/").pop()}-${format}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000); // revoking at once can cancel the download
  },
  communityOpenPr: (n: number) =>
    request<{ url: string }>(`/community/tasks/${n}/pr`, { method: "POST" }),
};

/** "3 sa 20 dk" style duration; null → "—". */
export function formatDuration(ms: number | null, h: string, m: string): string {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} ${m}`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hrs} ${h} ${rest} ${m}` : `${hrs} ${h}`;
}
