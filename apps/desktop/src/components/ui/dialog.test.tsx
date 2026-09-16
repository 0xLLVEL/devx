import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { renderWithProviders } from "@/test/render";

/**
 * The shared modal (§34). Behaviour under test: nothing exists in the DOM
 * while closed, the safe action holds focus, and both routes out of the dialog
 * report back to the caller.
 */
describe("Dialog", () => {
  it("is absent from the document while closed", () => {
    renderWithProviders(
      <Dialog open={false} onClose={() => {}} title="Hidden">
        body
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
  });

  it("renders its title, description and content when open", () => {
    renderWithProviders(
      <Dialog
        open
        onClose={() => {}}
        title="Install runtime"
        description="Downloaded once, then reused."
        footer={<Button>Install</Button>}
      >
        <p>PHP 8.3.12</p>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Install runtime");
    expect(screen.getByText("Downloaded once, then reused.")).toBeInTheDocument();
    expect(screen.getByText("PHP 8.3.12")).toBeInTheDocument();
  });

  it("closes from the header button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <Dialog open onClose={onClose} title="Install runtime">
        body
      </Dialog>,
    );

    await user.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  beforeEach(() => {
    // jsdom has no `showModal`, so the dialog falls back to the open
    // attribute; the focus placement under test is ours either way.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Delete the backup?"
        description="The dump file is removed from disk. It cannot be restored afterwards."
        confirmLabel="Delete backup"
        destructive
      />,
    );
    return { onConfirm, onClose };
  };

  it("states the consequence instead of asking whether the user is sure", () => {
    setup();
    expect(screen.getByText(/removed from disk/i)).toBeInTheDocument();
    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument();
  });

  it("puts initial focus on Cancel, the safe choice", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("confirms through the caller's callback", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onConfirm, onClose } = setup();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete backup" }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels without confirming", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onConfirm, onClose } = setup();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
