import { Activity, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";

export function PingButton({ hostname }: { hostname: string }) {
  const ping = useMutation({ mutationFn: () => ipc.sitePing(hostname) });
  if (ping.isPending) return <Button variant="outline" size="sm" disabled className="gap-1.5" aria-label={`Checking ${hostname}`}><Loader2 className="size-3.5 animate-spin" />Ping</Button>;
  if (ping.isError) return <Tooltip label={ping.error.message}><Button variant="outline" size="sm" onClick={() => ping.mutate()} className="gap-1.5 text-destructive border-destructive/30" aria-label={`Re-check ${hostname}`}><Activity className="size-3.5" />Failed</Button></Tooltip>;
  const r = ping.data;
  if (r === undefined) return <Button variant="outline" size="sm" onClick={() => ping.mutate()} className="gap-1.5" aria-label={`Check ${hostname}`}><Activity className="size-3.5" />Ping</Button>;
  const ok = r.status !== null && r.status < 500;
  return <Button variant="outline" size="sm" onClick={() => ping.mutate()} className={cn("gap-1.5", ok ? "text-success border-success/30" : "text-warning border-warning/30")} aria-label={`Re-check ${hostname}`}><Activity className="size-3.5" />{r.status !== null ? `${r.status} · ${r.latency_ms}ms` : "Ping"}</Button>;
}
