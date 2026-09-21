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
  // ponytail: the backend owns URL resolution (bare on the owner's
  // loopback, `:port` on override); the UI just opens what it is told.
  const url = (site as { url?: unknown }).url;
  if (typeof url === "string" && url.length > 0) {
    return url;
  }
  return `${site.https ? "https" : "http"}://${site.hostname}`;
}
