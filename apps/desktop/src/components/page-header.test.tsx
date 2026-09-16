import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/page-header";

/**
 * §63 page header: title, description and the primary action on one row, with
 * the search / filter / tab row underneath.
 *
 * The `right` slot predates §63 and is still used by eight pages, so it has to
 * keep rendering exactly as before.
 */

describe("PageHeader", () => {
  it("renders the §63 shape: title, description, primary action, then the row below", () => {
    render(
      <PageHeader
        eyebrow="Good evening, Developer"
        title="Runtime Manager"
        description="Install, switch and manage language runtimes."
        primaryAction={<button type="button">Install Runtime</button>}
      >
        <input aria-label="Search runtimes" />
      </PageHeader>,
    );

    expect(screen.getByText("Good evening, Developer")).toBeInTheDocument();
    expect(screen.getByText("Runtime Manager")).toBeInTheDocument();
    expect(
      screen.getByText("Install, switch and manage language runtimes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Runtime" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search runtimes" })).toBeInTheDocument();
  });

  it("still renders the legacy right slot for pages that have not moved yet", () => {
    render(
      <PageHeader
        title="Settings"
        description="Stored in config.toml."
        right={<span>Unsaved changes</span>}
      />,
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("renders no extra row when there is nothing to put beside or below the title", () => {
    const { container } = render(<PageHeader title="Logs" />);

    expect(screen.getByText("Logs")).toBeInTheDocument();
    // The header holds its title row and nothing else.
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });
});
