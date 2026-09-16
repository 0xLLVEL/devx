import { describe, expect, it } from "vitest";

import { deriveSystemStatus } from "@/lib/shell-data";

/**
 * §118's verdict. The states map onto what the backend actually reports, and
 * the worst thing happening wins: a failed service must never be reported as
 * "Attention Required".
 */
describe("deriveSystemStatus", () => {
  it("reports readiness only when every service is running", () => {
    const status = deriveSystemStatus(["running", "running"]);
    expect(status.label).toBe("System Ready");
    expect(status.detail).toMatch(/All services are running/);
    expect(status.failedCount).toBe(0);
  });

  it("reports an error with the number of failed services", () => {
    const status = deriveSystemStatus(["running", "failed", "failed"]);
    expect(status.state).toBe("error");
    expect(status.label).toBe("System Error");
    expect(status.detail).toBe("2 services failed.");
    expect(status.failedCount).toBe(2);
  });

  it("ranks a failure above a service that is still starting", () => {
    expect(deriveSystemStatus(["failed", "starting"]).state).toBe("error");
  });

  it("reports starting and stopping while they are in flight", () => {
    expect(deriveSystemStatus(["running", "starting"]).state).toBe("starting");
    expect(deriveSystemStatus(["running", "stopping"]).state).toBe("stopping");
  });

  it("asks for attention when something is simply stopped", () => {
    const status = deriveSystemStatus(["running", "stopped"]);
    expect(status.state).toBe("attention");
    expect(status.detail).toBe("1 of 2 services running.");
  });

  it("makes no claim when nothing is supervised yet", () => {
    const status = deriveSystemStatus([]);
    expect(status.state).toBe("unknown");
    expect(status.detail).toMatch(/nothing is supervised/i);
  });

  it("uses the singular where it means it", () => {
    expect(deriveSystemStatus(["failed"]).detail).toBe("1 service failed.");
    expect(deriveSystemStatus(["running"]).detail).toBe("The service is running.");
  });
});
