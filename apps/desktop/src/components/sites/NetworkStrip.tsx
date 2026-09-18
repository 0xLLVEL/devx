import { Button } from "@/components/ui/button";
import { HostsButton } from "@/components/hosts-panel";
import type { CaStatus, DnsStatus, DnsMode } from "@/lib/ipc";

export function NetworkStrip({ dns, mode, ca, pending, error, onRetry, dnsBusy, caInstalling, onDnsStart, onDnsStop, onCaInstall }: {
  dns?: DnsStatus; mode?: DnsMode; ca?: CaStatus; pending: boolean; error: Error | null; onRetry: () => void; dnsBusy: boolean; caInstalling: boolean; onDnsStart: () => void; onDnsStop: () => void; onCaInstall: () => void;
}) {
  if (pending) return <div className="border-t border-border/60 bg-surface-1 p-2.5 text-caption flex items-center justify-between" role="status"><span className="sr-only">Loading network status</span><span aria-hidden className="block h-3.5 w-24 animate-pulse rounded-sm bg-secondary" /><span aria-hidden className="block h-3.5 w-20 animate-pulse rounded-sm bg-secondary" /></div>;
  if (error) return <div className="border-t border-border/60 bg-surface-1 p-2.5 text-caption"><span className="text-destructive">Network status error</span><Button size="sm" variant="ghost" className="h-5 px-1.5 ml-2 text-[10px]" onClick={onRetry}>Retry</Button></div>;
  if (!dns || !ca || mode === undefined) return null;
  const healthy = mode === "hosts_file" ? true : dns.running;
  const label = mode === "hosts_file" ? `Hosts file · *.${dns.suffix}` : dns.running ? `Resolver :${dns.port}` : "Resolver stopped";
  return (
    <div className="border-t border-border/60 bg-surface-1 p-2.5 text-[11px] flex flex-wrap items-center justify-between gap-1 text-ink-muted">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1"><span aria-hidden className={`size-1.5 rounded-full ${ca.trusted ? "bg-success" : "bg-warning"}`} /><span className={ca.trusted ? undefined : "text-warning"}>{ca.trusted === true ? "Local CA trusted" : ca.trusted === false ? "CA not installed" : "CA trust unknown"}</span>{ca.trusted === false && <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px] text-primary" disabled={caInstalling} onClick={onCaInstall}>Install CA</Button>}</span>
        <span className="flex items-center gap-1"><span aria-hidden className={`size-1.5 rounded-full ${healthy ? "bg-success" : "bg-warning"}`} /><span>{label}</span>{mode !== "hosts_file" ? (dns.running ? <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px]" onClick={onDnsStop} disabled={dnsBusy}>Stop</Button> : <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px] text-primary" onClick={onDnsStart} disabled={dnsBusy}>Start</Button>) : null}</span>
      </div>
      <HostsButton />
    </div>
  );
}
