import type { SiteStatus, DnsStatus, DnsMode, PhpPoolStatus } from "@/lib/ipc";
import { serverLabel, serverLoopback } from "./site-helpers";

type Hop = { main: string; sub: string; you?: boolean };

/**
 * Where one HTTP request goes for this site (preview Frame 3).
 * Static sites skip the pool hop — there is no FastCGI endpoint.
 */
export function RoutePanel({
  site,
  dns,
  mode,
  pool,
}: {
  site: SiteStatus;
  dns?: DnsStatus;
  mode?: DnsMode;
  pool?: PhpPoolStatus | null;
}) {
  const port = site.https ? site.https_port : site.port;
  const resolveSub =
    mode === "hosts_file" || mode === undefined
      ? `hosts · ${serverLoopback(site.web_server)}`
      : `resolver · ${dns?.suffix ?? "test"}`;

  const poolPort =
    pool?.port ??
    (site.php_endpoint && site.php_endpoint.includes(":")
      ? Number(site.php_endpoint.split(":").pop())
      : null);
  const shortVer = site.php_version ? site.php_version.split(".").slice(0, 2).join("") : "";
  const poolSub = pool
    ? `${pool.workers} workers · ${pool.state}`
    : site.php_endpoint ?? "FastCGI";

  const hops: Hop[] = [
    { main: "browser", sub: "you", you: true },
    { main: site.hostname, sub: resolveSub },
    {
      main: `${serverLabel(site.web_server)}${port ? ` :${port}` : ""}`,
      sub: serverLoopback(site.web_server),
    },
    ...(site.php_endpoint && site.php_version
      ? [{ main: `php${shortVer}${poolPort ? ` :${poolPort}` : ""}`, sub: poolSub }]
      : []),
    { main: site.docroot, sub: "docroot" },
  ];

  return (
    <div className="mt-4 border border-border bg-surface px-4 py-4">
      <h3 className="text-xs font-semibold text-foreground">Where a request goes</h3>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hops.map((h, i) => (
          <span key={`${h.main}-${i}`} className="contents">
            {i > 0 ? <span aria-hidden className="text-ink-muted">→</span> : null}
            <span
              className={
                h.you
                  ? "border border-foreground bg-surface-2 px-3 py-1.5 font-mono text-xs font-semibold text-foreground"
                  : "border border-line-strong px-3 py-1.5 font-mono text-xs text-foreground"
              }
            >
              {h.main}
              <small className="block font-sans text-[10px] font-normal text-ink-muted">{h.sub}</small>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
