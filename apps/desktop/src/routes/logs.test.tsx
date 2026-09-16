import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LogsPage } from "@/routes/logs";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  logsList: vi.fn(),
  logsRead: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const file = (fileName: string, overrides: Record<string, unknown> = {}) => ({
  file_name: fileName,
  service_id: fileName.replace(/\.log.*$/, ""),
  rotated: false,
  size_bytes: 2048,
  ...overrides,
});

const content = (lines: string[], truncated = false) => ({
  file_name: "devx.log",
  lines,
  truncated,
});

describe("LogsPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.logsList.mockResolvedValue([file("devx.log")]);
    mocks.logsRead.mockResolvedValue(content(["INFO boot", "ERROR boom"]));
  });

  it("points at the action that produces logs when none exist (§38)", async () => {
    mocks.logsList.mockResolvedValue([]);

    renderWithProviders(<LogsPage />);

    expect(await screen.findByText("No logs yet.")).toBeInTheDocument();
    expect(screen.getByText("Start a service to produce output.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Services" })).toHaveAttribute(
      "href",
      "/services",
    );
    // The reader never offers a file to select when the list is empty.
    expect(screen.getByText("No log file to read yet.")).toBeInTheDocument();
    expect(mocks.logsRead).not.toHaveBeenCalled();
  });

  it("keeps the right panel in a loading state while the list is read (§121)", async () => {
    // The list resolves late, so the pending render is observable.
    let release: (entries: unknown[]) => void = () => {};
    mocks.logsList.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderWithProviders(<LogsPage />);

    expect(screen.getAllByText("Loading logs…")).toHaveLength(2);
    // Not the empty state: nothing has been read yet.
    expect(screen.queryByText("No log file to read yet.")).not.toBeInTheDocument();

    release([file("devx.log")]);
    expect(await screen.findByText("INFO boot")).toBeInTheDocument();
  });

  it("offers a retry on both panels when the list cannot be read (§39)", async () => {
    mocks.logsList.mockRejectedValueOnce(new Error("logs directory missing"));

    renderWithProviders(<LogsPage />);

    expect(
      await screen.findByText("Could not read the log file list."),
    ).toBeInTheDocument();
    expect(screen.getByText("logs directory missing")).toBeInTheDocument();
    expect(screen.getByText("Nothing to read here yet.")).toBeInTheDocument();

    // Both "Try again" buttons drive the same query; the second read succeeds.
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[1]!);

    await waitFor(() => expect(mocks.logsList).toHaveBeenCalledTimes(2));
    // With the list back, the first file is read without a second click.
    expect(await screen.findByText("INFO boot")).toBeInTheDocument();
  });

  it("clears the filters from the filter-miss empty state (§38)", async () => {
    mocks.logsRead.mockResolvedValue(content(["INFO boot", "ERROR boom"]));

    renderWithProviders(<LogsPage />);

    await userEvent.type(
      await screen.findByRole("textbox", { name: /search in devx\.log/i }),
      "nothing-matches-this",
    );

    expect(
      await screen.findByText("No lines match the current search and level filter."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("INFO boot")).toBeInTheDocument();
    expect(screen.queryByText(/no lines match/i)).not.toBeInTheDocument();
  });
});
