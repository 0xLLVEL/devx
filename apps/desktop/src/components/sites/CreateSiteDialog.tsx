import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileCode, GitBranch, Globe, Loader2, Plus, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useInstalledVersions } from "@/lib/queries";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { serverLabel, type WebServerChoice } from "./site-helpers";

function DocrootField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const pick = async () => {
    const { pickDirectory } = await import("@/lib/pick-directory");
    const dir = await pickDirectory(value);
    if (dir) onChange(dir);
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Document root</Label>
      <div className="flex items-center gap-2">
        <span id={id} className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-selectable title={value || undefined}>{value || "No folder selected"}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void pick()}>Browse…</Button>
      </div>
    </div>
  );
}

export function CreateSiteDialog({ open, phpChoices, phpChoicesError, onRetryPhpChoices, onClose }: {
  open: boolean; phpChoices: string[]; phpChoicesError: Error | null; onRetryPhpChoices: () => void; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const installed = useInstalledVersions();
  const ids = useMemo(() => new Set((installed.data ?? []).map((v) => v.component_id)), [installed.data]);
  const availableServers = useMemo(() => {
    const s: WebServerChoice[] = [];
    if (ids.has("nginx")) s.push("Nginx");
    if (ids.has("apache")) s.push("Apache");
    if (ids.has("caddy")) s.push("Caddy");
    if (ids.has("frankenphp")) s.push("FrankenPhp");
    return s.length > 0 ? s : (["Nginx", "Apache", "Caddy", "FrankenPhp"] as WebServerChoice[]);
  }, [ids]);
  const [mode, setMode] = useState<"manual" | "template">("manual");
  const [templateId, setTemplateId] = useState("static");
  const [gitUrl, setGitUrl] = useState("");
  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [php, setPhp] = useState("");
  const [https, setHttps] = useState(false);
  const [webServer, setWebServer] = useState<WebServerChoice>("Nginx");
  const templates = useQuery({ queryKey: ["templates"], queryFn: ipc.templateList, enabled: open });

  useEffect(() => { const f = availableServers[0]; if (open && f && !availableServers.includes(webServer)) setWebServer(f); }, [open, availableServers, webServer]);

  const add = useMutation({
    mutationFn: () => ipc.siteAdd(hostname.trim(), docroot.trim(), php, https, webServer),
    onSuccess: () => { toast.success("Site added", { description: `${hostname.trim()} is served by ${serverLabel(webServer)}.` }); resetAndClose(); },
    onError: (e: Error) => toast.error("Could not add the site", { details: e.message }),
  });
  const fromTemplate = useMutation({
    mutationFn: () => ipc.templateCreate(templateId, hostname.trim(), docroot.trim(), php, https, templateId === "git" ? gitUrl.trim() || null : null),
    onSuccess: (r) => { toast.success("Site created from template", { description: `${r.hostname} has been scaffolded and configured.` }); if (r.follow_up_command) toast.info("Suggested command", { description: r.follow_up_command }); resetAndClose(); },
    onError: (e: Error) => toast.error("Could not scaffold site", { details: e.message }),
  });
  const resetAndClose = () => { setHostname(""); setDocroot(""); setPhp(""); setHttps(false); setGitUrl(""); setMode("manual"); setTemplateId("static"); add.reset(); fromTemplate.reset(); qc.invalidateQueries({ queryKey: ["sites"] }); onClose(); };
  const close = () => { add.reset(); fromTemplate.reset(); setMode("manual"); onClose(); };
  const isTemplate = mode === "template";
  const incomplete = hostname.trim().length === 0 || docroot.trim().length === 0 || (isTemplate && templateId === "git" && gitUrl.trim().length === 0);
  const pending = add.isPending || fromTemplate.isPending;
  const err = (isTemplate ? fromTemplate.error : add.error) as Error | null;
  const submit = () => { if (incomplete || pending) return; isTemplate ? fromTemplate.mutate() : add.mutate(); };

  return (
    <Dialog open={open} onClose={close} title="Add a site" description={isTemplate ? "Scaffold a new project from a starter template and register it as a local site." : "DevX routes the host name to this folder through the local web server."} size="lg"
      footer={<><Button type="button" variant="ghost" data-autofocus disabled={pending} onClick={close}>Cancel</Button><Button type="button" disabled={incomplete || pending} onClick={submit}>{pending ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5 mr-1" />}{isTemplate ? "Scaffold & create site" : "Create site"}</Button></>}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-surface-2/30 p-2.5">
          <div className="min-w-0 flex-1"><p className="text-xs font-medium text-foreground">{isTemplate ? "Starter templates" : "Need a starter project?"}</p><p className="text-[11px] text-muted-foreground truncate">{isTemplate ? "Select a template below to scaffold files into your project folder." : "Scaffold Laravel, WordPress, PHP, static sites, or clone a Git repository."}</p></div>
          <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs font-medium border-border/80 bg-surface-1 hover:bg-surface-2" onClick={() => { setMode(isTemplate ? "manual" : "template"); if (!isTemplate && !hostname) setHostname("mysite.test"); }}>{isTemplate ? "Manual configuration" : <><Sparkles className="size-3 text-primary" />Import from template</>}</Button>
        </div>
        {isTemplate && (
          <div className="space-y-2">
            <Label className="text-xs">Choose template</Label>
            {templates.isPending ? <div className="grid grid-cols-2 gap-2">{[0,1,2,3].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2/60" />)}</div>
              : templates.data && templates.data.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {templates.data.map((tmpl) => {
                    const sel = templateId === tmpl.id;
                    return (
                      <button key={tmpl.id} type="button" onClick={() => { setTemplateId(tmpl.id); if (["php","wordpress","laravel"].includes(tmpl.id)) { if (!php && phpChoices.length > 0) setPhp(phpChoices[0] || ""); } else if (tmpl.id === "static") setPhp(""); }} className={cn("flex flex-col items-start p-2.5 rounded-lg border text-left transition-all cursor-pointer", sel ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border/70 bg-surface-2/20 hover:border-border hover:bg-surface-2/40")}>
                        <div className="flex items-center justify-between w-full">
                          <span className="font-semibold text-xs text-foreground flex items-center gap-1.5">
                            {tmpl.id === "laravel" && <span className="text-destructive font-bold text-xs">▲</span>}
                            {tmpl.id === "wordpress" && <Globe className="size-3.5 text-primary" />}
                            {tmpl.id === "git" && <GitBranch className="size-3.5 text-primary" />}
                            {tmpl.id === "php" && <FileCode className="size-3.5 text-primary" />}
                            {tmpl.id === "static" && <Globe className="size-3.5 text-muted-foreground" />}
                            {tmpl.name}
                          </span>
                          {tmpl.local ? <Badge variant="outline" className="text-[10px] px-1 py-0">Local</Badge> : <Badge variant="secondary" className="text-[10px] px-1 py-0">Scaffold</Badge>}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{tmpl.description}</p>
                      </button>
                    );
                  })}
                </div>
              ) : null}
          </div>
        )}
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {isTemplate && templateId === "git" && <div className="space-y-1.5"><Label htmlFor="site-git-url">Git repository URL</Label><Input id="site-git-url" placeholder="https://github.com/username/repository.git" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} autoComplete="off" spellCheck={false} /></div>}
          <div className="space-y-1.5"><Label htmlFor="site-hostname">Host name</Label><Input id="site-hostname" placeholder="myapp.test" value={hostname} onChange={(e) => setHostname(e.target.value)} autoComplete="off" spellCheck={false} /><p className="text-xs text-muted-foreground">Must end in <code>.test</code> to match the local resolver.</p></div>
          <DocrootField id="site-docroot" value={docroot} onChange={setDocroot} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="site-php">PHP</Label><Select id="site-php" value={php} onChange={(e) => setPhp(e.target.value)}><option value="">None (static)</option>{phpChoices.map((v) => <option key={v} value={v}>{v}</option>)}</Select>{phpChoicesError ? <Callout variant="destructive" title="Could not read the PHP versions."><p>{phpChoicesError.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={onRetryPhpChoices}>Try again</Button></Callout> : null}</div>
            <div className="space-y-1.5"><Label htmlFor="site-https">HTTPS</Label><div className="flex h-9 items-center gap-2"><Switch id="site-https" checked={https} onCheckedChange={setHttps} /><span className="text-xs text-muted-foreground">{https ? "Served over HTTPS" : "HTTP only"}</span></div></div>
          </div>
          {!isTemplate && (
            <details className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm text-ink-secondary transition-colors duration-150 hover:text-foreground [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden className="size-3.5 transition-transform duration-150 [[open]_&]:rotate-90" />Advanced</summary>
              <div className="space-y-1.5 border-t border-border p-3"><Label htmlFor="site-web-server">Web server</Label><Select id="site-web-server" value={webServer} onChange={(e) => setWebServer(e.target.value as WebServerChoice)}>{availableServers.map((s) => <option key={s} value={s}>{serverLabel(s)}</option>)}</Select><p className="text-xs text-muted-foreground">{webServer === "Nginx" || webServer === "Apache" ? `${serverLabel(webServer)} routes PHP through FastCGI pools.` : "Caddy and FrankenPHP handle serving themselves."}</p></div>
            </details>
          )}
          {err ? <Callout variant="destructive" title="Could not create the site."><p>{err.message}</p></Callout> : null}
        </form>
      </div>
    </Dialog>
  );
}
