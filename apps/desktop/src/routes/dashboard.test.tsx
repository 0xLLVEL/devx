import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "@/routes/dashboard";
import { renderWithProviders } from "@/test/render";

const appInfo = vi.hoisted(() => vi.fn());
const siteList = vi.hoisted(() => vi.fn());
const serviceMetrics = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: { appInfo, siteList, serviceMetrics } };
});

describe("DashboardPage", () => {
  beforeEach(() => {
    appInfo.mockReset();
    siteList.mockReset().mockResolvedValue([]);
    serviceMetrics.mockReset().mockResolvedValue([]);
  });

  it("renders build metadata returned by the app_info command", async () => {
    appInfo.mockResolvedValue({
      name: "DevX",
      version: "0.1.0",
      target: "x86_64-pc-windows-msvc",
      debug: true,
    });

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("x86_64-pc-windows-msvc")).toBeInTheDocument();
    expect(screen.getByText("debug")).toBeInTheDocument();
  });

  it("surfaces a failed command instead of rendering empty state", async () => {
    const { IpcError } = await import("@/lib/ipc");
    appInfo.mockRejectedValue(
      new IpcError({
        code: "internal",
        message: "backend unavailable",
        hint: null,
      }),
    );

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "backend unavailable",
    );
  });

  it("lists supervised services with their live resource use", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 12,
        memory_bytes: 512 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "php-pool-8.4.25",
        state: "stopped",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("mariadb")).toBeInTheDocument();
    expect(screen.getByText(/12% CPU/)).toBeInTheDocument();
    expect(screen.getByText(/512 MB/)).toBeInTheDocument();
    expect(screen.getByText("php-pool-8.4.25")).toBeInTheDocument();
  });
});
