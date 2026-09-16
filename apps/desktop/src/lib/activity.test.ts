import { describe, expect, it } from "vitest";

import {
  describeExit,
  describeTransition,
  formatRelativeTime,
} from "@/lib/activity";

/**
 * The §42 vocabulary. Nothing here may invent a transition or a time: these
 * functions only put words around what the event log recorded.
 */

describe("formatRelativeTime", () => {
  const now = 1_700_000_000;

  it("reads under a minute as just now", () => {
    expect(formatRelativeTime(now - 5, now)).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    expect(formatRelativeTime(now - 120, now)).toBe("2 min ago");
    expect(formatRelativeTime(now - 7_200, now)).toBe("2 h ago");
    expect(formatRelativeTime(now - 172_800, now)).toBe("2 d ago");
  });

  it("does not invent a time it was not given", () => {
    expect(formatRelativeTime(0, now)).toBe("unknown time");
    expect(formatRelativeTime(Number.NaN, now)).toBe("unknown time");
  });

  it("never reports a future event as negative time", () => {
    expect(formatRelativeTime(now + 500, now)).toBe("just now");
  });
});

describe("describeTransition", () => {
  it("names each known transition", () => {
    expect(describeTransition("running", "nginx")).toBe("Started nginx");
    expect(describeTransition("failed", "nginx")).toBe("nginx failed");
    expect(describeTransition("starting", "nginx")).toBe("Starting nginx");
    expect(describeTransition("stopping", "nginx")).toBe("Stopping nginx");
    expect(describeTransition("stopped", "nginx")).toBe("Stopped nginx");
  });

  it("passes an unknown state through rather than mislabelling it", () => {
    expect(describeTransition("restarting", "nginx")).toBe("nginx → restarting");
  });
});

describe("describeExit", () => {
  it("says nothing about a stop that was asked for", () => {
    expect(describeExit(null)).toBeNull();
    expect(describeExit("")).toBeNull();
    expect(describeExit("requested")).toBeNull();
  });

  it("explains the reasons a service really stopped", () => {
    expect(describeExit("crashed")).toBe("exited unexpectedly");
    expect(describeExit("health_timeout")).toBe("health check timed out");
    expect(describeExit("spawn_failed")).toBe("could not start");
  });

  it("keeps a reason it does not know about", () => {
    expect(describeExit("oom")).toBe("oom");
  });
});
