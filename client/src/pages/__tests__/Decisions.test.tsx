/**
 * @file Decisions.test.tsx
 * @description Kararlar page: tabs, selected options, own answers, status chips, in-memory search, pending wait time, plan expansion, struck-through missing designs and arrow-key tab switching.
 * @author Caglar Ulkuderner
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import i18n from "i18next";

const SID = "a1b2c3d4-0000-4000-8000-000000000001";
const base = { sessionId: SID, project: "/p/app", agent: "claude", reason: "input_required" };
const decisions = [
  {
    ...base,
    id: "d1",
    header: "Model",
    message: "Hangi model?",
    options: [
      { label: "alfa", description: "ilk seçenek" },
      { label: "beta", description: "ikinci" },
    ],
    status: "resolved",
    selected: ["beta"],
    other: false,
    payload: { answer: "beta", note: "ucuz diye" },
    askedAt: "2026-11-05T13:31:00.000Z",
  },
  {
    ...base,
    id: "d2",
    header: "Klasör",
    message: "Hangi klasör?",
    options: [{ label: "x" }, { label: "y" }],
    status: "resolved",
    selected: [],
    other: true,
    payload: { answer: "kendi klasörüm" },
    askedAt: "2026-11-04T10:00:00.000Z",
  },
  {
    ...base,
    id: "d3",
    header: "Bildirim",
    message: "Bildirim gösterilsin mi?",
    options: [{ label: "Evet" }, { label: "Hayır" }],
    status: "cancelled",
    selected: [],
    other: false,
    askedAt: "2026-11-03T10:00:00.000Z",
  },
  {
    ...base,
    id: "d4",
    header: "Sıra",
    message: "Hangi sırayla?",
    options: [{ label: "Yeni" }],
    status: "pending",
    selected: [],
    other: false,
    askedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  },
  {
    ...base,
    id: "p1",
    reason: "plan_approval",
    message: "Plan",
    status: "cancelled",
    selected: [],
    other: false,
    payload: {
      plan: "# Kuyruk planı\nİlk satır.\nİkinci satır.\nÜçüncü satır.\n\n## Adımlar\n- tablo",
      note: "Gereksiz.",
    },
    askedAt: "2026-11-12T09:30:00.000Z",
  },
];
const designs = [
  {
    path: "docs/a.md",
    kind: "spec",
    sessionId: SID,
    writtenAt: "2026-11-02T10:00:00Z",
    missing: false,
  },
  {
    path: "docs/old.html",
    kind: "taslak",
    sessionId: SID,
    writtenAt: "2026-11-01T10:00:00Z",
    missing: true,
  },
];

vi.mock("../../lib/cockpit", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cockpit: {
      decisionProjects: vi.fn(() =>
        Promise.resolve({ projects: [{ root: "/p/app", name: "app", lastAt: null }] })
      ),
      decisions: vi.fn(() => Promise.resolve({ decisions, pending: 1 })),
      designs: vi.fn(() => Promise.resolve({ designs })),
      openDesign: vi.fn(() => Promise.resolve()),
      exportDecisions: vi.fn(() => Promise.resolve()),
    },
  };
});

import Decisions from "../Decisions";
import { cockpit } from "../../lib/cockpit";

async function renderAt(url = "/decisions") {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Decisions />
    </MemoryRouter>
  );
  await screen.findByRole("tabpanel");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("tr");
});

describe("Decisions page", () => {
  it("renders decisions tab by default with selected option marked", async () => {
    await renderAt();
    expect(screen.getByRole("tab", { name: /Kararlar/ })).toHaveAttribute("aria-selected", "true");
    const row = screen.getByText("Hangi model?").closest("li")!;
    const chosen = within(row).getByText("beta").closest("li")!;
    expect(within(chosen).getByText("Seçildi")).toBeInTheDocument();
    expect(within(row).getByText("alfa").closest("li")).not.toHaveTextContent("Seçildi");
    expect(within(row).getByText(/ucuz diye/)).toBeInTheDocument();
    expect(cockpit.decisions).toHaveBeenCalledTimes(1);
  });

  it("other answer shows Kendi cevabı block", async () => {
    await renderAt();
    const row = screen.getByText("Hangi klasör?").closest("li")!;
    expect(within(row).getByText("Kendi cevabı")).toBeInTheDocument();
    expect(within(row).getByText(/kendi klasörüm/)).toBeInTheDocument();
  });

  it("status chip Terk edildi filters to cancelled", async () => {
    await renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Terk edildi" }));
    expect(screen.getByText("Bildirim gösterilsin mi?")).toBeInTheDocument();
    expect(screen.queryByText("Hangi model?")).toBeNull();
  });

  it("search filters across tabs and shows search-empty message", async () => {
    await renderAt();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "KUYRUK" } });
    expect(screen.getByRole("tab", { name: /Planlar/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Kararlar/ })).toHaveTextContent("0");
    expect(screen.getByText(/Aramaya uyan kayıt yok/)).toBeInTheDocument();
    expect(cockpit.decisions).toHaveBeenCalledTimes(1); // no refetch per keystroke
  });

  it("pending tab from ?tab=pending lists pending with waiting time", async () => {
    await renderAt("/decisions?tab=pending");
    expect(screen.getByText("Hangi sırayla?")).toBeInTheDocument();
    expect(screen.getByText(/Bekliyor: 4 dk/)).toBeInTheDocument();
    expect(screen.getByText(/kokpitten cevaplanamaz/)).toBeInTheDocument();
  });

  it("plans row expands to full plan and shows rejection note", async () => {
    await renderAt("/decisions?tab=plans");
    expect(screen.getByText(/Reddedildi/)).toBeInTheDocument();
    expect(screen.getByText(/Gereksiz\./)).toBeInTheDocument();
    expect(screen.queryByText("Adımlar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Kuyruk planı/ }));
    expect(screen.getByText("Adımlar")).toBeInTheDocument();
  });

  it("designs tab strikes missing files", async () => {
    await renderAt("/decisions?tab=designs");
    const gone = screen.getByText("docs/old.html");
    expect(gone.className).toContain("line-through");
    expect(screen.getByText("silinmiş")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aç/ })).toBeNull(); // missing: no open button
    expect(screen.getByText("docs/a.md").className).not.toContain("line-through");
  });

  it("arrow keys move between tabs", async () => {
    await renderAt();
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    await waitFor(() => expect(tabs[2]).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "End" });
    await waitFor(() => expect(tabs[3]).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(tabs[3]);
  });

  it("shows an error with retry", async () => {
    vi.mocked(cockpit.decisions).mockRejectedValueOnce(new Error("boom"));
    render(
      <MemoryRouter initialEntries={["/decisions"]}>
        <Decisions />
      </MemoryRouter>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByRole("tabpanel")).toBeInTheDocument();
  });
});
