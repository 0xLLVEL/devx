import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityTimeline } from "@/components/activity-timeline";
import type { EventEntry } from "@/lib/ipc";
import { renderWithProviders } from "@/test/render";

/**
 * §42 recent activity: one line per transition the event log recorded, with
 * the exit reason only when it explains something.
 */

const NOW = Math.floor(Date.now() / 1000);

function event(overrides: Partial<EventEntry> = {}): EventEntry {
  return {
    at_unix: NOW - 120,
    id: "nginx",
    state: "running",
    exit: null,
    ...overrides,
  };
}

describe("ActivityTimeline", () => {
  it("reads each transition as a sentence with how long ago it happened", () => {
    renderWithProviders(
      <ActivityTimeline
        events={[
          event({ id: "nginx", state: "running", at_unix: NOW - 120 }),
          event({ id: "mariadb", state: "failed", exit: "crashed", at_unix: NOW - 3600 }),
        ]}
      />,
    );

    expect(screen.getByText("Started nginx")).toBeInTheDocument();
    expect(screen.getByText("2 min ago")).toBeInTheDocument();
    expect(screen.getByText("mariadb failed")).toBeInTheDocument();
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument();
    expect(screen.getByText("1 h ago")).toBeInTheDocument();
  });

  it("keeps the order it was given: the newest transition first", () => {
    renderWithProviders(
      <ActivityTimeline
        events={[event({ id: "nginx" }), event({ id: "mariadb" })]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Started nginx")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Started mariadb")).toBeInTheDocument();
  });

  it("leaves a requested stop unexplained", () => {
    renderWithProviders(
      <ActivityTimeline events={[event({ state: "stopped", exit: "requested" })]} />,
    );

    expect(screen.getByText("Stopped nginx")).toBeInTheDocument();
    expect(screen.queryByText(/requested/)).not.toBeInTheDocument();
  });

  it("caps the timeline at its limit", () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      event({ id: `service-${index}` }),
    );

    renderWithProviders(<ActivityTimeline events={events} limit={6} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  it("shows an honest empty state instead of sample activity", () => {
    renderWithProviders(<ActivityTimeline events={[]} />);

    expect(screen.getByText("No service events yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("names an unknown state rather than pretending it is one it knows", () => {
    renderWithProviders(
      <ActivityTimeline events={[event({ state: "restarting" })]} />,
    );

    expect(screen.getByText("nginx → restarting")).toBeInTheDocument();
  });
});
