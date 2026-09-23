import { Button } from "@/components/ui/button";
import { HostsButton } from "@/components/hosts-panel";
import { cn } from "@/lib/utils";
import type { CaStatus, DnsStatus, DnsMode } from "@/lib/ipc";

export function NetworkStrip({ dns, mode, ca, pending, error, onRetry, dnsBusy, caInstalling, onDnsStart, onDnsStop, onCaInstall }: {
  dns?: DnsStatus; mode?: DnsMode; ca?: CaStatus; pending: boolean; error: Error | null; onRetry: () => void; dnsBusy: boolean; caInstalling: boolean; onDnsStart: () => void; onDnsStop: () => void; onCaInstall: () => void;
}) {
  if (pending) return <div className="mt-4 border border-border bg-surface px-4 py-3 text-[13px] flex items-center gap-x-6" role="status"><span className="sr-only">Loading network status</span><span aria-hidden className="block h-3.5 w-24 shimmer-skeleton" /><span aria-hidden className="block h-3.5 w-20 shimmer-skeleton" /></div>;
  if (error) return <div className="mt-4 border border-border bg-surface px-4 py-3 text-[13px]"><span className="text-danger">Network status error</span><Button size="sm" variant="ghost" className="h-6 px-2 ml-2 text-[13px]" onClick={onRetry}>Retry</Button></div>;
  if (!dns || !ca || mode === undefined) return null;
  const resolverHealthy = mode === "hosts_file" ? true : dns.running;
  const dnsLabel = mode === "hosts_file" ? `hosts · *.${dns.suffix}` : dns.running ? "resolver on" : "resolver off";
  const caLabel = ca.trusted === true ? "CA installed" : ca.trusted === false ? "CA not installed" : "CA trust unknown";
  return (
    <div className="mt-4 border border-border bg-surface px-4 py-3 text-[13px] flex flex-wrap items-center gap-x-6 gap-y-2 text-ink-muted">
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn("size-2 rounded-full", resolverHealthy ? "bg-success" : "bg-warning")} />
        <span>{dnsLabel}</span>
        {mode !== "hosts_file" ? (dns.running
          ? <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[13px]" onClick={onDnsStop} disabled={dnsBusy}>Stop</Button>
          : <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[13px]" onClick={onDnsStart} disabled={dnsBusy}>Start</Button>) : null}
      </span>
      <span className="font-mono">suffix .{dns.suffix}</span>
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn("size-2 rounded-full", ca.trusted === true ? "bg-success" : "bg-warning")} />
        <span className={ca.trusted === false ? "text-warning" : undefined}>{caLabel}</span>
        {ca.trusted === false && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[13px]" disabled={caInstalling} onClick={onCaInstall}>Install CA</Button>}
      </span>
      <span className="ml-auto"><HostsButton /></span>
    </div>
  );
}
