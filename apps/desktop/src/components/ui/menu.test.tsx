import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  OverflowMenu,
  useContextMenu,
  type MenuItem,
} from "@/components/ui/menu";

function items(overrides: Partial<MenuItem> = {}): MenuItem[] {
  return [
    { id: "folder", label: "Open folder", onSelect: vi.fn(), ...overrides },
    { id: "remove", label: "Remove site", destructive: true, onSelect: vi.fn() },
  ];
}

describe("OverflowMenu", () => {
  it("keeps the panel out of the DOM until the trigger is used", async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions" items={items()} />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("names the icon-only trigger on hover", async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions" items={items()} />);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "More actions" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("More actions");
  });

  it("runs the entry that was picked and closes the panel", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const entries = items();
    entries[0]!.onSelect = onSelect;
    render(<OverflowMenu label="More actions" items={entries} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Focus returns to the trigger rather than being dropped on the body.
    expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus();
  });

  it("closes on Escape and on a click outside the panel", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Elsewhere</button>
        <OverflowMenu label="More actions" items={items()} />
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("moves focus between entries with the arrow keys and skips disabled ones", async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        label="More actions"
        items={[
          { id: "start", label: "Start", onSelect: vi.fn() },
          { id: "stop", label: "Stop", disabled: true, onSelect: vi.fn() },
          { id: "logs", label: "Logs", onSelect: vi.fn() },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    screen.getByRole("menuitem", { name: "Start" }).focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Logs" })).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Start" })).toHaveFocus();
  });

  it("opens with the keyboard, starting at the first entry", async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions" items={items()} />);

    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open folder" })).toHaveFocus(),
    );
  });

  it("does not run a disabled entry", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu
        label="More actions"
        items={[{ id: "start", label: "Start", disabled: true, onSelect }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Start" }));

    expect(onSelect).not.toHaveBeenCalled();
  });
});

/** The entity a §47 context menu is attached to. */
function Entity({ items }: { items: readonly MenuItem[] }) {
  const menu = useContextMenu({ label: "Actions for myapp.test", items });
  return (
    <div>
      <button type="button">Row button</button>
      <div data-testid="entity" onContextMenu={menu.onContextMenu}>
        myapp.test
        {menu.panel}
      </div>
    </div>
  );
}

describe("useContextMenu", () => {
  it("stays out of the DOM until the entity is right-clicked", () => {
    render(<Entity items={items()} />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens at the pointer, replacing the browser's own menu", async () => {
    render(<Entity items={items()} />);

    const returned = fireEvent.contextMenu(screen.getByTestId("entity"), {
      clientX: 120,
      clientY: 90,
    });

    // `fireEvent` returns false when the handler called `preventDefault`.
    expect(returned).toBe(false);
    const panel = await screen.findByRole("menu", { name: "Actions for myapp.test" });
    expect(panel).toHaveStyle({ left: "120px", top: "90px" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    // The destructive entry keeps its own tone and its place at the bottom.
    expect(screen.getByRole("menuitem", { name: "Remove site" })).toHaveClass(
      "text-destructive",
    );
  });

  it("puts focus on the first entry so the keyboard works without a second click", async () => {
    render(<Entity items={items()} />);

    fireEvent.contextMenu(screen.getByTestId("entity"));

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open folder" })).toHaveFocus(),
    );
  });

  it("runs the entry that was picked and closes the panel", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const entries = items();
    entries[0]!.onSelect = onSelect;
    render(<Entity items={entries} />);

    fireEvent.contextMenu(screen.getByTestId("entity"));
    await user.click(await screen.findByRole("menuitem", { name: "Open folder" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and hands focus back where it was", async () => {
    const user = userEvent.setup();
    render(<Entity items={items()} />);

    const elsewhere = screen.getByRole("button", { name: "Row button" });
    elsewhere.focus();
    fireEvent.contextMenu(screen.getByTestId("entity"));
    // Escape is answered by the panel, so the panel has to hold focus first.
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open folder" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(elsewhere).toHaveFocus();
  });

  it("closes when the user clicks away or scrolls", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Elsewhere</button>
        <Entity items={items()} />
      </div>,
    );

    const entity = screen.getByTestId("entity");
    fireEvent.contextMenu(entity);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(entity);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    fireEvent.scroll(window);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
