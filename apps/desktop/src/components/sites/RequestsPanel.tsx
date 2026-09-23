import { useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/lib/ipc";

function formatTime(t: number | null): string { if (t === null) return "—"; return new Date(t * 1000).toLocaleTimeString(); }
function formatBytes(b: number): string { if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`; if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`; return `${b} B`; }

export function RequestsPanel({ hostname }: { hostname: string }) {
  const [live, setLive] = useState(true);
  const q = useQuery({ queryKey: ["site-requests", hostname], queryFn: () => ipc.siteRequests(hostname, 50), refetchInterval: live ? 3000 : false });
  const entries = q.data ?? [];
  return (
    <div className="rounded-lg border border-border bg-surface-2/80 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">Access Log {entries.length > 0 ? `(${entries.length} requests)` : ""}</h3>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">Live<Switch checked={live} onCheckedChange={setLive} aria-label={`Toggle live polling for ${hostname}`} /></label>
      </div>
      {q.isPending ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Reading access log…</p>
        : q.isError ? <Callout variant="destructive" title="Could not read the request log."><p>{q.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void q.refetch()}>Try again</Button></Callout>
        : entries.length > 0 ? (
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-2 text-muted-foreground"><tr><th className="px-2.5 py-2 font-medium">Time</th><th className="px-2.5 py-2 font-medium">Request</th><th className="px-2.5 py-2 font-medium">Status</th><th className="px-2.5 py-2 text-right font-medium">Size</th><th className="hidden px-2.5 py-2 font-medium sm:table-cell">User agent</th></tr></thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={`${e.time_unix ?? "t"}-${i}-${e.path}`} className="border-t border-border/60">
                    <td className="whitespace-nowrap px-2.5 py-2 text-muted-foreground font-mono">{formatTime(e.time_unix)}</td>
                    <td className="max-w-48 truncate px-2.5 py-2 font-mono font-medium text-foreground" title={`${e.method} ${e.path}`}>{e.method} {e.path}</td>
                    <td className="px-2.5 py-2"><Badge variant={e.status < 400 ? "success" : "warning"}>{e.status || "—"}</Badge></td>
                    <td className="whitespace-nowrap px-2.5 py-2 text-right font-mono text-muted-foreground">{e.bytes !== null ? formatBytes(e.bytes) : "—"}</td>
                    <td className="hidden max-w-44 truncate px-2.5 py-2 text-muted-foreground sm:table-cell" title={e.user_agent}>{e.user_agent || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon={<Activity />} title="No requests logged yet." description="Load the site in a browser, then wait for the next poll." />}
    </div>
  );
}
