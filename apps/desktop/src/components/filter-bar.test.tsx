import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterBar, type ActiveFilter } from "@/components/filter-bar";

function filter(id: string, label: string, value: string): ActiveFilter {
  return { id, label, value, onClear: vi.fn() };
}

describe("FilterBar", () => {
  it("shows no chips and no Clear filters while every filter is at its default", () => {
    render(
      <FilterBar active={[]} onClear={vi.fn()}>
        <button type="button">All types</button>
      </FilterBar>,
    );

    expect(screen.getByRole("button", { name: "All types" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("names the active filter in a chip that clears it on its own", async () => {
    const user = userEvent.setup();
    const running = filter("state", "State", "Running");

    render(
      <FilterBar active={[running]} onClear={vi.fn()}>
        <button type="button">All types</button>
      </FilterBar>,
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
    // One active filter is removable from its own chip, so §61 does not stack
    // a second control on top of it.
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear State filter" }));
    expect(running.onClear).toHaveBeenCalledTimes(1);
  });

  it("offers Clear filters once more than one filter is stacked", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(
      <FilterBar
        active={[filter("engine", "Engine", "MariaDB"), filter("state", "State", "Running")]}
        onClear={onClear}
      >
        <button type="button">All types</button>
      </FilterBar>,
    );

    expect(screen.getByText("MariaDB")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
