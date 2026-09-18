import { useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import type { SiteStatus } from "@/lib/ipc";

export function AliasPanel({ site, busy, onAdd, onDelete }: { site: SiteStatus; busy: boolean; onAdd: (a: string) => Promise<unknown>; onDelete: (a: string) => void }) {
  const [alias, setAlias] = useState("");
  const entries = [...site.aliases].sort((a, b) => a.localeCompare(b));
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-foreground">Configured Aliases</h3>
        {entries.length > 0 ? (
          <ul className="space-y-1.5">
            {entries.map((name) => (
              <li key={name} className="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-2/40 border border-border/60">
                <span className="font-mono text-xs" data-selectable>{name}</span>
                <Tooltip label={`Delete ${name}`}>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={busy} onClick={() => onDelete(name)} aria-label={`Delete ${name}`}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Globe />} title="No aliases." description={`Add extra host names the site answers to alongside ${site.hostname}.`} />
        )}
        <form className="flex flex-wrap items-end gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); const t = alias.trim().toLowerCase(); if (!t) return; void onAdd(t).then(() => setAlias("")).catch(() => undefined); }}>
          <div className="space-y-1.5 flex-1 min-w-48">
            <Label htmlFor={`alias-${site.hostname}`}>Add new alias</Label>
            <Input id={`alias-${site.hostname}`} value={alias} placeholder={`www.${site.hostname}`} className="font-mono text-xs" onChange={(e) => setAlias(e.target.value.toLowerCase())} autoComplete="off" spellCheck={false} />
          </div>
          <Button type="submit" size="sm" disabled={busy || alias.trim().length === 0}><Plus className="size-3.5 mr-1" />Add alias</Button>
        </form>
      </div>
    </div>
  );
}
