import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComponentsPage } from "@/routes/components";
import { componentSummaryFixture, versionListingFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  catalogList: vi.fn(),
  componentVersions: vi.fn(),
  componentInstall: vi.fn(),
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

    expect(await screen.findByText("Runtimes")).toBeInTheDocument();
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
});
