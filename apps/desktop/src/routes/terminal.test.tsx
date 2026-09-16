import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPage } from "@/routes/terminal";
import { TerminalSessionProvider } from "@/lib/terminal-session";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  terminalPath: vi.fn(),
  installedVersions: vi.fn(),
  terminalUseVersion: vi.fn(),
  terminalUnsetVersion: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return {
    ...actual,
    ipc: {
      siteList: mocks.siteList,
      terminalPath: mocks.terminalPath,
      installedVersions: mocks.installedVersions,
      terminalUseVersion: mocks.terminalUseVersion,
      terminalUnsetVersion: mocks.terminalUnsetVersion,
    },
    ipcEvents: {
      terminalOutput: {
        listen: () => Promise.resolve(() => {}),
      },
    },
  };
});

/**
 * Pinning writes PATH shims for the whole machine, so both the running state
 * and a rejected pin are reported on the form itself (§37/§39).
 */
function renderPage() {
  return renderWithProviders(
    <TerminalSessionProvider>
      <TerminalPage />
    </TerminalSessionProvider>,
  );
}

describe("TerminalPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.siteList.mockResolvedValue([]);
    // The console renders the PATH the backend reports as one string.
    mocks.terminalPath.mockResolvedValue("C:\\devx\\bin");
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\php\\8.4.25" },
      { component_id: "php", version: "8.3.12", path: "C:\\devx\\php\\8.3.12" },
    ]);
    mocks.terminalUseVersion.mockResolvedValue(null);
    mocks.terminalUnsetVersion.mockResolvedValue(null);
  });

  it("reports a rejected pin beside the form, not only in a toast (§39)", async () => {
    const user = userEvent.setup();
    mocks.terminalUseVersion.mockRejectedValue(
      new Error("the shims directory is read-only"),
    );

    renderPage();

    await user.selectOptions(await screen.findByLabelText("Component"), "php");
    await user.selectOptions(screen.getByLabelText("Version"), "8.4.25");
    await user.click(screen.getByRole("button", { name: "Pin" }));

    // Both the toast and the form carry it; the form is the one that stays.
    expect(await screen.findByText("Could not pin the version.")).toBeInTheDocument();
    expect(screen.getByText("the shims directory is read-only")).toBeInTheDocument();
    expect(screen.getByLabelText("Component")).toBeInTheDocument();
  });

  it("holds the pin control while the shim is being written (§37)", async () => {
    const user = userEvent.setup();
    mocks.terminalUseVersion.mockReturnValue(new Promise(() => {}));

    renderPage();

    await user.selectOptions(await screen.findByLabelText("Component"), "php");
    await user.selectOptions(screen.getByLabelText("Version"), "8.3.12");

    const pin = screen.getByRole("button", { name: "Pin" });
    expect(pin).toBeEnabled();

    await user.click(pin);

    await waitFor(() => expect(pin).toBeDisabled());
    expect(mocks.terminalUseVersion).toHaveBeenCalledWith("php", "8.3.12");
  });

  it("reports a rejected unpin the same way", async () => {
    const user = userEvent.setup();
    mocks.terminalUnsetVersion.mockRejectedValue(new Error("no shim to remove"));

    renderPage();

    await user.selectOptions(await screen.findByLabelText("Component"), "php");
    await user.click(screen.getByRole("button", { name: "Unpin" }));

    expect(await screen.findByText("Could not unpin the version.")).toBeInTheDocument();
    expect(screen.getByText("no shim to remove")).toBeInTheDocument();
  });
});
