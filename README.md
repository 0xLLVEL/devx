# DevX

A developer environment manager for Windows. DevX provisions portable language
runtimes and backing services on demand, serves your projects over local `.test`
domains with automatic HTTPS, and keeps everything supervised from one window.

Comparable to ServBay or Laravel Herd, built with Rust and Tauri 2.

> Status: under active development. See [Implementation status](#implementation-status).

## Requirements

- Windows 10 1809 or newer, x64
- [Rust](https://rustup.rs/) stable (1.85+)
- [Node.js](https://nodejs.org/) 22+ and npm
- WebView2 runtime (preinstalled on Windows 11; the installer bootstraps it otherwise)

## Repository layout

```
devx-rewrite/
├─ crates/
│  ├─ devx-core/           domain model, configuration, diagnostics
│  ├─ devx-dns/            bundled *.test resolver (RFC 1035 UDP server)
│  ├─ devx-ipc/            typed protocol between the app and its helper
│  ├─ devx-proc/           process supervision (job objects, health, logs)
│  ├─ devx-provision/      component catalog, version resolution, downloads
│  ├─ devx-privileged/     hardened named-pipe client for the helper
│  ├─ devx-helper/         privileged helper service (hosts file, cert store)
│  ├─ devx-cli/            `devx` command-line companion
│  └─ devx-sys/            unprivileged Windows probes (registry, volumes)
├─ apps/desktop/
│  ├─ src/                 React frontend
│  └─ src-tauri/           Tauri shell: commands, events, tray
├─ assets/                 source app icon
├─ catalog/                component catalog (versions, artifacts, hashes)
└─ scripts/                repository tooling
```

Remaining crates arrive as their tasks land: none — the workspace is complete.

## Process supervision

Every backing service runs as a supervised child process (`devx-proc`). A
supervisor spawns the process, waits for a health check (TCP port, log pattern,
or uptime) before reporting `Running`, captures output to a rotating log file
and an in-memory tail, and restarts on failure within a retry budget with
backoff.

The critical Windows detail is orphan-proofing: each child is assigned to a
[job object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When DevX exits — cleanly or by
crashing — the kernel closes the job handle and terminates every child with it.
No `mysqld` left holding a port after a crash, the failure mode that plagues
XAMPP and Laragon.

### Service definitions

Each supervisable component has a declarative `ServiceDefinition`
(`devx-provision`): its default port, config files rendered from templates, any
one-time init step (`initdb`, `mariadb-install-db`), the launch command, and how
readiness is observed. Rendering and init are pure/idempotent — an init step
only runs when its data-directory marker is absent — so re-running setup never
corrupts an initialised database.

Ports are allocated with conflict detection: DevX enumerates listening ports and
their owning processes (`GetExtendedTcpTable`), and if a preferred port is taken
it either reassigns to the next free one or reports who holds it.

The seven services (nginx, MariaDB, PostgreSQL, Redis, Mailpit, MinIO,
Meilisearch) are each verified against a real binary by the `live_service`
tests.

### PHP FastCGI pools

PHP is not one of those services. Instead, every *installed PHP version* gets
its own FastCGI pool (`devx-provision::php_pool`): one supervised `php-cgi`
process bound to `127.0.0.1:<port>`, serving a configurable number of workers
through `PHP_FCGI_CHILDREN`. Consequences:

- **Version isolation** — a site pinned to PHP 8.3 talks only to the 8.3 pool;
  upgrading one project cannot change another's runtime.
- **Coexistence** — several versions run at once, each on its own port, and
  site configuration points `fastcgi_pass` at the pool it wants.
- **Stable ports** — a pool keeps the port its rendered `pool.conf` claims
  across DevX restarts; new pools are allocated past every claimed port.

Each pool renders a minimal `php.ini` (error log and sessions inside the DevX
tree, mail routed to Mailpit's SMTP port) plus a `pool.conf` recording the
listen address for downstream consumers. Worker counts are remembered in
`config.toml` under `php_pools`. The `live_php` test installs a real PHP
build, starts its pool, and proves the FastCGI socket accepts connections.

#### PHP extension manager

Extensions ship unenabled in every PHP build's `ext/` directory; the Services
page enumerates them (`list_php_extensions` scans `ext/php_*.dll`) and turns
them on or off per version. Enabled extensions are recorded in `config.toml`
under `php_extensions` (DLL file names, keyed by PHP version) and rendered
into the pool's generated `php.ini` — ordinary `extension =` lines, except
`opcache` and `xdebug`, which must load through `zend_extension` or PHP
refuses to start. Saving while the pool is running re-renders the ini and
restarts the pool, so the change applies immediately.

### Sites and nginx routing

A *site* (`devx-provision::sites`) is a host name, a document root and the PHP
version that serves it — the unit users actually think in. Sites live in
`config.toml` under `[[sites]]`, and each one is rendered to exactly one nginx
`server` block file under `service-config/nginx/sites/<hostname>.conf`:

- PHP sites get a `location ~ \.php$` whose `fastcgi_pass` is read from the
  chosen pool's rendered `pool.conf`, never hardcoded, so ports follow pools.
  The standard front-controller fallback (`PATH_INFO`, `try_files` to
  `index.php`) is included, so Laravel-style routing works out of the box.
- Static sites get a plain file-serving block.
- Every mutation (`site_add`, `site_remove`) re-syncs the whole include
  directory and prunes blocks for removed sites, so disk state always equals
  configured state and nginx restarts are deterministic.

Sites require the pool of their PHP version to have been started once (its
`pool.conf` must exist) before they can be added — the endpoint has to be
resolvable, not guessed. The `live_site` test proves the full chain end to
end: nginx serves a real PHP page through the pool of the site's version,
and a second static site routes independently.

### Queue workers

Anything that should keep running alongside the services — a Laravel
`queue:work`, a Node consumer, a watcher — is a *worker*: a user-defined
supervised process, configured on the Services page and stored in
`config.toml` under `[[workers]]`. A worker names either a program (path or
`PATH` name) or a DevX-managed PHP version, its arguments, an absolute
working directory, and an instance count (1–8); each instance is its own
supervised process with a job object, a log file and the standard
restart-with-backoff policy. Running instances are captured in
`session.json` and restored on the next start, one broken instance never
blocking the rest.

### Site environment variables

PHP sites take environment variables straight from DevX: each site's `env`
map in `config.toml` (edited from the Sites page) is rendered into the
site's nginx block as `fastcgi_param` lines, so `getenv` and frameworks like
Laravel see them without a committed `.env`. Validation keeps the blocks
unbreakable — variable-name shapes, no newlines, and no nginx
metacharacters — and saving while nginx is running restarts it, so changes
apply immediately.

### Backups

Each of the three database services gets a Backups card on the Databases
page. MariaDB and PostgreSQL are dumped through their own bundled tools
(`mariadb-dump`, `pg_dumpall`) into plain SQL under
`data/backups/<service>/`; Redis issues a blocking `SAVE` and copies the RDB
file. Restore replays a dump through the engine's client (`mariadb`,
`psql`) against the running server, or swaps a Redis RDB back with the
server stopped. The ten newest backups are kept per service; older ones are
pruned automatically.

### Log viewer and configuration transfer

The Logs page lists every file in the DevX logs directory — services,
pools, workers, rotated generations — with a 500-line tail, refresh and an
auto-refresh toggle. File names are validated against the logs directory so
the viewer reads DevX output and nothing else.

Settings gains configuration transfer: export downloads the current
`config.toml` contents as TOML (sites, workers, pools, extensions and
settings), and import reads a file back through the same
migrate-merge-validate path a config on disk uses, so partial exports still
import and anything invalid leaves the running configuration untouched.

### Site aliases

A site answers to more than its primary host name: `[[sites]]` carries an
`aliases` list, rendered into the nginx `server_name` line alongside the
primary name and validated for shape plus uniqueness across every site and
alias. The bundled resolver covers alias lookups like any other `.test`
name. Aliases are edited per site on the Sites page, and saving restarts
nginx when it is running.

### Terminal

The Terminal page runs one command at a time through `cmd /c` with the
DevX runtimes prepended to `PATH` — every installed runtime directory
(plus its `bin`), then the system `PATH` untouched — so `php`, `composer`,
`node` and `psql` resolve without touching the user's environment. Output
streams to the frontend as typed events, with per-run exit codes and a
command history. It is a command runner rather than a pty: interactive
prompts are not supported, by design.

### Scheduled tasks

`[[cron]]` config entries become real Windows scheduled tasks: `cron_set`
persists the definition (a program or DevX PHP version, args, an absolute
working directory, an interval of 1–10080 minutes) and creates a per-user
task named `DevX <name>` through `schtasks` — unelevated, so the privileged
helper stays out of it. Since `schtasks` has no start-in flag, the working
directory travels inside the command line (`cmd /c cd /d … && …`). Tasks
are managed from the Services page, which also shows whether the Windows
task still exists.

### Site templates

The Sites page scaffolds a new site in one step: pick a template, give a
host name and document root, and DevX creates the folder, writes the
starter files and registers the site through the normal add flow. Templates
follow the catalog's integrity policy — static and PHP starters are
generated locally, while WordPress and Laravel publish no verifiable zip
checksum, so those templates create the folder and surface the suggested
terminal command instead of downloading anything unverified.

### Failure notifications and resource metrics

Every supervised service publishes its state transitions on a registry-wide
broadcast bus (`devx_proc::ServiceEvent`). The desktop shell relays each
transition to the frontend as a typed event — status badges update the
moment something happens instead of at the next poll — and, for
non-requested failures, raises a Windows notification (toggle in Settings).
On top of the same supervision sits a resource view: `service_metrics`
samples CPU time (`GetProcessTimes`) and resident memory
(`GetProcessMemoryInfo`) of every live process in each job object, and the
Dashboard plus per-service badges render the result.

### Privileged helper and hardened IPC

Operations that need elevation (the `hosts` file today; the certificate
store and NRPT rules in Tasks 10–11) never run inside the desktop app.
They go to a separate `devx-helper` service, executed elevated and
installed by the DevX installer, over a named pipe whose two ends live in
separate crates so they cannot drift:

- `devx-ipc` owns the wire protocol: versioned JSON requests and replies
  (`Hello`, `ListHostsEntries`, `AddHostsEntry`, `RemoveHostsEntry`),
  host-name and IP validation, and a length-prefixed frame codec with a
  hard 1 MiB cap.
- `devx-privileged` owns the client: it opens the pipe with
  `SECURITY_IDENTIFICATION` SQoS (the helper may identify the caller but
  never act as it), and every session begins with a version handshake that
  both sides refuse on mismatch.
- `devx-helper` owns the server: the pipe is created with a protected DACL
  (`D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;WD)`), and every request is
  re-validated at the boundary before anything is written.

Hosts mutations are confined to lines ending in `# devx-managed`. The
helper can add, update and remove its own entries, but it refuses to
shadow or delete a line it did not write, so hand-crafted overrides
survive DevX and the helper cannot be conned into rewriting them. All
edits are atomic whole-file rewrites.

### Local CA and automatic HTTPS

HTTPS for `*.test` sites comes from a miniature PKI DevX owns end to end:

- `devx-provision::pki` generates one local **root CA** on first use
  (`data/certs/ca.crt` + `ca.key.pem`) and issues a **server certificate
  per HTTPS site** into `data/certs/sites/<hostname>/`, signed by that CA.
  Certificates are minted once and reused: a re-rendered nginx config
  never rewrites a cert a browser already saw.
- Installing the root into the machine trust store needs elevation, so it
  goes through the helper (`InstallCa`/`CheckCa`/`RemoveCa` requests). The
  helper imports only single, shape-validated certificates into the
  machine **Root** store under the `DevX Local CA` friendly name — nothing
  else in the store is reachable through the protocol.
- Sites with `https = true` in `config.toml` get both an HTTP `listen 80`
  and a `listen 443 ssl` server block, with `ssl_certificate` pointing at
  the site's issued certificate. Enabling HTTPS on a site therefore
  requires the CA (installed once from the Sites page) but nothing else.

### Wildcard DNS resolver and NRPT

The hosts file maps exactly the names it lists; a resolver maps *any*
name under its suffix, which is what wildcard subdomains need. DevX
ships its own resolver in `devx-dns`:

- a small RFC 1035 UDP server that answers `A` queries for `*.<suffix>`
  with loopback and NXDOMAIN for anything else; short TTLs (5 s) so a
  stopped resolver is honoured quickly;
- routing `.test` queries to it is done with an NRPT rule — Windows
  consults the rule table before ordinary DNS — written by the helper
  (`SetNrptRule`/`RemoveNrptRule`) into the machine policy key under a
  fixed, DevX-owned GUID. The rule is confined to the single suffix DevX
  documents, so the pipe can never redirect other traffic;
- `dns_start` binds the resolver (falling back to an ephemeral port when
  53 is not bindable unelevated) and then points the rule at the actual
  port; `dns_stop` reverses both. Non-`.test` names never touch DevX, so
  corporate DNS and VPN setups are untouched.

### Database browser

DevX supervises MariaDB, PostgreSQL and Redis, and the Databases page
makes them browsable. The engine clients live in `devx-db` behind one
shape: a `ConnectionParams` struct (engine, host, port, optional
credentials and database), a three-variant `DbValue` bridge (NULL kept
distinct from an empty string, numbers and text rendered as the server
reports them) and a `DbResult` grid of columns plus rows.

- `db_list_servers` enumerates the three database services, reading
  each running service's *actual* bound port from its supervisor and
  falling back to the definition's default when stopped; a live TCP
  probe drives the reachability badge.
- `db_list_databases` / `db_list_tables` run the per-engine catalog
  queries (`SHOW DATABASES` + `SHOW TABLES`, PostgreSQL's `pg_database`
  + information_schema, Redis's key scan) through the same grid type.
- `db_query` executes a single statement and returns the grid the page
  renders; the browser is read-oriented, not an admin console.

### Mail catcher

DevX bundles Mailpit as the `mailpit` service: apps send mail to SMTP
port 1025, nothing leaves the machine, and the Mail page reads the
captured inbox. The typed client lives in `devx-mail` and speaks
Mailpit's v1 HTTP API on the service's UI port — no HTML scraping, no
shelling out. Mailpit's wire format (capitalized Go exports, `null`
From, absent tag lists) is normalized once at the boundary into
snake_case DTOs, with the raw shapes kept private to the crate.

- `mail_status` reports the running state, the API/UI port from the
  live supervisor (default-port fallback), the SMTP port to point apps
  at, and best-effort total/unread counts — `null` counters instead of
  an error when the API is not answering *yet*.
- `mail_list` / `mail_message` fetch the inbox (newest first) and one
  full message; Mailpit marks a message read when it is fetched, which
  the page surfaces by refreshing the counters.
- `mail_delete` removes specific messages, or everything when called
  with an empty ID list ("clear inbox"). Bodies are shown as
  plain text with attachment names listed; rendering HTML bodies inside
  the app is deliberately avoided so tracking pixels stay inert.

### Cloudflare Tunnel sharing

The Share page puts any site on a public URL with Cloudflare's *quick
tunnels*: no account, no config file, nothing to clean up afterwards.
One `cloudflared tunnel --url http://127.0.0.1:<nginx-port>` process
runs per shared site through the ordinary supervisor, so lifecycle,
logging and crash handling are inherited rather than reinvented.

- The tunnel forwards to the port nginx *actually* serves (live port
  from its supervisor, default-port fallback), so the public URL reaches
  the same server block the local `.test` host name does — PHP pools,
  HTTPS-terminated-by-nginx sites and static sites all just work.
- The assigned `https://…trycloudflare.com` URL is parsed from the
  process log (`devx_provision::tunnel::extract_tunnel_url`), matched
  defensively against the quick-tunnel suffix so other cloudflared URLs
  never leak into the UI.
- `tunnel_args` refuses to forward to anything but loopback: a share is
  a bridge to something DevX itself serves, never a proxy for an
  arbitrary remote host.
- Quick tunnels are ephemeral by design — stopping the share kills the
  process and the URL dies with it, which is exactly what a dev tool
  wants. For named, persistent tunnels, run cloudflared with your own
  config alongside DevX.

### Tray, autostart, session restore and updates

The desktop shell behaves like a Windows developer utility, not a one-shot
window:

- **Tray** — a notification-area icon with Show DevX, Close to tray and
  Quit. Closing the window hides it to the tray when `close_to_tray` is
  set (read live on every close request, so the toggle takes effect
  immediately), and quitting from the tray is the explicit way out — job
  objects take every supervised service down with it, exactly like a crash
  would, only on purpose.
- **Autostart** — `start_with_windows` is applied through the autostart
  plugin (a `Run` key entry on Windows): reconciled once at startup so a
  renamed executable repairs itself, and re-applied on every settings
  save. The registry key is the OS's state; config merely records intent.
- **Single instance** — a second launch focuses the existing window instead
  of spawning a competing DevX fighting over ports and config files.
- **Session restore** — which services were running is *state*, not config,
  so it lives in a separate `session.json` (written atomically at exit).
  On the next start, when `restore_services_on_start` is set, each entry
  (services *and* PHP pools) is started independently on a background
  task: one broken install or occupied port logs a warning and moves on,
  never blocking the window or the other services. Version resolution
  happens at restore time, so an upgraded service comes back on the
  newest installed version.
- **Update check** — the Settings page compares the running version against
  the latest published GitHub release (semver, drafts and prereleases
  excluded). A failed check reports "unknown" rather than an error — an
  offline machine must not get a red banner for a missed HTTP call. DevX
  never self-installs: the card links to the releases page.

### `devx` CLI companion

`crates/devx-cli` builds the `devx` binary, a script-friendly window into
the same state the desktop app manages. Both frontends share the on-disk
contract (`devx-core::ConfigStore`, `devx-provision::sites`), so the app and
the CLI converge on identical config and nginx blocks without talking to
each other — and the CLI follows the same mutation order (persist config
first, render blocks second) so a failed save never leaves a stray block.

```text
devx doctor                          # diagnostics; exit 2 = fail, 1 = warn, 0 = ok
devx paths                           # resolved directory layout as JSON
devx sites list                      # one JSON object per site
devx sites add myapp.test C:\src\myapp\public --php 8.4 --https
devx sites remove myapp.test
devx install php 8.4.12              # resolve upstream, download, verify, extract
devx uninstall php 8.4.12
devx installed                       # installed versions as JSON
```

`--home <dir>` (or the existing `DEVX_HOME` variable) points every command
at a throwaway root, which makes the CLI hermetic to test:

```powershell
$env:DEVX_HOME = "$env:TEMP\devx-scratch"
cargo run -p devx-cli -- doctor
```

Process lifecycle is deliberately absent: supervised services belong to the
desktop app's job objects, and a CLI that stopped `mysqld` behind the app's
back would fight it over ports and config. The CLI manages state on disk —
configuration, sites, installs — and reports diagnostics; start and stop
stay in the app.

## Component catalog

`catalog/catalog.json` describes every installable component and how DevX finds
its versions. It is embedded in the binary, so a fresh install works offline.

Four resolution strategies cover the ways upstreams publish Windows builds:

| Strategy | Used by | Where versions come from |
| -------- | ------- | ------------------------ |
| `php_net` | PHP | `windows.php.net` release manifest, hash included |
| `node_dist` | Node.js | `nodejs.org/dist/index.json`, hashes in per-release `SHASUMS256.txt` |
| `github_releases` | Caddy, PostgreSQL, Redis, Mailpit, Meilisearch, cloudflared | GitHub releases API, asset `digest` or a checksum asset |
| `pinned` | Nginx, MariaDB, MinIO, Composer | Versions and hashes recorded in the catalog |

### Integrity policy

**A version with no obtainable SHA-256 is not offered at all.** Releases whose
checksum the upstream never published are reported separately in the UI rather
than presented as installable, so a download is never unverified. This is why
older GitHub releases of some components do not appear: GitHub only began
recording asset digests recently.

It is also why MySQL is absent. Oracle publishes only an MD5, on a page that
blocks direct fetches, so DevX cannot verify the 300 MB ZIP. MariaDB speaks the
same wire protocol and is offered instead.

### Checking the catalog against reality

Network tests are excluded from CI so an upstream outage cannot fail a build.
Run them by hand after editing the catalog or a resolver:

```powershell
cargo test -p devx-provision --test live_upstreams -- --ignored --nocapture
```

They assert that every component still resolves at least one verifiable version,
that asset patterns still match, and that pinned URLs still return `200`. The
`live_install` suite goes further and downloads, verifies and runs real PHP and
Node builds end to end.

### Install pipeline

Installing a version runs download → verify → extract → promote:

1. **Download** streams to a `.partial` sidecar with progress events, resuming
   an interrupted transfer with a `Range` request and retrying transient
   failures with backoff.
2. **Verify** computes the SHA-256 and compares it to the expected digest
   (inline, or resolved from a `SHASUMS256.txt`/`.sha256` document). A mismatch
   aborts before anything is extracted.
3. **Extract** unpacks into a staging directory, rejecting any entry that would
   escape it (zip-slip) and normalising the wrapper-directory layout.
4. **Promote** renames staging to `runtimes/<component>/<version>/` and writes a
   completion marker last, so a half-installed version is never observed.

Any failure removes the staging directory and partial download, leaving no
trace. Installs are idempotent and can be uninstalled cleanly.

### Windows installer

`scripts/make-installer.ps1` builds everything and produces the NSIS setup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make-installer.ps1
# → target/release/bundle/nsis/DevX_<version>_x64-setup.exe
```

It builds the workspace in release mode (`lto`, `strip`, size-optimised),
stages the CLI and helper into `src-tauri/binaries/` under the target-triple
sidecar names the bundler expects, and runs `tauri build`. The installer
itself:

- installs **per machine** (Program Files, HKLM metadata) and refuses
  downgrades;
- bootstraps the WebView2 runtime with the download bootstrapper when
  absent;
- registers `devx-helper.exe` as the **DevXHelper service** via NSIS
  hooks (`sc.exe create`, LocalSystem, on-demand start — the desktop app
  starts and stops it when elevation is needed) and deregisters it on
  uninstall;
- adds the CLI directory to the **user PATH** only when absent, then
  broadcasts `WM_SETTINGCHANGE`, so new shells see `devx` without a
  reboot — and uninstalling removes the entry without touching the rest;
- stops and deletes a previous helper service *before* files are replaced,
  so upgrades never fail because the SCM pinned the old binary.

Every hook degrades to a `DetailPrint` on failure instead of aborting an
otherwise successful install.

## Data locations

| Purpose | Default | Override |
| ------- | ------- | -------- |
| Configuration | `%APPDATA%\DevX\config.toml` | `DEVX_CONFIG_DIR` |
| Runtimes, service data, logs, cache | `%LOCALAPPDATA%\DevX` | `DEVX_DATA_DIR` |
| Both, under one root | — | `DEVX_HOME` |

`DEVX_HOME` is the quickest way to run a throwaway instance:

```powershell
$env:DEVX_HOME = "$env:TEMP\devx-scratch"
cargo run -p devx-desktop
```

A `config.toml` that fails to parse or validate does not stop DevX from
starting. The app runs on in-memory defaults, leaves the file untouched, and
reports the reason on the Diagnostics page; saving from Settings repairs it.

## Development

```powershell
cd apps/desktop
npm install
npm run tauri dev
```

`npm run tauri dev` starts Vite on port 1420 and launches the Rust shell against
it. The window reloads on frontend changes and restarts on Rust changes.

### Checks

```powershell
# Rust
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Frontend
cd apps/desktop
npm run typecheck
npm run test
```

Note that `cargo build` embeds the frontend bundle, so `apps/desktop/dist` must
exist. Run `npx vite build` once (or `npm run tauri dev`, which serves from Vite
instead) before building the Rust side in a fresh clone.

### Typed IPC

The frontend never calls `invoke` directly. Commands are declared in
`apps/desktop/src-tauri/src/commands.rs`, registered in `src/ipc.rs`, and
`tauri-specta` generates `apps/desktop/src/bindings.ts`, which is committed so
the frontend type-checks without a Rust build.

After changing a command signature:

```powershell
$env:DEVX_UPDATE_BINDINGS='1'; cargo test -p devx-desktop
```

`cargo test` fails if the committed bindings drift from the Rust registry.

Application code imports the facade in `src/lib/ipc.ts` rather than the raw
bindings: it converts the generated `Result` shape into resolved values or a
thrown `IpcError`, which is what TanStack Query expects.

### App icon

`assets/app-icon.png` is generated by `scripts/make-app-icon.ps1` so the icon
stays reviewable in source form. After changing it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make-app-icon.ps1
cd apps/desktop
npm run tauri icon ../../assets/app-icon.png
```

## Implementation status

| Task | Scope | Status |
| ---- | ----- | ------ |
| 1 | Workspace scaffold, Tauri shell, typed IPC, CI | Done |
| 2 | Paths, versioned config, diagnostics | Done |
| 3 | Component catalog and version resolvers | Done |
| 4 | Download, verify, extract, atomic install | Done |
| 5 | Process supervisor with Job Objects | Done |
| 6 | Service specs, config templating, port allocation | Done |
| 7 | Multi-version PHP FastCGI pools | Done |
| 8 | Privileged helper service and hardened IPC | Done |
| 9 | Site management and reverse proxy config | Done |
| 10 | Local CA and automatic HTTPS | Done |
| 11 | Wildcard DNS resolver and NRPT | Done |
| 12 | Database browser | Done |
| 13 | Mail catcher | Done |
| 14 | Cloudflare Tunnel sharing | Done |
| 15 | `devx.exe` CLI companion | Done |
| 16 | Tray, autostart, diagnostics, updater | Done |
| 17 | NSIS installer and release hardening | Done |
| 18 | Service events, failure notifications | Done |
| 19 | Resource metrics (CPU/RAM) dashboard | Done |
| 20 | PHP extension manager | Done |
| 21 | Queue workers | Done |
| 22 | Central log viewer | Done |
| 23 | Site environment variables | Done |
| 24 | Database backups and restore | Done |
| 25 | Configuration import/export | Done |
| 26 | Site aliases (multi-domain) | Done |
| 27 | In-app terminal | Done |
| 28 | Scheduled tasks UI | Done |
| 29 | Site templates | Done |

## License

MIT
