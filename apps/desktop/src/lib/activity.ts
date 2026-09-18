export function formatRelativeTime(
  atUnix: number,
  now: number = Date.now() / 1000,
): string {
  if (!Number.isFinite(atUnix) || atUnix <= 0) return "unknown time";
  const elapsed = Math.max(0, now - atUnix);
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} min ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)} h ago`;
  return `${Math.floor(elapsed / 86_400)} d ago`;
}

export function describeTransition(state: string, id: string): string {
  switch (state) {
    case "running":
      return `Started ${id}`;
    case "failed":
      return `${id} failed`;
    case "starting":
      return `Starting ${id}`;
    case "stopping":
      return `Stopping ${id}`;
    case "stopped":
      return `Stopped ${id}`;
    default:
      return `${id} → ${state}`;
  }
}

export function describeExit(exit: string | null): string | null {
  switch (exit) {
    case null:
    case "":
    case "requested":
      return null;
    case "crashed":
      return "exited unexpectedly";
    case "health_timeout":
      return "health check timed out";
    case "spawn_failed":
      return "could not start";
    default:
      return exit;
  }
}
