import type { SiteStatus } from "@/lib/ipc";

export type WebServerChoice = "Nginx" | "Apache" | "Caddy" | "FrankenPhp";

export const STATIC = "@static";

export function serverLabel(server: SiteStatus["web_server"]): string {
  return server === "Nginx"
    ? "nginx"
    : server === "Apache"
      ? "apache"
      : server === "Caddy"
        ? "caddy"
        : "frankenphp";
}

export function siteUrl(site: SiteStatus): string {
  // ponytail: ports ride on SiteStatus; default ports stay bare.
  if (site.https) {
    const httpsPort = (site as { https_port?: number | null }).https_port;
    if (httpsPort == null || httpsPort === 443) {
      return `https://${site.hostname}`;
    }
    return `https://${site.hostname}:${httpsPort}`;
  }
  const port = (site as { port?: number | null }).port;
  if (port == null || port === 80) {
    return `http://${site.hostname}`;
  }
  return `http://${site.hostname}:${port}`;
}
