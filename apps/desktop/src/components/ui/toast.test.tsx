import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { TOAST_DURATION, useToast } from "@/components/ui/toast";
import { renderWithProviders } from "@/test/render";

/** A pair of buttons, because a toast is always someone else's side effect. */
function Trigger() {
  const toast = useToast();
  return (
    <>
      <Button onClick={() => toast.success("Backup restored")}>succeed</Button>
      <Button
        onClick={() =>
          toast.error("Restore failed", {
            description: "mariadb refused the file",
            details: "ERROR 1045 (28000): Access denied",
          })
        }
      >
        fail
      </Button>
      <Button onClick={() => toast.warning("Kept until dismissed", { duration: null })}>
        sticky
      </Button>
    </>
  );
}

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it("dismisses a success on the §36 short duration", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "succeed" }));
    });
    expect(screen.getByText("Backup restored")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.success + 100);
    });
    expect(screen.queryByText("Backup restored")).not.toBeInTheDocument();
  });

  it("keeps an error long enough to be read", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "fail" }));
    });

    // Still there well past the success lifetime...
    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.success + 100);
    });
    expect(screen.getByText("Restore failed")).toBeInTheDocument();

    // ...and gone once its own duration elapses.
    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.error);
    });
    expect(screen.queryByText("Restore failed")).not.toBeInTheDocument();
  });

  it("announces errors assertively and everything else politely", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "fail" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Restore failed");
  });

  it("shows the cause behind View Details, and stops counting down while it is open", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "fail" }));
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /view details/i }));
    });
    expect(screen.getByText(/Access denied/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.error * 3);
    });
    expect(screen.getByText("Restore failed")).toBeInTheDocument();
  });

  it("honours a null duration", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "sticky" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("Kept until dismissed")).toBeInTheDocument();
  });

  it("dismisses on request", async () => {
    const user = setup();
    renderWithProviders(<Trigger />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "sticky" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /dismiss notification/i }));
    });

    expect(screen.queryByText("Kept until dismissed")).not.toBeInTheDocument();
  });
});
