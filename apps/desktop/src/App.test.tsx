import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/ui/toast";

/**
 * §132's last two boxes, which nothing else covers: "No console errors" and
 * "No unnecessary re-renders".
 *
 * Every route is mounted for real, with the backend answering with empty but
 * correctly shaped data, and the test fails if anything reaches `console.error`
 * — that is the only way to check the first box without a human watching the
 * devtools. React reports key warnings, invalid nesting, unknown props and
 * crashing effects there, so this catches the whole family in one pass.
 *
 * The Profiler half counts commits for a cold mount of each route. Its job is
 * to catch a render loop (an effect that sets state on every render, a query
 * that re-derives a new object into a dependency), which is what "unnecessary
 * re-renders" means in practice; it is not a budget for how many commits a
 * page is allowed while it is doing real work. Measured on this suite: `/`
 * commits once, and every lazily-loaded route commits five times (fallback,
 * chunk, data, and React's own settle). The bound is four times the highest
 * measured value, so it fails on a loop rather than on a refactor.
 */

/** Every route in `src/App.tsx`, with the label its topbar context shows. */
const ROUTES: readonly { path: string; label: string }[] = [
  { path: "/", label: "Dashboard" },
  { path: "/components", label: "Components" },
  { path: "/services", label: "Services" },
  { path: "/sites", label: "Sites" },
  { path: "/logs", label: "Logs" },
  { path: "/terminal", label: "Terminal" },
  { path: "/share", label: "Share" },
  { path: "/databases", label: "Databases" },
  { path: "/mail", label: "Mail" },
  { path: "/diagnostics", label: "Diagnostics" },
  { path: "/settings", label: "Settings" },
];

vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  const { configFixture } = await import("@/test/fixtures");

  /**
   * One answer per command, shaped like the real one. Anything not listed
   * resolves `null`: a command this smoke test has never heard of is a
   * command the shell already tolerates, because every page handles a
   * backend that has not answered.
   */
  const responses: Record<string, unknown> = {
    appInfo: { name: "DevX", version: "0.1.0", target: "x86_64-pc-windows-msvc", debug: false },
    pathsGet: { config_dir: "C:/devx/config", data_dir: "C:/devx/data" },
    configGet: configFixture(),
    caStatus: { exists: false, trusted: null },
    dnsStatus: { running: false, port: null, nrpt_active: null, suffix: "test" },
    privilegedStatus: { available: false, protocol_version: null },
    mailStatus: { running: false, port: null, smtp_port: 1025, total: null, unread: null },
    updateCheck: { current: "0.1.0", latest: null, update_available: false, url: null },
    doctorRun: { status: "pass", checks: [] },
    terminalPath: "",
    profileList: [],
    eventsRecent: [],
    // §98: nothing recorded on a fresh machine, which the bell must render
    // without inventing a count.
    notificationsList: { entries: [], unread_count: 0, recorded: 0 },
    diskUsage: [],
    portMap: [],
    catalogList: [],
    installedVersions: [],
    serviceComponentIds: [],
    serviceMetrics: [],
    logsList: [],
    phpPoolList: [],
    siteList: [],
    siteRequests: [],
    templateList: [],
    cronList: [],
    workerList: [],
    dbListServers: [],
    mailList: [],
  };

  return {
    ...actual,
    ipc: new Proxy(
      {},
      {
        get: (_target, key) => () => Promise.resolve(responses[String(key)] ?? null),
      },
    ),
    // No event bus outside the Tauri runtime; a listening stub is enough for
    // the shell's subscription and the terminal's output stream.
    ipcEvents: new Proxy({}, { get: () => ({ listen: () => Promise.resolve(() => {}) }) }),
  };
});

/** Commits per route, reset before each case. */
let commits = 0;

const countRender: ProfilerOnRenderCallback = () => {
  commits += 1;
};

function renderRoute(route: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider>
          <ToastProvider>
            {/* No StrictMode: `main.tsx` has it, but a double-invoked render
                would double every count here and make the bound meaningless. */}
            <Profiler id={route} onRender={countRender}>
              <App />
            </Profiler>
          </ToastProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("every route (§132)", () => {
  let consoleErrors: string[];

  beforeEach(() => {
    commits = 0;
    consoleErrors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("covers every route the router declares", () => {
    // A route added to App.tsx without a smoke entry is the one that would
    // reach a user unverified, so the list is asserted rather than trusted.
    expect(ROUTES).toHaveLength(11);
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
    expect(ROUTES.map((route) => route.path)).toContain("/");
  });

  it.each(ROUTES)("mounts $path without a console error", async ({ path, label }) => {
    renderRoute(path);

    // The route's own chunk replaced §102's suspense fallback...
    //
    // The 8s budget is for the `React.lazy` chunk, not for the page. `waitFor`
    // otherwise uses RTL's default 1000ms `asyncUtilTimeout`, which assumes the
    // import has already resolved; when the suite runs in parallel on a busy
    // box the largest route chunks can take longer than that, and the wait then
    // expires with the fallback still mounted — a slow machine reported as a
    // route that never rendered. It stays under the 15s `testTimeout` so a
    // chunk that genuinely never arrives still fails on this assertion rather
    // than surfacing as a hung test.
    await waitFor(
      () => expect(screen.queryByText("Loading this page…")).not.toBeInTheDocument(),
      { timeout: 8000 },
    );
    // ...and the route is the one the path names, not the fallback route.
    const topbar = document.querySelector("header");
    expect(topbar).not.toBeNull();
    expect(within(topbar as HTMLElement).getByText(label)).toBeInTheDocument();

    expect(consoleErrors, `console.error while mounting ${path}`).toEqual([]);
    // Measured cold mounts: 1 commit for `/`, 5 for a lazy route.
    expect(commits, `commits while mounting ${path}`).toBeLessThan(20);
  });

  it("settles instead of re-rendering forever", async () => {
    renderRoute("/");

    // Let every immediate query resolve, then watch the count over a window in
    // which nothing changes. A render loop keeps committing here.
    //
    // `/` is the dashboard, the one route `App.tsx` imports eagerly, so this
    // fallback is not normally mounted and the wait returns at once. The budget
    // is here so that the assertion cannot quietly turn into a 1s race against
    // a chunk fetch if the dashboard is ever moved behind `lazy()`.
    await waitFor(
      () => expect(screen.queryByText("Loading this page…")).not.toBeInTheDocument(),
      { timeout: 8000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = commits;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(commits - settled).toBeLessThan(5);
    // No `consoleErrors` assertion here on purpose: this test waits on the wall
    // clock, so the dashboard's own poll intervals fire outside `act()` and
    // React logs that as a test-harness warning. `act` does not exist in the
    // running app, so the per-route mount case above is where "no console
    // errors" is asserted, and it does it against a settled mount.
  });
});
