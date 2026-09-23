import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

function formatTime(t: number | null): string {
  if (t === null) return "—";
  return new Date(t * 1000).toLocaleTimeString();
}

/**
 * Recent requests feed for the Overview tab (preview Frame 3).
 * Real access-log lines only — no invented totals.
 */
export function RequestsSummary({ hostname }: { hostname: string }) {
  const q = useQuery({
    queryKey: ["site-requests-summary", hostname],
    queryFn: () => ipc.siteRequests(hostname, 5),
    refetchInterval: 5000,
  });
  const entries = q.data ?? [];
  const okCount = entries.filter((e) => e.status < 400).length;

  return (
    <div className="border border-border bg-surface px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">Recent requests</h3>
        {entries.length > 0 ? (
          <span className="text-[12px] text-ink-muted">
            {okCount} × 200
          </span>
        ) : null}
      </div>
      {q.isPending ? (
        <p className="mt-3 text-[13px] text-ink-muted" role="status">Reading access log…</p>
      ) : entries.length > 0 ? (
        <ul className="mt-2 divide-y divide-border/50 font-mono text-xs">
          {entries.map((e, i) => (
            <li key={`${e.time_unix ?? "t"}-${i}-${e.path}`} className="flex items-center gap-3 py-1.5">
              <span className="w-16 shrink-0 text-ink-muted">{formatTime(e.time_unix)}</span>
              <span className="border border-line-strong px-1.5 py-px text-[10px] font-bold">{e.method}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{e.path}</span>
              <span className={e.status < 400 ? "text-success" : "text-warning"}>{e.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-ink-muted">No requests logged yet.</p>
      )}
    </div>
  );
}
