/**
 * @file FilePanel.tsx
 * @description Side panel that shows one run file (log or step output) as plain text. Focus moves to the close button and returns to the opener on close; Escape closes.
 * @author Caglar Ulkuderner
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export interface FilePanelState {
  title: string;
  text: string;
}

export function FilePanel({ title, text, onClose }: FilePanelState & { onClose: () => void }) {
  const { t } = useTranslation("cockpit");
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("keydown", esc);
      if (opener && document.contains(opener)) opener.focus();
    };
    // Runs once per opening; the panel is remounted for each file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside
      role="dialog"
      aria-labelledby="flow-file-title"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-border bg-surface-2 shadow-2xl"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2
          id="flow-file-title"
          className="min-w-0 flex-1 truncate font-mono text-sm text-gray-100"
        >
          {title}
        </h2>
        <button
          ref={close}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-gray-300 hover:bg-surface-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X className="h-4 w-4" aria-hidden />
          {t("flows.close")}
        </button>
      </header>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-gray-200">
        {text}
      </pre>
    </aside>
  );
}
