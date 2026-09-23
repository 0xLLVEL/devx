import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useInstalledVersions } from "@/lib/queries";
import { ipc, type SiteStatus } from "@/lib/ipc";
import { pickDirectory } from "@/lib/pick-directory";
import { serverLabel, type WebServerChoice } from "./site-helpers";

function DocrootField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const browse = async () => {
    const dir = await pickDirectory(value);
    if (dir) onChange(dir);
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Document root</Label>
      <div className="flex items-center gap-2">
        <span id={id} className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-selectable title={value || undefined}>
          {value || "No folder selected"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>Browse…</Button>
      </div>
    </div>
  );
}

export function SiteBehaviorEditor({ site, phpChoices }: { site: SiteStatus; phpChoices: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const installed = useInstalledVersions();
  const ids = useMemo(() => new Set((installed.data ?? []).map((v) => v.component_id)), [installed.data]);

  const availableServers = useMemo(() => {
    const s: WebServerChoice[] = [];
    if (ids.has("nginx") || site.web_server === "Nginx") s.push("Nginx");
    if (ids.has("apache") || site.web_server === "Apache") s.push("Apache");
    if (ids.has("caddy") || site.web_server === "Caddy") s.push("Caddy");
    if (ids.has("frankenphp") || site.web_server === "FrankenPhp") s.push("FrankenPhp");
    return s.length > 0 ? s : (["Nginx", "Apache", "Caddy", "FrankenPhp"] as WebServerChoice[]);
  }, [ids, site.web_server]);

  const [docroot, setDocroot] = useState(site.docroot);
  const [php, setPhp] = useState(site.php_version);
  const [https, setHttps] = useState(site.https);
  const [server, setServer] = useState<WebServerChoice>(site.web_server);

  useEffect(() => {
    setDocroot(site.docroot);
    setPhp(site.php_version);
    setHttps(site.https);
    setServer(site.web_server);
  }, [site]);

  const save = useMutation({
    mutationFn: () => ipc.siteAdd(site.hostname, docroot.trim(), php, https, server),
    onSuccess: () => toast.success("Changes saved", { description: `${site.hostname} is served with the new settings.` }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });
  const err = save.error instanceof Error ? save.error : null;

  return (
    <div className="rounded-lg border border-border bg-surface-2/80 p-4 space-y-4">
      <h3 className="text-xs font-semibold text-foreground">Behavior</h3>
      <DocrootField id={`edit-docroot-${site.hostname}`} value={docroot} onChange={setDocroot} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-php-${site.hostname}`}>PHP</Label>
          <Select id={`edit-php-${site.hostname}`} value={php} onChange={(e) => setPhp(e.target.value)}>
            <option value="">None (static)</option>
            {phpChoices.map((v) => <option key={v} value={v}>{v}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-server-${site.hostname}`}>Web server</Label>
          <Select id={`edit-server-${site.hostname}`} value={server} onChange={(e) => setServer(e.target.value as WebServerChoice)}>
            {availableServers.map((s) => <option key={s} value={s}>{serverLabel(s)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-https-${site.hostname}`}>HTTPS</Label>
          <Select id={`edit-https-${site.hostname}`} value={https ? "on" : "off"} onChange={(e) => setHttps(e.target.value === "on")}>
            <option value="off">HTTP only</option>
            <option value="on">HTTP + HTTPS</option>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}Save changes
        </Button>
      </div>
      {err ? <Callout variant="destructive" title="Could not save the changes."><p>{err.message}</p></Callout> : null}
    </div>
  );
}
