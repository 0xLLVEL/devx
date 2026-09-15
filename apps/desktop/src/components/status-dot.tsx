import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ServiceUiState = "running" | "failed" | "starting" | "stopping" | "stopped";

const DOT_CLASS: Record<ServiceUiState, string> = {
  running: "bg-success",
  failed: "bg-destructive",
  starting: "animate-pulse bg-warning",
  stopping: "animate-pulse bg-warning",
  stopped: "bg-muted-foreground/40",
};

/**
 * Status = dot + label, with an alert icon added for the failed state —
 * never color alone (MASTER.md accessibility rule). The pulse on
 * starting/stopping is a real state, the one loop MOTION=1 allows.
 */
export function StatusBadge({
  state,
  label,
  className,
}: {
  state: ServiceUiState;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        state === "failed" ? "font-medium text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])}
      />
      {state === "failed" ? <CircleAlert className="size-3" aria-hidden /> : null}
      <span className="capitalize">{label ?? state}</span>
    </span>
  );
}
