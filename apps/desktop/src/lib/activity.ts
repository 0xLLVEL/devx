/**
 * Vocabulary for the §42 activity timeline.
 *
 * Pure functions over what the backend recorded: the event log is the single
 * source of transitions and their timestamps (§131 Rule 8), so nothing here
 * invents an event, a time or a delta — it only names them in words a person
 * reads.
 */

/**
 * §42's relative clock: "just now", "4 min ago", "2 h ago", "3 d ago".
 *
 * `now` is a parameter so the formatting is testable without freezing the
 * clock.
 */
export function formatRelativeTime(
  atUnix: number,
  now: number = Date.now() / 1000,
): string {
  if (!Number.isFinite(atUnix) || atUnix <= 0) {
    return "unknown time";
  }
  const elapsed = Math.max(0, now - atUnix);
  if (elapsed < 60) {
    return "just now";
  }
  if (elapsed < 3600) {
    return `${Math.floor(elapsed / 60)} min ago`;
  }
  if (elapsed < 86_400) {
    return `${Math.floor(elapsed / 3600)} h ago`;
  }
  return `${Math.floor(elapsed / 86_400)} d ago`;
}

/** What happened, as the timeline says it: `Started nginx`. */
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
      // An unknown state is still a real transition: name it rather than
      // dressing it up as one of the five we know.
      return `${id} → ${state}`;
  }
}

/**
 * The exit reason the log recorded, in plain words.
 *
 * Null when there is nothing to explain: a requested stop is how a service is
 * supposed to end, and an absent reason is simply absent.
 */
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
