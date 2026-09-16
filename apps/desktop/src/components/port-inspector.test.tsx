import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortInspectorButton } from "@/components/port-inspector";
import { IpcError } from "@/lib/ipc";
import { renderWithProviders } from "@/test/render";

/**
 * §110 Port Inspector.
 *
 * Two things are being held to account here beyond the happy path: that the
 * dialog never presents the machine's ports as DevX's, and that nothing is
 * stopped before the user has confirmed it by name.
 */

const mocks = vi.hoisted(() => ({
  listeningPorts: vi.fn(),
  portMap: vi.fn(),
  stopProcessOnPort: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const NGINX = { port: 80, pid: 8124, process_name: "nginx.exe" };
const MYSQLD = { port: 3306, pid: 9021, process_name: "mysqld.exe" };
const UNNAMED = { port: 443, pid: 4, process_name: null };

/** Opens the inspector through the button the product actually ships. */
async function openInspector(user = userEvent.setup()) {
  renderWithProviders(<PortInspectorButton />);
  await user.click(screen.getByRole("button", { name: "Inspect ports" }));
  return user;
}

/** The row of the port table for `port`. */
async function row(port: number): Promise<HTMLElement> {
  const cell = await screen.findByText(String(port));
  return cell.closest("tr") as HTMLElement;
}

describe("PortInspector", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.listeningPorts.mockResolvedValue([]);
    mocks.portMap.mockResolvedValue([]);
    mocks.stopProcessOnPort.mockResolvedValue(null);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("reads the listener table only once the dialog is open", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PortInspectorButton />);

    // Closed: the inspector costs nothing and shows nothing.
    expect(mocks.listeningPorts).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspect ports" }));

    await waitFor(() => expect(mocks.listeningPorts).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Port inspector");
  });

  it("lists every listening port with its process and PID", async () => {
    mocks.listeningPorts.mockResolvedValue([NGINX, MYSQLD]);
    await openInspector();

    const nginx = await row(80);
    expect(within(nginx).getByText("nginx.exe")).toBeInTheDocument();
    expect(within(nginx).getByText("8124")).toBeInTheDocument();

    const mysqld = await row(3306);
    expect(within(mysqld).getByText("mysqld.exe")).toBeInTheDocument();
    expect(within(mysqld).getByText("9021")).toBeInTheDocument();
  });

  it("separates DevX's ports from the machine's other listeners", async () => {
    mocks.listeningPorts.mockResolvedValue([NGINX, MYSQLD]);
    mocks.portMap.mockResolvedValue([
      { owner: "mariadb", port: 3306, active: true },
      { owner: "Web (HTTP)", port: 8080, active: true },
    ]);
    await openInspector();

    // The port map is DevX's own answer about its ports, not a guess made from
    // the process name.
    expect(within(await row(3306)).getByText("DevX · mariadb")).toBeInTheDocument();
    expect(within(await row(80)).getByText("Another process")).toBeInTheDocument();
  });

  it("says a process Windows would not name, rather than leaving a blank", async () => {
    mocks.listeningPorts.mockResolvedValue([UNNAMED]);
    await openInspector();

    expect(within(await row(443)).getByText("unknown")).toBeInTheDocument();
  });

  it("does not call a port another process's when the port map could not be read", async () => {
    mocks.listeningPorts.mockResolvedValue([MYSQLD]);
    mocks.portMap.mockRejectedValue(new Error("port map unavailable"));
    const user = await openInspector();

    // §131 Rule 17: an unread port map is not a port map that says "no", and a
    // row that claimed otherwise could name DevX's own service as a stranger.
    expect(
      await screen.findByText("The port map could not be read."),
    ).toBeInTheDocument();
    expect(within(await row(3306)).getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Another process")).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "Stop mysqld.exe on port 3306" }),
    );
    expect(await screen.findByRole("dialog", { name: "Stop mysqld.exe?" })).toHaveTextContent(
      /cannot say whether it restarts this/i,
    );
  });

  it("says nothing is listening rather than showing an empty table", async () => {
    await openInspector();

    expect(
      await screen.findByText("No IPv4 port is in the LISTEN state."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("reports a failed read and retries it on request", async () => {
    mocks.listeningPorts
      .mockRejectedValueOnce(new Error("GetExtendedTcpTable failed with code 5"))
      .mockResolvedValueOnce([NGINX]);
    const user = await openInspector();

    expect(
      await screen.findByText("Could not read the port list."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("GetExtendedTcpTable failed with code 5"),
    ).toBeInTheDocument();
    // §131 Rule 18: a failed read is not the same answer as "nothing is
    // listening", so the empty state must not be what the user sees.
    expect(
      screen.queryByText("No IPv4 port is in the LISTEN state."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(within(await row(80)).getByText("nginx.exe")).toBeInTheDocument();
    expect(screen.queryByText("Could not read the port list.")).not.toBeInTheDocument();
  });

  it("copies a PID and says so", async () => {
    // user-event installs its own clipboard stub, so the spy replaces it after
    // the session exists rather than before.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.listeningPorts.mockResolvedValue([MYSQLD]);
    await openInspector(user);

    await row(3306);
    await user.click(await screen.findByRole("button", { name: "Copy PID 9021" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("9021"));
    expect(await screen.findByText("PID copied")).toBeInTheDocument();
  });

  it("will not stop a process before the confirmation is accepted", async () => {
    mocks.listeningPorts.mockResolvedValue([NGINX]);
    const user = await openInspector();

    await row(80);
    await user.click(
      await screen.findByRole("button", { name: "Stop nginx.exe on port 80" }),
    );

    // §110: the confirmation names what it will end, and until it is accepted
    // nothing has been stopped.
    expect(mocks.stopProcessOnPort).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog", { name: "Stop nginx.exe?" });
    expect(confirm).toHaveTextContent("Ends PID 8124 (nginx.exe) on port 80.");
    expect(confirm).toHaveTextContent("Nothing restarts it afterwards.");

    await user.click(within(confirm).getByRole("button", { name: "Stop process" }));

    await waitFor(() =>
      expect(mocks.stopProcessOnPort).toHaveBeenCalledWith(8124, 80),
    );
    expect(await screen.findByText("nginx.exe was stopped")).toBeInTheDocument();
  });

  it("warns when the port belongs to a service DevX supervises", async () => {
    mocks.listeningPorts.mockResolvedValue([MYSQLD]);
    mocks.portMap.mockResolvedValue([{ owner: "mariadb", port: 3306, active: true }]);
    const user = await openInspector();

    await row(3306);
    await user.click(
      await screen.findByRole("button", { name: "Stop mysqld.exe on port 3306" }),
    );

    const confirm = await screen.findByRole("dialog", { name: "Stop mysqld.exe?" });
    expect(confirm).toHaveTextContent("DevX claims that port for mariadb");
  });

  it("cancelling the confirmation stops nothing", async () => {
    mocks.listeningPorts.mockResolvedValue([NGINX]);
    const user = await openInspector();

    await row(80);
    await user.click(
      await screen.findByRole("button", { name: "Stop nginx.exe on port 80" }),
    );
    await user.click(
      within(await screen.findByRole("dialog", { name: "Stop nginx.exe?" })).getByRole(
        "button",
        { name: "Cancel" },
      ),
    );

    expect(mocks.stopProcessOnPort).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Stop nginx.exe?" })).not.toBeInTheDocument();
  });

  it("reports a refusal as feedback instead of looking like it worked", async () => {
    mocks.listeningPorts.mockResolvedValue([UNNAMED]);
    mocks.stopProcessOnPort.mockRejectedValue(
      new IpcError({
        code: "process",
        message: "Windows refused to stop PID 4: Access is denied. (0x80070005)",
        hint: "A process owned by SYSTEM or by another user needs Task Manager run as administrator.",
      }),
    );
    const user = await openInspector();

    await row(443);
    await user.click(await screen.findByRole("button", { name: "Stop PID 4 on port 443" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Stop PID 4?" })).getByRole(
        "button",
        { name: "Stop process" },
      ),
    );

    // §54: the reason is on the toast, not behind "View Details", because a
    // refusal the user has to go looking for reads as a command that worked.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/was not stopped/i);
    expect(alert).toHaveTextContent(/PID 4/);
    expect(alert).toHaveTextContent(/Access is denied/);

    // The backend's suggestion is one click away, with the reason already read.
    await user.click(within(alert).getByRole("button", { name: "View Details" }));
    expect(alert).toHaveTextContent(/Task Manager run as administrator/i);
  });
});
