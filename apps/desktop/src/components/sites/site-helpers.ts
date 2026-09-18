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
  return `${site.https ? "https" : "http"}://${site.hostname}`;
}
