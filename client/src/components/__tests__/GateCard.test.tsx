/**
 * @file GateCard.test.tsx
 * @description Flow gate card in Kararlar: approval lists the steps, send back needs a step from the allowed list and sends the note, shown files open the side panel, round limit and cost cap use their own wording.
 * @author Caglar Ulkuderner
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "i18next";

vi.mock("../../lib/cockpit", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cockpit: {
      flowGate: vi.fn(() => Promise.resolve({ run: {} })),
      flowFile: vi.fn(() => Promise.resolve("plan metni")),
    },
  };
});

import { GateCard } from "../flows/GateCard";
import { cockpit, type Decision } from "../../lib/cockpit";

const gate = (
  o: Partial<Decision> & { metadata: NonNullable<Decision["metadata"]> }
): Decision => ({
  id: "flow:r1:kabul:1",
  sessionId: "",
  project: "/p/app",
  agent: "cockpit",
  reason: "confirmation",
  header: "ozellik",
  message: "Özellik hazır, kabul ediyor musun?",
  options: [],
  multiSelect: false,
  askedAt: new Date().toISOString(),
  status: "pending",
  selected: [],
  other: false,
  ...o,
});
const wrap = (d: Decision, onAnswered = vi.fn()) =>
  render(
    <ul>
      <GateCard d={d} onAnswered={onAnswered} />
    </ul>
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("tr");
});

describe("GateCard", () => {
  it("approval lists steps and calls flowGate approve", async () => {
    const onAnswered = vi.fn();
    wrap(
      gate({
        message:
          'Akış onayı: ozellik\n- netlestir (agent) claude "sonnet"\n- test (script) komut: "npm test"',
        metadata: {
          kind: "gate",
          runId: "r1",
          step: "akis-onayi",
          gate: "flow-approval",
          shown: [],
          sendBack: [],
        },
      }),
      onAnswered
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/netlestir \(agent\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Geri gönder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Onayla ve başlat" }));
    await waitFor(() => expect(cockpit.flowGate).toHaveBeenCalledWith("r1", { action: "approve" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it("send back requires a step from sendBack and sends the note", async () => {
    wrap(
      gate({
        metadata: {
          kind: "gate",
          runId: "r1",
          step: "kabul",
          shown: ["plan.md"],
          sendBack: ["uygula", "netlestir"],
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Geri gönder" }));
    const select = screen.getByLabelText("Geri gönderilecek adım") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["uygula", "netlestir"]);
    fireEvent.change(select, { target: { value: "netlestir" } });
    const submit = screen.getAllByRole("button", { name: "Geri gönder" }).slice(-1)[0]!;
    expect((submit as HTMLButtonElement).disabled).toBe(true); // note is required
    fireEvent.change(screen.getByLabelText("Not"), { target: { value: "testleri düzelt" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(cockpit.flowGate).toHaveBeenCalledWith("r1", {
        action: "send_back",
        step: "netlestir",
        note: "testleri düzelt",
      })
    );
  });

  it("hides send back when the gate allows none", () => {
    wrap(gate({ metadata: { kind: "gate", runId: "r1", step: "kabul", shown: [], sendBack: [] } }));
    expect(screen.queryByRole("button", { name: "Geri gönder" })).toBeNull();
  });

  it("shown file chip opens the file in a side panel", async () => {
    wrap(
      gate({
        metadata: { kind: "gate", runId: "r1", step: "kabul", shown: ["plan.md"], sendBack: [] },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "plan.md" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("plan metni");
    expect(cockpit.flowFile).toHaveBeenCalledWith("r1", "plan.md");
  });

  it("round limit and cost cap use their own wording", () => {
    const { unmount } = wrap(
      gate({
        message: "Tur sınırı aşıldı",
        metadata: { kind: "gate", runId: "r1", step: "incele", shown: [], sendBack: ["uygula"] },
      })
    );
    expect(screen.getByRole("button", { name: "Yine de devam et" })).toBeTruthy();
    unmount();
    wrap(
      gate({
        message: "Maliyet tavanı aşıldı",
        metadata: { kind: "gate", runId: "r1", step: "uygula", shown: [], sendBack: [] },
      })
    );
    expect(screen.getByRole("button", { name: "Tavanı artır ve devam et" })).toBeTruthy();
  });
});
