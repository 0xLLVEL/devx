import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "@/routes/dashboard";
import { renderWithProviders } from "@/test/render";

const siteList = vi.hoisted(() => vi.fn());
const serviceMetrics = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: { siteList, serviceMetrics } };
});

describe("DashboardPage", () => {
  beforeEach(() => {
    siteList.mockReset().mockResolvedValue([]);
    serviceMetrics.mockReset().mockResolvedValue([]);
  });

  it("shows the waiting verdict when nothing is supervised yet", async () => {
    renderWithProviders(<DashboardPage />);

    expect(
      await screen.findByText("Your environment is waiting."),
    ).toBeInTheDocument();
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
    expect(screen.getAllByText("12%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/512 MB/).length).toBeGreaterThan(0);
    expect(screen.getByText("php-pool-8.4.25")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
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

    expect(await screen.findByText("Everything is running.")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("leads with the failed verdict when a service is down", async () => {
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
        state: "failed",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("1 service failed.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "nginx is failing. Check its log on the Services page and restart it.",
    );
  });

  it("sorts failed services above running ones in the service board", async () => {
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
        state: "failed",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderWithProviders(<DashboardPage />);

    const mariadb = await screen.findByText("mariadb");
    const nginx = screen.getByText("nginx");
    expect(
      nginx.compareDocumentPosition(mariadb) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
