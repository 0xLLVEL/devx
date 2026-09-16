import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResourcePanel } from "@/components/resource-panel";
import { renderWithProviders } from "@/test/render";

/**
 * §40 system resources. The panel may only draw what the backend measures:
 * the services' own CPU and memory, and the size of the managed directories.
 * There is no machine-wide sampler and no disk capacity in the IPC surface, so
 * there is no gauge that would need one.
 */

const GIB = 1024 ** 3;

function renderPanel(overrides: Partial<Parameters<typeof ResourcePanel>[0]> = {}) {
  return renderWithProviders(
    <ResourcePanel
      cpuPercent={12}
      runningCount={2}
      memoryBytes={512 * 1024 ** 2}
      processCount={5}
      metricsPending={false}
      metricsFailed={false}
      disk={[
        { label: "runtimes", size_bytes: 2 * GIB },
        { label: "logs", size_bytes: 128 * 1024 ** 2 },
      ]}
      diskPending={false}
      diskFailed={false}
      portsClaimed={14}
      portsActive={11}
      portsPending={false}
      {...overrides}
    />,
  );
}

describe("ResourcePanel", () => {
  it("attributes the CPU figure to the supervised services", () => {
    renderPanel();

    expect(screen.getByText("Services CPU")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(
      screen.getByText("Mean across 2 running services, one core = 100%."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Services CPU" }),
    ).toHaveAttribute("aria-valuenow", "12");
  });

  it("shows memory and the process count behind it", () => {
    renderPanel();

    expect(screen.getByText("Services memory")).toBeInTheDocument();
    expect(screen.getByText("512 MB")).toBeInTheDocument();
    expect(screen.getByText("Resident across 5 processes.")).toBeInTheDocument();
  });

  it("lists every managed directory with its real size", () => {
    renderPanel();

    expect(screen.getByText("runtimes")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB")).toBeInTheDocument();
    expect(screen.getByText("logs")).toBeInTheDocument();
    expect(screen.getByText("128 MB")).toBeInTheDocument();
    // The total is the sum of what is listed, not a capacity figure.
    expect(screen.getByText("Managed storage")).toBeInTheDocument();
    expect(screen.getByText("2.1 GB")).toBeInTheDocument();
  });

  it("says it is measuring while the disk walk is still running", () => {
    renderPanel({ disk: [], diskPending: true });

    expect(screen.getByText("Measuring…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing stored in the managed directories yet.")).not.toBeInTheDocument();
  });

  it("admits when the managed directories cannot be read", () => {
    renderPanel({ disk: [], diskPending: false, diskFailed: true });

    expect(screen.getByText("Could not read disk usage.")).toBeInTheDocument();
  });

  it("says there is nothing stored rather than showing an invented zero", () => {
    renderPanel({ disk: [] });

    expect(
      screen.getByText("Nothing stored in the managed directories yet."),
    ).toBeInTheDocument();
  });

  it("reports the ports the backend claims, with the ones actually bound", () => {
    renderPanel();

    expect(screen.getByText("Ports claimed")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(
      screen.getByText("11 of 14 bound by a running service."),
    ).toBeInTheDocument();
  });

  it("shows no port figure when the port map is unavailable", () => {
    renderPanel({ portsClaimed: null, portsActive: null });

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Port map unavailable.")).toBeInTheDocument();
  });

  it("explains a CPU mean of zero instead of implying an idle machine", () => {
    renderPanel({ cpuPercent: 0, runningCount: 0, processCount: 0, memoryBytes: 0 });

    expect(screen.getByText("No service is running.")).toBeInTheDocument();
    expect(screen.getByText("No process is running.")).toBeInTheDocument();
  });

  it("does not report a failed metrics read as zero CPU and zero memory", () => {
    // §131 Rule 17: the caller passes 0 when the sample is missing, so the
    // panel must say the read failed rather than print an invented zero.
    renderPanel({
      cpuPercent: 0,
      memoryBytes: 0,
      processCount: 0,
      runningCount: 0,
      metricsFailed: true,
    });

    expect(
      screen.getByText("Could not read the service metrics."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("0 KB")).not.toBeInTheDocument();
    expect(screen.queryByText("No service is running.")).not.toBeInTheDocument();
    expect(screen.queryByText("No process is running.")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Services CPU" })).not.toBeInTheDocument();
  });

  it("says it is still reading the metrics rather than showing a zero", () => {
    renderPanel({ cpuPercent: 0, memoryBytes: 0, metricsPending: true });

    expect(screen.getByText("Reading the service metrics…")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("tells a port map that has not answered apart from one that is unavailable", () => {
    renderPanel({ portsClaimed: null, portsActive: null, portsPending: true });

    expect(screen.getByText("Reading the port map…")).toBeInTheDocument();
    expect(screen.queryByText("Port map unavailable.")).not.toBeInTheDocument();
  });
});
