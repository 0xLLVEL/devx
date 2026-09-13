import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "@/routes/dashboard";
import { renderWithProviders } from "@/test/render";

const appInfo = vi.hoisted(() => vi.fn());
const siteList = vi.hoisted(() => vi.fn());
const serviceMetrics = vi.hoisted(() => vi.fn());
const caStatus = vi.hoisted(() => vi.fn());
const dnsStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: { appInfo, siteList, serviceMetrics, caStatus, dnsStatus } };
});

describe("DashboardPage", () => {
  beforeEach(() => {
    appInfo.mockReset();
    siteList.mockReset().mockResolvedValue([]);
    serviceMetrics.mockReset().mockResolvedValue([]);
    caStatus.mockReset().mockResolvedValue({ exists: true, trusted: null });
    dnsStatus.mockReset().mockResolvedValue({
      running: false,
      port: null,
      nrpt_active: null,
      suffix: "test",
    });
  });

  it("renders build metadata returned by the app_info command", async () => {
    appInfo.mockResolvedValue({
      name: "DevX",
      version: "0.1.0",
      target: "x86_64-pc-windows-msvc",
      debug: true,
    });

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();
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
    expect(screen.getByText(/12% ·/)).toBeInTheDocument();
    expect(screen.getAllByText(/512 MB/).length).toBeGreaterThan(0);
    expect(screen.getByText("php-pool-8.4.25")).toBeInTheDocument();
  });

  it("celebrates when every supervised service is running", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 5,
        memory_bytes: 256 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "nginx",
        state: "running",
        cpu_percent: 1,
        memory_bytes: 8 * 1024 * 1024,
        processes: 1,
      },
    ]);

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("Everything is running smoothly.")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("shows a health score from the live signals", async () => {
    dnsStatus.mockResolvedValue({
      running: true,
      port: 9353,
      nrpt_active: true,
      suffix: "test",
    });
    caStatus.mockResolvedValue({ exists: true, trusted: true });

    renderWithProviders(<DashboardPage />);

    // No services yet, but DNS + CA both healthy: (100 + 100) / 2 = 100.
    expect(await screen.findByText("100")).toBeInTheDocument();
  });
});
