/**
 * @file FlowBadge.test.tsx
 * @description Flow badge of the community task row: start menu for my tasks without a run, run badge linking to the run page, nothing for other people's tasks.
 * @author Caglar Ulkuderner
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import i18n from "i18next";

vi.mock("../../lib/cockpit", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cockpit: {
      flowTemplates: vi.fn(() =>
        Promise.resolve({
          templates: [{ ad: "ozellik", aciklama: "Netleştir, uygula.", adimlar: [] }],
        })
      ),
      startFlow: vi.fn(() => Promise.resolve({ run: { id: "r9" } })),
    },
  };
});

import { FlowBadge } from "../flows/FlowBadge";
import { cockpit, type FlowRunSummary } from "../../lib/cockpit";

const run = (o: Partial<FlowRunSummary>): FlowRunSummary => ({
  id: "r1",
  repo: "/p",
  cwd: "/p-wt",
  task: "#7",
  flow: "ozellik",
  status: "running",
  current_step: "uygula",
  cost_usd: 3.42,
  cost_cap_usd: 20,
  started_at: "2026-11-17T10:00:00Z",
  ended_at: null,
  ...o,
});

function renderBadge(props: Partial<Parameters<typeof FlowBadge>[0]> = {}) {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<FlowBadge task={7} mine onStarted={() => {}} {...props} />} />
        <Route path="/flows/:id" element={<p>koşu sayfası</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("tr");
});

describe("FlowBadge", () => {
  it("shows start menu for mine task and badge for existing run", async () => {
    renderBadge();
    fireEvent.click(screen.getByRole("button", { name: "Akışla başlat" }));
    fireEvent.click(await screen.findByRole("button", { name: /ozellik/ }));
    await waitFor(() =>
      expect(cockpit.startFlow).toHaveBeenCalledWith({ task: 7, flow: "ozellik" })
    );
    await screen.findByText("koşu sayfası");
  });

  it("links the latest run's badge to the run page", async () => {
    renderBadge({ run: run({ status: "done" }) });
    expect(screen.queryByRole("button", { name: "Akışla başlat" })).toBeNull();
    expect(screen.getByText("Bitti")).toBeTruthy();
    expect(screen.getByText("Toplam $3.42")).toBeTruthy();
    fireEvent.click(screen.getByRole("link"));
    await screen.findByText("koşu sayfası");
  });

  it("says a gate waits for a decision", () => {
    renderBadge({ run: run({ status: "gate" }) });
    expect(screen.getByText("Kararını bekliyor")).toBeTruthy();
  });

  it("renders nothing for a task that is not mine and has no run", () => {
    renderBadge({ mine: false });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
