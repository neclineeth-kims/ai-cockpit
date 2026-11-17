/**
 * @file FlowRun.test.tsx
 * @description Flow run page: steps, rounds and the back arrow, polling while running, the Log side panel, and which action buttons show per status.
 * @author Caglar Ulkuderner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import i18n from "i18next";

const step = (o: Record<string, unknown>) => ({
  id: 1,
  run_id: "r1",
  step: "uygula",
  round: 1,
  status: "done",
  exit_code: 0,
  session_id: null,
  log_path: null,
  note: null,
  cost_usd: 0.5,
  started_at: "2026-11-17T10:00:00.000Z",
  ended_at: "2026-11-17T10:03:00.000Z",
  ...o,
});
const base = {
  id: "r1",
  repo: "/p/app",
  cwd: "/p/app-wt/x",
  task: "#7",
  status: "running",
  current_step: "incele",
  cost_usd: 1.5,
  cost_cap_usd: 20,
  started_at: "2026-11-17T10:00:00.000Z",
  ended_at: null,
  flow: {
    ad: "ozellik",
    adimlar: [
      { id: "uygula", tur: "agent", ajan: "opencode", model: "glm-5.3", cikti: "u.md" },
      { id: "incele", tur: "agent", ajan: "claude", model: "opus", basarisizsa: "uygula" },
    ],
  },
  steps: [
    step({
      id: 1,
      step: "uygula",
      round: 1,
      log_path: "/p/app-wt/x/.ai-cockpit/run/log/uygula-1.log",
    }),
    step({ id: 2, step: "incele", round: 1, status: "done" }),
    step({ id: 3, step: "uygula", round: 2, status: "running", ended_at: null }),
  ],
};
let current: Record<string, unknown> = base;

vi.mock("../../lib/cockpit", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cockpit: {
      flow: vi.fn(() => Promise.resolve({ run: current })),
      flowFile: vi.fn(() => Promise.resolve("log satiri bir")),
      stopFlow: vi.fn(() => Promise.resolve({ run: current })),
      retryFlow: vi.fn(() => Promise.resolve({ run: current })),
      restartFlow: vi.fn(() => Promise.resolve({ run: current })),
    },
  };
});

import FlowRun from "../FlowRun";
import { cockpit } from "../../lib/cockpit";

async function renderRun() {
  render(
    <MemoryRouter initialEntries={["/flows/r1"]}>
      <Routes>
        <Route path="flows/:id" element={<FlowRun />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole("heading", { level: 1 });
}

beforeEach(async () => {
  vi.clearAllMocks();
  current = base;
  await i18n.changeLanguage("tr");
});
afterEach(() => vi.useRealTimers());

describe("FlowRun page", () => {
  it("renders steps, rounds and back-edge, and polls while running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderRun();
    expect(screen.getByText("tur 2")).toBeTruthy();
    expect(screen.getByRole("img", { name: /uygula.*DÜZELT|DÜZELT.*uygula/ })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4); // header + 3 step rows
    const calls = vi.mocked(cockpit.flow).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(vi.mocked(cockpit.flow).mock.calls.length).toBeGreaterThan(calls);
  });

  it("does not poll once the run is no longer running", async () => {
    current = { ...base, status: "done", ended_at: "2026-11-17T10:30:00.000Z" };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderRun();
    const calls = vi.mocked(cockpit.flow).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(vi.mocked(cockpit.flow).mock.calls.length).toBe(calls);
  });

  it("log button opens side panel with file text", async () => {
    await renderRun();
    fireEvent.click(screen.getByRole("button", { name: /Log uygula/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("log satiri bir");
    expect(cockpit.flowFile).toHaveBeenCalledWith("r1", "log/uygula-1.log");
    fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retry shows only when failed; stop only when running", async () => {
    await renderRun();
    expect(screen.getByRole("button", { name: "Durdur" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yeniden dene" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Durdur" }));
    expect(cockpit.stopFlow).toHaveBeenCalledWith("r1");
  });

  it("failed run offers retry and restart-here, not stop", async () => {
    current = {
      ...base,
      status: "failed",
      ended_at: "2026-11-17T10:30:00.000Z",
      steps: [
        base.steps[0],
        step({ id: 2, step: "incele", status: "failed", note: "Ajan 1 koduyla çıktı" }),
      ],
    };
    await renderRun();
    expect(screen.queryByRole("button", { name: "Durdur" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Buradan başlat uygula/ }));
    expect(cockpit.restartFlow).toHaveBeenCalledWith("r1", "uygula");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Yeniden dene" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(cockpit.retryFlow).toHaveBeenCalledWith("r1");
  });
});
