import { screen } from "@testing-library/react";
import { Gauge } from "lucide-react";
import { describe, expect, it } from "vitest";

import { SummaryCard } from "@/components/summary-card";
import { renderWithProviders } from "@/test/render";

/**
 * §18 summary card: icon, label, value, status and one click target. The
 * states that matter are the ones a live backend produces — a real number, a
 * number that has not arrived, and a number that will not arrive.
 */

describe("SummaryCard", () => {
  it("shows the label, value and status, and links to its page", () => {
    renderWithProviders(
      <SummaryCard
        to="/services"
        icon={Gauge}
        label="Servers"
        value="3/4"
        status="1 failed"
        tone="destructive"
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/services");
    expect(screen.getByText("Servers")).toBeInTheDocument();
    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });

  it("shows a skeleton instead of a zero while the backend has not answered", () => {
    renderWithProviders(
      <SummaryCard
        to="/sites"
        icon={Gauge}
        label="Sites"
        value={null}
        status="Counting…"
        pending
      />,
    );

    // §131 Rule 17: an unknown count is never drawn as 0.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("Loading Sites")).toBeInTheDocument();
  });

  it("says it does not know rather than guessing when the value is unavailable", () => {
    renderWithProviders(
      <SummaryCard
        to="/components"
        icon={Gauge}
        label="Runtimes"
        value={null}
        status="Catalog unavailable"
        tone="warning"
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Catalog unavailable")).toBeInTheDocument();
  });
});
