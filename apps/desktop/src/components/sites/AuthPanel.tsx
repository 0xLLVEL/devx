import { useState } from "react";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { ipc, type SiteStatus } from "@/lib/ipc";

export function AuthPanel({ site }: { site: SiteStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [user, setUser] = useState(site.auth?.username ?? "");
  const [pass, setPass] = useState("");
  const inv = () => { setPass(""); void qc.invalidateQueries({ queryKey: ["sites"] }); };
  const m = useMutation({
    mutationFn: (a: { user: string | null; pass: string | null }) => ipc.siteAuthSet(site.hostname, a.user, a.pass),
    onSuccess: (_r, { user: u }) => { inv(); toast.success(u === null ? "Protection removed" : "Basic Auth enabled", { description: u === null ? `${site.hostname} is public again.` : `${site.hostname} now asks for a user name and password.` }); },
  });
  const err = m.error instanceof Error ? m.error : null;
  return (
    <div className="rounded-lg border border-border bg-surface-2/80 p-4 space-y-3">
      <h3 className="text-xs font-semibold text-foreground">HTTP Basic Auth</h3>
      {site.auth ? (
        <div className="flex items-center gap-2 text-sm p-3 rounded-md bg-surface-2/40 border border-border/60">
          <Lock className="size-4 text-ink-muted" aria-hidden /><span>Protected with user <span className="font-mono font-semibold text-foreground" data-selectable>{site.auth.username}</span></span>
          <Button type="button" variant="ghost" size="sm" className="ml-auto text-destructive" disabled={m.isPending} onClick={() => m.mutate({ user: null, pass: null })}>Remove protection</Button>
        </div>
      ) : <p className="text-sm text-muted-foreground">Public site. Add credentials to password-protect all requests.</p>}
      <form className="flex flex-wrap items-end gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); if (!user.trim() || !pass) return; m.mutate({ user: user.trim(), pass }); }}>
        <div className="space-y-1.5"><Label htmlFor={`auth-user-${site.hostname}`}>User</Label><Input id={`auth-user-${site.hostname}`} value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" autoComplete="off" className="w-40" /></div>
        <div className="space-y-1.5"><Label htmlFor={`auth-pass-${site.hostname}`}>Password</Label><Input id={`auth-pass-${site.hostname}`} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={site.auth ? "Replace password" : "Choose a password"} autoComplete="new-password" className="w-48" /></div>
        <Button type="submit" size="sm" disabled={m.isPending || !user.trim() || !pass}>{m.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck className="size-3.5 mr-1" />}{site.auth ? "Replace" : "Protect site"}</Button>
      </form>
      {err ? <Callout variant="destructive" title="Could not change Basic Auth."><p>{err.message}</p></Callout> : null}
    </div>
  );
}
