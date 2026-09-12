import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServicesPage } from "@/routes/services";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  installedVersions: vi.fn(),
  serviceComponentIds: vi.fn(),
  serviceStart: vi.fn(),
  serviceStop: vi.fn(),
  serviceStatus: vi.fn(),
  serviceLogs: vi.fn(),
  phpPoolList: vi.fn(),
  phpPoolStart: vi.fn(),
  phpPoolStop: vi.fn(),
  phpPoolStatus: vi.fn(),
  phpPoolLogs: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

describe("ServicesPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.serviceLogs.mockResolvedValue([]);
    mocks.serviceStatus.mockResolvedValue({ id: "mailpit", state: "stopped" });
    mocks.phpPoolList.mockResolvedValue([]);
    mocks.phpPoolLogs.mockResolvedValue([]);
    mocks.serviceComponentIds.mockResolvedValue([
      "nginx",
      "mariadb",
      "postgresql",
      "redis",
      "mailpit",
      "minio",
      "meilisearch",
    ]);
  });

  it("prompts to install when nothing supervisable is present", async () => {
    mocks.installedVersions.mockResolvedValue([]);

    renderWithProviders(<ServicesPage />);

    expect(
      await screen.findByText(/no supervisable service is installed/i),
    ).toBeInTheDocument();
  });

  it("shows a start control for an installed supervisable service", async () => {
    mocks.installedVersions.mockResolvedValue([
      { component_id: "mailpit", version: "1.31.1", path: "C:\\devx\\mailpit" },
    ]);

    renderWithProviders(<ServicesPage />);

    expect(await screen.findByText("mailpit")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("starts the service through the start command", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([
      { component_id: "mailpit", version: "1.31.1", path: "C:\\devx\\mailpit" },
    ]);
    mocks.serviceStart.mockResolvedValue({ id: "mailpit", state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /start/i }));

    await waitFor(() =>
      expect(mocks.serviceStart).toHaveBeenCalledTimes(1),
    );
    expect(mocks.serviceStart.mock.calls[0]?.slice(0, 2)).toEqual([
      "mailpit",
      "1.31.1",
    ]);
  });

  it("does not list components that cannot be supervised yet", async () => {
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\php" },
    ]);

    renderWithProviders(<ServicesPage />);

    expect(
      await screen.findByText(/no supervisable service is installed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("php")).not.toBeInTheDocument();
  });

  it("shows a startable card for each installed PHP pool", async () => {
    mocks.phpPoolList.mockResolvedValue([
      {
        id: "php-pool-8.4.25",
        version: "8.4.25",
        workers: 4,
        port: 9100,
        state: "stopped",
      },
    ]);

    renderWithProviders(<ServicesPage />);

    expect(await screen.findByText("PHP 8.4.25")).toBeInTheDocument();
    expect(screen.getByText(/fastcgi pool · 4 workers/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("starts a PHP pool with its configured worker count", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([
      {
        id: "php-pool-8.4.25",
        version: "8.4.25",
        workers: 4,
        port: 9100,
        state: "stopped",
      },
    ]);
    mocks.phpPoolStart.mockResolvedValue({
      id: "php-pool-8.4.25",
      version: "8.4.25",
      workers: 4,
      port: 9100,
      state: "running",
    });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /start/i }));

    await waitFor(() => expect(mocks.phpPoolStart).toHaveBeenCalledTimes(1));
    expect(mocks.phpPoolStart).toHaveBeenCalledWith("8.4.25", 4);
  });
});
