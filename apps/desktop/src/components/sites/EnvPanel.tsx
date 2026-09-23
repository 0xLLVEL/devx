import { useState } from "react";
import { Loader2, Plus, Trash2, Variable } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ipc, type SiteStatus } from "@/lib/ipc";

export function EnvPanel({ site }: { site: SiteStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const inv = () => void qc.invalidateQueries({ queryKey: ["sites"] });
  const setEnv = useMutation({
    mutationFn: ({ key: k, value: v }: { key: string; value: string }) => ipc.siteEnvSet(site.hostname, k, v),
    onSuccess: (_r, { key: k }) => { inv(); toast.success("Environment variable saved", { description: `${k} reaches ${site.hostname} on the next request.` }); },
  });
  const del = useMutation({
    mutationFn: (k: string) => ipc.siteEnvDelete(site.hostname, k),
    onSuccess: (_r, k) => { inv(); toast.success("Environment variable removed", { description: `${k} is no longer set for ${site.hostname}.` }); },
  });
  const error = setEnv.error instanceof Error ? setEnv.error : del.error instanceof Error ? del.error : null;
  const entries = Object.entries(site.env).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-2/80 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-foreground">Environment Variables</h3>
        {site.php_version ? null : <p className="text-xs text-muted-foreground">This site is static; environment variables only reach PHP sites.</p>}
        {entries.length > 0 ? (
          <ul className="space-y-1.5">
            {entries.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-2/40 border border-border/60">
                <span className="min-w-0 truncate font-mono text-xs" data-selectable title={`${k} = ${v}`}><span className="font-semibold text-foreground">{k}</span><span className="text-ink-muted"> = {v}</span></span>
                <Tooltip label={`Delete ${k}`}>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={del.isPending} onClick={() => del.mutate(k)} aria-label={`Delete ${k}`}><Trash2 className="size-3.5 text-destructive" /></Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={<Variable />} title="No environment variables yet." description="They are exposed to the site's PHP requests, like a server-level .env." />}
        <form className="flex flex-wrap items-end gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); if (!key.trim()) return; setEnv.mutate({ key: key.trim(), value }); setKey(""); setValue(""); }}>
          <div className="space-y-1.5"><Label htmlFor={`env-key-${site.hostname}`}>Name</Label><Input id={`env-key-${site.hostname}`} value={key} placeholder="APP_ENV" className="w-40 font-mono text-xs" onChange={(e) => setKey(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} /></div>
          <div className="space-y-1.5 flex-1 min-w-44"><Label htmlFor={`env-value-${site.hostname}`}>Value</Label><Input id={`env-value-${site.hostname}`} value={value} placeholder="local" className="text-xs" onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} /></div>
          <Button type="submit" size="sm" disabled={setEnv.isPending || key.trim().length === 0}>{setEnv.isPending ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5 mr-1" />}Set</Button>
        </form>
        {error ? <Callout variant="destructive" title="Could not update the environment variable."><p>{error.message}</p></Callout> : null}
      </div>
    </div>
  );
}
