import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TerminalDrawer,
  TERMINAL_DRAWER_DEFAULT_HEIGHT,
  TERMINAL_DRAWER_MIN_HEIGHT,
  terminalDrawerMaxHeight,
} from "@/components/terminal-drawer";
import { TerminalSessionProvider } from "@/lib/terminal-session";

/**
 * The bottom terminal drawer (§31): 280px by default, resizable 180px → 70vh,
 * with a full-screen option. The session underneath is the same one the
 * `/terminal` page reads; that shared-ownership half is covered in
 * `app-shell.test.tsx`, where both surfaces exist.
 */

type TerminalEvent = {
  payload: { run_id: number; stream: string; text: string };
};

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  terminalPath: vi.fn(),
  terminalRun: vi.fn(),
  listeners: [] as ((event: TerminalEvent) => void)[],
  /** Set when the event bus itself is unavailable. */
  streamUnavailable: false,
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return {
    ...actual,
    ipc: {
      siteList: mocks.siteList,
      terminalPath: mocks.terminalPath,
      terminalRun: mocks.terminalRun,
    },
    ipcEvents: {
      terminalOutput: {
        listen: (listener: (event: TerminalEvent) => void) => {
          if (mocks.streamUnavailable) {
            return Promise.reject(new Error("no event bus"));
          }
          mocks.listeners.push(listener);
          return Promise.resolve(() => {
            mocks.listeners.length = 0;
          });
        },
      },
    },
  };
});

/** Pushes one line out of the backend's output stream. */
function emit(line: { run_id: number; stream: string; text: string }) {
  for (const listener of mocks.listeners) {
    listener({ payload: line });
  }
}

/** jsdom's viewport is a getter; tests that care about 70vh set it themselves. */
function setViewportHeight(value: number) {
  Object.defineProperty(window, "innerHeight", {
    value,
    configurable: true,
    writable: true,
  });
}

function renderDrawer({ open = true }: { open?: boolean } = {}) {
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TerminalSessionProvider>
        <TerminalDrawer open={open} onClose={onClose} />
      </TerminalSessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

const drawer = () => screen.getByRole("region", { name: "Terminal" });

describe("TerminalDrawer", () => {
  beforeEach(() => {
    for (const mock of [mocks.siteList, mocks.terminalPath, mocks.terminalRun]) {
      mock.mockReset();
    }
    mocks.listeners.length = 0;
    setViewportHeight(768);
    mocks.siteList.mockResolvedValue([
      { hostname: "myapp.test", docroot: "C:\\dev\\myapp\\public" },
    ]);
    mocks.terminalPath.mockResolvedValue("C:\\devx\\bin;C:\\Windows");
  });

  it("is absent from the DOM until it is opened", () => {
    renderDrawer({ open: false });

    expect(screen.queryByRole("region", { name: "Terminal" })).not.toBeInTheDocument();
    // No console either: a closed drawer must not keep a terminal running
    // behind the user's back.
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();
  });

  it("opens at §31's 280px, with the bounds written down", async () => {
    renderDrawer();

    expect(drawer()).toHaveStyle({ height: `${TERMINAL_DRAWER_DEFAULT_HEIGHT}px` });

    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    expect(handle).toHaveAttribute("aria-valuenow", String(TERMINAL_DRAWER_DEFAULT_HEIGHT));
    expect(handle).toHaveAttribute("aria-valuemin", String(TERMINAL_DRAWER_MIN_HEIGHT));
    expect(handle).toHaveAttribute("aria-valuemax", String(terminalDrawerMaxHeight()));
    // §55: the size is a state the user can read, not just a pixel count.
    expect(screen.getByText(/280px tall/)).toBeInTheDocument();

    // The console is the same one the Terminal page shows.
    await waitFor(() =>
      expect(screen.getByLabelText("Working directory")).toHaveValue(
        "C:\\dev\\myapp\\public",
      ),
    );
    expect(await screen.findByText("2 directories on PATH")).toBeInTheDocument();
  });

  it("resizes by dragging the top edge and stops at 180px and 70vh", () => {
    renderDrawer();
    const handle = screen.getByRole("separator", { name: "Resize terminal" });

    fireEvent.pointerDown(handle, { clientY: 500 });
    fireEvent.pointerMove(window, { clientY: 440 });
    // Dragging up makes it taller.
    expect(drawer()).toHaveStyle({ height: "340px" });

    fireEvent.pointerMove(window, { clientY: 0 });
    expect(drawer()).toHaveStyle({ height: `${terminalDrawerMaxHeight()}px` });

    fireEvent.pointerMove(window, { clientY: 4000 });
    expect(drawer()).toHaveStyle({ height: `${TERMINAL_DRAWER_MIN_HEIGHT}px` });

    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientY: 100 });
    // The drag ended with the button: later mouse movement is not a resize.
    expect(drawer()).toHaveStyle({ height: `${TERMINAL_DRAWER_MIN_HEIGHT}px` });
  });

  it("resizes from the keyboard as well", async () => {
    const user = userEvent.setup();
    renderDrawer();

    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    handle.focus();

    await user.keyboard("{ArrowUp}");
    expect(drawer()).toHaveStyle({ height: "304px" });
    await user.keyboard("{ArrowDown}");
    expect(drawer()).toHaveStyle({ height: "280px" });

    await user.keyboard("{End}");
    expect(drawer()).toHaveStyle({ height: `${terminalDrawerMaxHeight()}px` });
    await user.keyboard("{Home}");
    expect(drawer()).toHaveStyle({ height: `${TERMINAL_DRAWER_MIN_HEIGHT}px` });
  });

  it("comes back inside its ceiling when the window shrinks", () => {
    renderDrawer();

    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    fireEvent.pointerDown(handle, { clientY: 500 });
    fireEvent.pointerMove(window, { clientY: -2000 });
    fireEvent.pointerUp(window);
    expect(drawer()).toHaveStyle({ height: `${terminalDrawerMaxHeight()}px` });

    // 70vh of a 400px window is 280px: the panel that filled the old window
    // must not hang off the bottom of the new one.
    setViewportHeight(400);
    fireEvent(window, new Event("resize"));

    expect(drawer()).toHaveStyle({ height: "280px" });
  });

  it("fills the window when maximized and gives the height back when restored", async () => {
    const user = userEvent.setup();
    renderDrawer();

    const maximize = screen.getByRole("button", { name: "Full screen terminal" });
    expect(maximize).toHaveAttribute("aria-pressed", "false");

    await user.click(maximize);

    expect(maximize).toHaveAttribute("aria-pressed", "true");
    expect(drawer()).toHaveClass("top-0");
    expect(drawer().style.height).toBe("");
    // Nothing to drag while it is already as tall as the window.
    expect(
      screen.queryByRole("separator", { name: "Resize terminal" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("full screen")).toBeInTheDocument();

    await user.click(maximize);

    expect(drawer()).toHaveStyle({ height: `${TERMINAL_DRAWER_DEFAULT_HEIGHT}px` });
    expect(
      screen.getByRole("separator", { name: "Resize terminal" }),
    ).toBeInTheDocument();
  });

  it("closes from its own button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();

    await user.click(screen.getByRole("button", { name: "Close the terminal" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs a command and streams the output into the transcript", async () => {
    const user = userEvent.setup();
    mocks.terminalRun.mockImplementation(async () => {
      emit({ run_id: 1, stream: "stdout", text: "PHP 8.4.25 (cli)" });
      return { run_id: 1, code: 0 };
    });

    renderDrawer();

    await user.type(await screen.findByLabelText("Command"), "php -v");
    await user.click(screen.getByRole("button", { name: /^run$/i }));

    // The echo, the streamed line and the exit badge all belong to the run.
    expect(await screen.findByText("> php -v")).toBeInTheDocument();
    expect(screen.getByText("PHP 8.4.25 (cli)")).toBeInTheDocument();
    expect(await screen.findByText("exit code 0")).toBeInTheDocument();
    expect(mocks.terminalRun).toHaveBeenCalledWith(
      "C:\\dev\\myapp\\public",
      "php -v",
    );

    // Clear empties what is on screen; the history stays.
    await user.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(screen.queryByText("PHP 8.4.25 (cli)")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /previous command/i })).toBeInTheDocument();
  });

  it("says so when the backend cannot stream output at all", async () => {
    // §131 Rule 18: a console that will never receive a line must not look
    // like a command that printed nothing.
    mocks.streamUnavailable = true;

    renderDrawer();

    // §39: the callout names the fault and keeps the backend's own text as its
    // detail, so both halves are asserted.
    expect(
      await screen.findByText("Output is not streaming."),
    ).toBeInTheDocument();
    expect(screen.getByText(/no event bus/i)).toBeInTheDocument();
    mocks.streamUnavailable = false;
  });
});
