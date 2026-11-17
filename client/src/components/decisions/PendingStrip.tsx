/**
 * @file PendingStrip.tsx
 * @description One-line Panel banner linking to the pending questions of the most recently active project.
 * @author Caglar Ulkuderner
 */

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { MessageSquareQuote } from "lucide-react";
import { cockpit } from "../../lib/cockpit";

export function PendingStrip() {
  const { t } = useTranslation("cockpit");
  const [pending, setPending] = useState(0);
  const [project, setProject] = useState("");
  useEffect(() => {
    let live = true;
    cockpit
      .decisionProjects()
      .then(async ({ projects }) => {
        const root = projects[0]?.root;
        if (!root) return;
        const r = await cockpit.decisions({ project: root, status: "pending", limit: 1 });
        if (live) {
          setPending(r.pending);
          setProject(root);
        }
      })
      .catch(() => {}); // a banner: stay hidden when the lookup fails
    return () => {
      live = false;
    };
  }, []);
  if (pending <= 0) return null;
  return (
    <Link
      to={`/decisions?tab=pending&project=${encodeURIComponent(project)}`}
      className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-4 py-2 text-sm text-amber-300 ring-1 ring-amber-400/30 hover:bg-amber-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <MessageSquareQuote className="w-4 h-4" aria-hidden />
      {t("decisions.pendingStrip", { count: pending })}
    </Link>
  );
}
