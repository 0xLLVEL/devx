import type {
  ComponentSummary,
  Config,
  DoctorReport,
  VersionListing,
} from "@/lib/ipc";

/** Default configuration as produced by `Config::default()` in Rust. */
export function configFixture(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    general: {
      theme: "system",
      start_with_windows: false,
      close_to_tray: true,
      restore_services_on_start: true,
    },
    network: {
      domain_suffix: "test",
      http_port: 80,
      https_port: 443,
      dns_port: 53,
      dns_mode: "auto",
    },
    provisioning: {
      catalog_url:
        "https://raw.githubusercontent.com/devx/devx/main/catalog/catalog.json",
      keep_archives: false,
      max_concurrent_downloads: 2,
      auto_refresh_catalog: true,
    },
    php_pools: {},
    sites: [],
    ...overrides,
  };
}

/** A healthy doctor report. */
export function doctorFixture(
  overrides: Partial<DoctorReport> = {},
): DoctorReport {
  return {
    status: "pass",
    checks: [
      {
        id: "webview2",
        title: "WebView2 runtime",
        status: "pass",
        detail: "version 152.0.4191.66",
        remedy: null,
      },
      {
        id: "writable-config",
        title: "Writable config directory",
        status: "pass",
        detail: "C:\\Users\\dev\\AppData\\Roaming\\DevX",
        remedy: null,
      },
    ],
    ...overrides,
  };
}

/** A catalog entry as returned by `catalog_list`. */
export function componentSummaryFixture(
  overrides: Partial<ComponentSummary> = {},
): ComponentSummary {
  return {
    id: "php",
    name: "PHP",
    kind: "runtime",
    summary: "PHP runtime, served to Nginx as FastCGI worker pools.",
    homepage: "https://www.php.net/",
    license: "PHP-3.01",
    multi_version: true,
    caveat: null,
    pinned: false,
    ...overrides,
  };
}

/** A resolved version list, newest first. */
export function versionListingFixture(
  overrides: Partial<VersionListing> = {},
): VersionListing {
  return {
    stale: false,
    unverifiable: [],
    versions: [
      {
        component_id: "php",
        version: "8.4.25",
        channel: "stable",
        released_at: "2026-08-25",
        artifact: {
          url: "https://windows.php.net/downloads/releases/php-8.4.25-nts-Win32-vs17-x64.zip",
          file_name: "php-8.4.25-nts-Win32-vs17-x64.zip",
          size_bytes: 31_457_280,
          archive: "zip",
          checksum: { kind: "sha256", hex: "a".repeat(64) },
        },
      },
      {
        component_id: "php",
        version: "8.3.28",
        channel: "lts",
        released_at: "2026-07-01",
        artifact: {
          url: "https://windows.php.net/downloads/releases/php-8.3.28-nts-Win32-vs16-x64.zip",
          file_name: "php-8.3.28-nts-Win32-vs16-x64.zip",
          size_bytes: null,
          archive: "zip",
          checksum: {
            kind: "sha256_file",
            url: "https://example.com/SHASUMS256.txt",
            file_name: "php-8.3.28-nts-Win32-vs16-x64.zip",
          },
        },
      },
    ],
    ...overrides,
  };
}
