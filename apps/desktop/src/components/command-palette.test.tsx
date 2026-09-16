import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/command-palette";
import type { Command } from "@/lib/commands";
import { renderWithProviders } from "@/test/render";

function command(overrides: Partial<Command> & Pick<Command, "id" | "title">): Command {
  return {
    group: "Navigation",
    icon: () => null,
    keywords: [],
    run: () => {},
    ...overrides,
  } as Command;
}

const commands: Command[] = [
  command({ id: "nav:terminal", title: "Terminal", keywords: ["shell"] }),
  command({ id: "nav:databases", title: "Databases", keywords: ["sql"] }),
  command({
    id: "services:start-all",
    title: "Start all services",
    group: "Services",
    keywords: ["up"],
  }),
];

const searchBox = () => screen.getByPlaceholderText(/type a command/i);

describe("CommandPalette", () => {
  it("renders nothing while it is closed", () => {
    renderWithProviders(
      <CommandPalette open={false} onClose={() => {}} commands={commands} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("groups commands and focuses the search input on open", () => {
    renderWithProviders(<CommandPalette open onClose={() => {}} commands={commands} />);

    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("Services")).toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
  });

  it("filters fuzzily, by name and by keyword", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette open onClose={() => {}} commands={commands} />);

    await user.type(searchBox(), "term");
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.queryByText("Databases")).not.toBeInTheDocument();

    // Keyword matching reaches items whose name does not contain the query.
    await user.clear(searchBox());
    await user.type(searchBox(), "sql");
    expect(screen.getByText("Databases")).toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette open onClose={() => {}} commands={commands} />);

    await user.type(searchBox(), "zzzz");

    expect(screen.getByText(/No command matches/i)).toBeInTheDocument();
  });

  it("moves the selection with the arrow keys and runs it with Enter", async () => {
    const user = userEvent.setup();
    const alpha = vi.fn();
    const beta = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <CommandPalette
        open
        onClose={onClose}
        commands={[
          command({ id: "a", title: "Alpha", run: alpha }),
          command({ id: "b", title: "Beta", run: beta }),
        ]}
      />,
    );

    await user.keyboard("{ArrowDown}{Enter}");

    expect(alpha).not.toHaveBeenCalled();
    expect(beta).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("runs the first command on Enter", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <CommandPalette
        open
        onClose={onClose}
        commands={[command({ id: "a", title: "Alpha", run })]}
      />,
    );

    await user.keyboard("{Enter}");

    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette open onClose={onClose} commands={commands} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside the panel, but not inside it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette open onClose={onClose} commands={commands} />);

    const panel = screen.getByRole("dialog", { name: /command palette/i });
    await user.click(panel);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(panel.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
