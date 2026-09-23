import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComponentsPage } from "@/routes/components";
import { componentSummaryFixture, versionListingFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  catalogList: vi.fn(),
  componentVersions: vi.fn(),
  componentInstall: vi.fn(),
  componentInstallCancel: vi.fn(),
  componentUninstall: vi.fn(),
  installedVersions: vi.fn(),
}));

// A stand-in for the generated event client: `listen` returns an unsubscribe.
const listeners = vi.hoisted(() => ({ install: vi.fn() }));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return {
    ...actual,
    ipc: mocks,
    ipcEvents: {
      installProgress: {
        listen: (handler: unknown) => {
          listeners.install(handler);
          return Promise.resolve(() => {});
        },
      },
    },
  };
});

describe("ComponentsPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.installedVersions.mockResolvedValue([]);
    mocks.catalogList.mockResolvedValue([
      componentSummaryFixture({ id: "php", name: "PHP", kind: "runtime" }),
      componentSummaryFixture({
        id: "redis",
        name: "Redis",
        kind: "cache",
        caveat: "Redis publishes no official Windows build.",
      }),
    ]);
    mocks.componentVersions.mockResolvedValue(versionListingFixture());
  });

  it("groups components by kind and selects the first by default", async () => {
    renderWithProviders(<ComponentsPage />);

    // "Runtimes" appears twice: once as the nav group header, once as the
    // detail pane's eyebrow — both intentional, so match loosely.
    expect((await screen.findAllByText("Runtimes")).length).toBeGreaterThan(0);
    expect(screen.getByText("Cache")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.componentVersions).toHaveBeenCalledWith("php"),
    );
  });

  it("lists resolved versions with their release channel", async () => {
    renderWithProviders(<ComponentsPage />);

    expect(await screen.findByText("8.4.25")).toBeInTheDocument();
    expect(screen.getByText("8.3.28")).toBeInTheDocument();
    expect(screen.getByText("LTS")).toBeInTheDocument();
    expect(screen.getAllByText("verifiable")).toHaveLength(2);
  });

  it("loads versions for a component the user selects", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    await user.click(screen.getByRole("button", { name: /redis/i }));

    await waitFor(() =>
      expect(mocks.componentVersions).toHaveBeenCalledWith("redis"),
    );
    expect(
      await screen.findByText("Redis publishes no official Windows build."),
    ).toBeInTheDocument();
  });

  it("flags cached data when the upstream could not be reached", async () => {
    mocks.componentVersions.mockResolvedValue(
      versionListingFixture({ stale: true }),
    );

    renderWithProviders(<ComponentsPage />);

    expect(
      await screen.findByText(/offline, showing cached/i),
    ).toBeInTheDocument();
  });

  it("explains versions withheld for lacking a checksum", async () => {
    mocks.componentVersions.mockResolvedValue(
      versionListingFixture({ unverifiable: ["9.0.0", "8.9.0"] }),
    );

    renderWithProviders(<ComponentsPage />);

    expect(
      await screen.findByText(/2 releases hidden because the upstream/i),
    ).toBeInTheDocument();
    expect(screen.getByText("9.0.0, 8.9.0")).toBeInTheDocument();
  });

  it("surfaces a resolution failure instead of an empty list", async () => {
    const { IpcError } = await import("@/lib/ipc");
    mocks.componentVersions.mockRejectedValue(
      new IpcError({
        code: "network",
        message: "failed to fetch releases.json",
        hint: "check your internet connection",
      }),
    );

    renderWithProviders(<ComponentsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "failed to fetch releases.json",
    );
  });

  it("installs a version through the install command", async () => {
    const user = userEvent.setup();
    mocks.componentInstall.mockResolvedValue("C:\\devx\\runtimes\\php\\8.4.25");

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    const installButtons = screen.getAllByRole("button", { name: /^install$/i });
    await user.click(installButtons[0]!);

    await waitFor(() =>
      expect(mocks.componentInstall).toHaveBeenCalledTimes(1),
    );
    expect(mocks.componentInstall.mock.calls[0]?.slice(0, 2)).toEqual([
      "php",
      "8.4.25",
    ]);
  });

  it("shows downloaded bytes of the total and the percent while downloading", async () => {
    const user = userEvent.setup();
    mocks.componentInstall.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    await user.click(screen.getAllByRole("button", { name: /^install$/i })[0]!);

    // The event handler is captured by the mocked `listen`; drive it directly.
    const handler = listeners.install.mock.calls[0]?.[0] as (event: {
      payload: { component_id: string; version: string; phase: unknown };
    }) => void;
    expect(handler).toBeDefined();

    // 15 MiB of a 30 MiB artifact = 50%.
    handler({
      payload: {
        component_id: "php",
        version: "8.4.25",
        phase: {
          stage: "downloading",
          downloaded: 15_728_640,
          total: 31_457_280,
        },
      },
    });

    expect(await screen.findByText("15.0 MiB / 30.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    // A busy row offers the cancel affordance instead of an Install button.
    expect(screen.getAllByRole("button", { name: /cancel/i }).length).toBeGreaterThan(0);
  });

  it("shows the byte count alone when the server reports no total", async () => {
    const user = userEvent.setup();
    mocks.componentInstall.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    await user.click(screen.getAllByRole("button", { name: /^install$/i })[0]!);

    const handler = listeners.install.mock.calls[0]?.[0] as (event: {
      payload: { component_id: string; version: string; phase: unknown };
    }) => void;

    handler({
      payload: {
        component_id: "php",
        version: "8.4.25",
        phase: { stage: "downloading", downloaded: 2_097_152, total: null },
      },
    });

    expect(await screen.findByText("2.0 MiB")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
  });

  it("shows a Remove button for an already-installed version", async () => {
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\php\\8.4.25" },
    ]);

    renderWithProviders(<ComponentsPage />);

    expect(await screen.findByText("installed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove/i }),
    ).toBeInTheDocument();
  });

  it("reports an install failure on the failing version row", async () => {
    const user = userEvent.setup();
    const { IpcError } = await import("@/lib/ipc");
    mocks.componentInstall.mockRejectedValue(
      new IpcError({
        code: "integrity",
        message: "checksum mismatch for php.zip",
        hint: null,
      }),
    );

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    const installButtons = screen.getAllByRole("button", { name: /^install$/i });
    await user.click(installButtons[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "checksum mismatch for php.zip",
    );
  });

  it("cancels a running install through the cancel command", async () => {
    const user = userEvent.setup();
    mocks.componentInstall.mockImplementation(() => new Promise(() => {}));
    mocks.componentInstallCancel.mockResolvedValue(true);

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    await user.click(screen.getAllByRole("button", { name: /^install$/i })[0]!);

    // Drive one downloading phase so the row enters the busy state.
    const handler = listeners.install.mock.calls[0]?.[0] as (event: {
      payload: { component_id: string; version: string; phase: unknown };
    }) => void;
    handler({
      payload: {
        component_id: "php",
        version: "8.4.25",
        phase: { stage: "downloading", downloaded: 1024, total: 31_457_280 },
      },
    });

    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(mocks.componentInstallCancel).toHaveBeenCalledWith("php", "8.4.25"),
    );
  });

  it("hides the failure alert when an install was cancelled on purpose", async () => {
    const user = userEvent.setup();
    const { IpcError } = await import("@/lib/ipc");
    mocks.componentInstall.mockRejectedValue(
      new IpcError({
        code: "process",
        message: "install cancelled",
        hint: null,
      }),
    );
    mocks.componentInstallCancel.mockResolvedValue(true);

    renderWithProviders(<ComponentsPage />);

    await screen.findByText("8.4.25");
    await user.click(screen.getAllByRole("button", { name: /^install$/i })[0]!);

    // The mutation settles with the cancellation error; the row must return
    // to its idle state without an alert.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^install$/i }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains an empty catalog instead of rendering a blank sidebar", async () => {
    mocks.catalogList.mockResolvedValue([]);

    renderWithProviders(<ComponentsPage />);

    expect(
      await screen.findByText("No components in the catalog."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The catalog this build carries lists no components, so there is nothing to install or remove.",
      ),
    ).toBeInTheDocument();
  });

  it("re-reads the catalog from its empty state (§38)", async () => {
    const user = userEvent.setup();
    mocks.catalogList.mockResolvedValueOnce([]);

    renderWithProviders(<ComponentsPage />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        screen.queryByText("No components in the catalog."),
      ).not.toBeInTheDocument(),
    );
    expect((await screen.findAllByText("PHP")).length).toBeGreaterThan(0);
    expect(mocks.catalogList).toHaveBeenCalledTimes(2);
  });

  it("does not report an unreadable install list as an empty machine", async () => {
    mocks.installedVersions.mockRejectedValue(new Error("failed to read runtimes"));

    renderWithProviders(<ComponentsPage />);

    expect(
      await screen.findByText("Could not read the installed versions."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/0 versions installed on this machine/i),
    ).not.toBeInTheDocument();
  });

  it("confirms before removing an installed version", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\php\\8.4.25" },
    ]);

    renderWithProviders(<ComponentsPage />);

    await user.click(await screen.findByRole("button", { name: /remove/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove php 8.4.25?")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remove version" }));

    await waitFor(() => expect(mocks.componentUninstall).toHaveBeenCalledTimes(1));
    expect(mocks.componentUninstall.mock.calls[0]?.slice(0, 2)).toEqual([
      "php",
      "8.4.25",
    ]);
  });
});
