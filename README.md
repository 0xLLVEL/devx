# DEVX

A developer environment manager for Windows. DevX provisions portable language
runtimes and backing services on demand, serves your projects over local `.test`
domains with automatic HTTPS, and keeps everything supervised from one window.

Comparable to ServBay or Laravel Herd, built with Rust and Tauri 2.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [How local URLs work](#how-local-urls-work)
- [Repository layout](#repository-layout)
- [Process supervision](#process-supervision)
  - [Service definitions](#service-definitions)
  - [PHP FastCGI pools](#php-fastcgi-pools)
  - [Sites and per-server routing](#sites-and-per-server-routing)
  - [Queue workers](#queue-workers)
  - [Site environment variables](#site-environment-variables)
  - [Backups](#backups)
  - [Log viewer and configuration transfer](#log-viewer-and-configuration-transfer)
  - [Site aliases](#site-aliases)
  - [Scheduled tasks](#scheduled-tasks)
  - [Site templates](#site-templates)
  - [Failure notifications and resource metrics](#failure-notifications-and-resource-metrics)
  - [Privileged helper and hardened IPC](#privileged-helper-and-hardened-ipc)
  - [Local CA and automatic HTTPS](#local-ca-and-automatic-https)
  - [Name resolution: hosts file and bundled resolver](#name-resolution-hosts-file-and-bundled-resolver)
  - [Database browser](#database-browser)
  - [Mail catcher](#mail-catcher)
  - [Cloudflare Tunnel sharing](#cloudflare-tunnel-sharing)
  - [Tray, autostart, session restore and updates](#tray-autostart-session-restore-and-updates)
  - [`devx` CLI companion](#devx-cli-companion)
- [Component catalog](#component-catalog)
  - [Integrity policy](#integrity-policy)
  - [Checking the catalog against reality](#checking-the-catalog-against-reality)
  - [Install pipeline](#install-pipeline)
  - [Windows installer](#windows-installer)
- [Data locations](#data-locations)
- [Development](#development)
  - [Checks](#checks)
  - [Typed IPC](#typed-ipc)
  - [App icon](#app-icon)
- [License](#license)

## Features

- **Local sites on `.test` domains** — map any project folder to a hostname
  with automatic HTTP and HTTPS; bare URLs, no port suffixes.
- **Four web servers** — nginx, Apache, Caddy and FrankenPHP, each on its own
  loopback address, mixable per site.
- **Automatic HTTPS** — a local root CA with per-site certificates covering
  hostnames and aliases, installed to the machine trust store in one click.
- **Two name-resolution modes** — managed hosts-file entries or a bundled
  wildcard DNS resolver with NRPT, including subdomains.
- **Supervised services** — thirteen backing services with health checks,
  crash restarts, live logs, CPU/RAM metrics and failure notifications.
- **Multi-version PHP** — isolated FastCGI pools per PHP version with a
  per-version extension manager.
- **Queue workers and scheduled tasks** — supervised background processes and
  real Windows scheduled tasks.
- **Database browser** — browse and query MariaDB, PostgreSQL and Redis with
  backups and restore.
- **Mail catcher** — Mailpit captures outbound mail; nothing leaves the machine.
- **Public sharing** — expose any site through an ephemeral Cloudflare quick tunnel.
- **Site templates, site aliases and per-site environment variables.**
- **System integration** — tray popup with quick actions, autostart, single
  instance, session restore, update checks, and a scriptable `devx` CLI
  companion sharing the same on-disk state.

## Requirements

- Windows 10 1809 or newer, x64
- [Rust](https://rustup.rs/) stable (1.85+)
- [Node.js](https://nodejs.org/) 22+ and npm
- WebView2 runtime (preinstalled on Windows 11; the installer bootstraps it otherwise)

## How local URLs work

Every web server binds port 80 and 443 on **its own loopback address** —
nginx on `127.0.0.1`, Apache on `127.0.0.2`, Caddy on `127.0.0.3`,
FrankenPHP on `127.0.0.4` — so site URLs stay bare with no reverse proxy
and no extra process in between:

| Site server | `http://myapp.test` reaches | `https://myapp.test` reaches |
| ----------- | --------------------------- | ---------------------------- |
| nginx | `127.0.0.1:80` | `127.0.0.1:443` |
| Apache | `127.0.0.2:80` | `127.0.0.2:443` |
| Caddy / FrankenPHP | `127.0.0.3` / `127.0.0.4`, port 80 | via their own TLS config |

Name resolution follows the same mapping: each hostname and alias points at
its owning server, through the hosts file and through the bundled resolver
alike. A custom port override is still honoured when set, and then the URL
honestly shows the `:port` suffix.

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

## Process supervision

Every backing service runs as a supervised child process (`devx-proc`). A
supervisor spawns the process, waits for a health check (TCP address, log
pattern, or uptime) before reporting `Running`, captures output to a rotating
log file and an in-memory tail, and restarts on failure within a retry budget
with backoff. TCP health checks dial the address the service actually bound —
each web server on its own loopback — so a check can neither hang against an
empty address nor pass against the wrong server on the same port.

The critical Windows detail is orphan-proofing: each child is assigned to a
[job object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When DevX exits — cleanly or by
crashing — the kernel closes the job handle and terminates every child with it.
No `mysqld` left holding a port after a crash, the failure mode that plagues
XAMPP and Laragon.

### Service definitions

Thirteen supervisable components (Nginx, Caddy, Traefik, FrankenPHP,
Apache, MariaDB, PostgreSQL, MongoDB, Redis, NATS, etcd, Mailpit and
Meilisearch)
each have a declarative `ServiceDefinition`
(`devx-provision`): its default port, config files rendered from templates, any
one-time init step (`initdb`, `mariadb-install-db`), the launch command, and how
readiness is observed. Rendering and init are pure/idempotent — an init step
only runs when its data-directory marker is absent — so re-running setup never
corrupts an initialised database.

Ports are allocated with conflict detection: DevX enumerates listening ports and
their owning processes (`GetExtendedTcpTable`), and if a preferred port is taken
it either reassigns to the next free one or reports who holds it.

The services (nginx, caddy, traefik, frankenphp, apache, mariadb,
postgresql, mongodb, redis, nats-server, etcd, mailpit, meilisearch) are
verified
against real binaries by the `live_service` tests.

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

The shipped `php.ini-production` (fallback `php.ini-development`) is the
single source of truth: commented means off, uncommented means on. The UI
lists short names merged from that file and the DLLs on disk
(`php_curl.dll`, `curl` and `"curl"` are all `curl`); toggling a switch
comments or uncomments the ini line itself — appending under a `; DevX
managed` marker when the name has no line yet — so a hand-edited ini and
the UI can never disagree. Names without a DLL on disk are listed but
cannot be enabled, so the UI can never ask for an ini PHP refuses to start
with. The pool's generated `php.ini` renders from the same ini state:
ordinary `extension =` lines, except `opcache` and `xdebug`, which must
load through `zend_extension` or PHP refuses to start. Saving while the
pool is running re-renders and restarts it, so the change applies
immediately. (`config.toml` still mirrors toggles for older readers, but
nothing consults it anymore.)

### Sites and per-server routing

A *site* (`devx-provision::sites`) is a host name, a document root and the PHP
version that serves it — the unit users actually think in. Sites live in
`config.toml` under `[[sites]]`, and each one is rendered to exactly one
server block file on its **owning** web server, e.g.
`service-config/apache/sites/<hostname>.conf` for an Apache site:

- The block binds the server's loopback explicitly (`<VirtualHost 127.0.0.2:80>`,
  `listen 127.0.0.1:80;`), never a wildcard — a wildcard listen would steal
  the other servers' traffic.
- PHP sites route `\.php$` to the chosen pool: nginx via `fastcgi_pass` read
  from the pool's rendered `pool.conf` (never hardcoded, so ports follow
  pools), Apache via `mod_proxy_fcgi` against plain `php-cgi`, with the
  standard front-controller fallback (`PATH_INFO`, `try_files` to
  `index.php`), so Laravel-style routing works out of the box.
- Static sites get a plain file-serving block (`=404` fallback, no PHP
  reference).
- Every mutation re-syncs the include directories and prunes blocks for
  removed sites, so disk state always equals configured state and restarts
  are deterministic. Starting a service re-syncs first, healing any stale
  state left by an older DevX.

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
site's block as `fastcgi_param` lines (nginx) or `SetEnv` lines (Apache),
so `getenv` and frameworks like Laravel see them without a committed
`.env`. Validation keeps the blocks unbreakable — variable-name shapes, no
newlines, and no server metacharacters — and saving while the owning server
is running restarts it, so changes apply immediately.

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
`aliases` list, rendered into the `server_name` line (or `ServerAlias`)
alongside the primary name and validated for shape plus uniqueness across
every site and alias. Certificates cover aliases in their SANs and are
reissued when the alias set changes; the bundled resolver answers alias
lookups like any other `.test` name. Aliases are edited per site on the
Sites page, and saving restarts the owning server when it is running.

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

Operations that need elevation — the `hosts` file, the certificate store,
NRPT rules, the DNS cache flush — never run inside the desktop app. They go
to a separate `devx-helper` service, executed elevated and installed by the
DevX installer, over a named pipe whose two ends live in separate crates so
they cannot drift:

- `devx-ipc` owns the wire protocol: versioned JSON requests and replies
  (`Hello`, `ListHostsEntries`, `AddHostsEntry`, `RemoveHostsEntry`,
  `FlushDns`, `InstallCa`/`CheckCa`/`RemoveCa`,
  `SetNrptRule`/`RemoveNrptRule`, `Shutdown`), host-name, IP, namespace and
  PEM validation, and a length-prefixed frame codec with a hard 1 MiB cap.
- `devx-privileged` owns the client: it opens the pipe with
  `SECURITY_IDENTIFICATION` SQoS (the helper may identify the caller but
  never act as it), and every session begins with a version handshake that
  both sides refuse on mismatch.
- `devx-helper` owns the server: the pipe is created with a protected DACL
  (`D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;WD)`), and every request is
  re-validated at the boundary before anything is written.

Hosts mutations are confined to lines ending in `# devx-managed`. The
helper can add, update and remove its own entries, but it refuses to
shadow or delete a line it did not write, so hand-crafted overrides —
including other local stacks' entries — survive DevX and the helper cannot
be conned into rewriting them. All edits are atomic whole-file rewrites.
The Hosts panel's one-click re-sync rewrites every site name with its
owner's loopback and reports any name a foreign line blocks, with what to
remove by hand.

### Local CA and automatic HTTPS

HTTPS for `*.test` sites comes from a miniature PKI DevX owns end to end:

- `devx-provision::pki` generates one local **root CA** on first use
  (`data/certs/ca.crt` + `ca.key.pem`) and issues a **server certificate
  per HTTPS site** into `data/certs/sites/<hostname>/`, signed by that CA.
  Certificates cover the hostname plus its aliases and are reissued only
  when that set changes: a re-rendered server block never churns a cert a
  browser already saw.
- Installing the root into the machine trust store needs elevation, so it
  goes through the helper (`InstallCa`/`CheckCa`/`RemoveCa` requests). The
  helper imports only single, shape-validated certificates into the
  machine **Root** store under the `DevX Local CA` friendly name — nothing
  else in the store is reachable through the protocol.
- HTTPS sites serve both schemes: nginx gets `listen 80` plus
  `listen 443 ssl`, Apache a second `VirtualHost` with `SSLEngine on`,
  each pointing at the site's issued certificate. Enabling HTTPS therefore
  requires the CA (installed once from the Sites page) but nothing else.

### Name resolution: hosts file and bundled resolver

Two mechanisms route `.test` names to their owning server, and both map
each name to that server's loopback — never a single shared address:

- **Hosts file** (default): one managed entry per hostname and alias,
  rewritten on every site mutation and on every web-server start, so stale
  entries cannot linger after an update.
- **Bundled resolver** (`devx-dns`): a small RFC 1035 UDP server answering
  `A` queries. Exact hostnames and aliases resolve from a live map the app
  keeps equal to the configured sites (no resolver restart needed);
  deeper names fall back to the longest registered parent suffix, so
  `api.myapp.test` follows `myapp.test`; anything else keeps the plain
  loopback answer. Short TTLs (5 s) so a stopped resolver is honoured
  quickly. Routing `.test` queries to it is done with an NRPT rule —
  Windows consults the rule table before ordinary DNS — written by the
  helper (`SetNrptRule`/`RemoveNrptRule`) into the machine policy key under
  a fixed, DevX-owned GUID, confined to the single configured suffix so the
  pipe can never redirect other traffic. Non-`.test` names never touch
  DevX, so corporate DNS and VPN setups are untouched.

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
One `cloudflared tunnel --url http://<owner-loopback>:<http-port>` process
runs per shared site through the ordinary supervisor, so lifecycle,
logging and crash handling are inherited rather than reinvented.

- The tunnel forwards to the owning server's loopback and live HTTP port,
  so the public URL reaches the same server block the local `.test` host
  name does — PHP pools, HTTPS sites and static sites all just work. Only
  loopback targets are accepted: a share is a bridge to something DevX
  itself serves, never a proxy for an arbitrary remote host.
- The assigned `https://…trycloudflare.com` URL is parsed from the
  process log (`devx_provision::tunnel::extract_tunnel_url`), matched
  defensively against the quick-tunnel suffix so other cloudflared URLs
  never leak into the UI.
- Quick tunnels are ephemeral by design — stopping the share kills the
  process and the URL dies with it, which is exactly what a dev tool
  wants. For named, persistent tunnels, run cloudflared with your own
  config alongside DevX.

### Tray, autostart, session restore and updates

The desktop shell behaves like a Windows developer utility, not a one-shot
window:

- **Tray** — right-clicking the notification-area icon opens a custom popup
  (route `/tray`: frameless, transparent, always-on-top) styled like the
  app itself, because a native OS menu cannot be styled. It shows site
  quick-open entries, a close-to-tray toggle, Show DevX and Quit;
  left-click still shows the main window. The popup positions itself at
  the click, clamped to the monitor, and dismisses on blur or Escape.
  Closing the main window hides it to the tray when `close_to_tray` is
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
  offline machine must not get a red banner for a missed HTTP call. When an
  update is available, one click downloads the published installer, verifies
  it against the release's own SHA256SUMS, launches it (Windows raises its
  own UAC prompt — DevX never elevates itself), and exits so files can be
  replaced. A manual download link stays alongside for anyone who prefers it.

### `devx` CLI companion

`crates/devx-cli` builds the `devx` binary, a script-friendly window into
the same state the desktop app manages. Both frontends share the on-disk
contract (`devx-core::ConfigStore`, `devx-provision::sites`), so the app and
the CLI converge on identical config and server blocks without talking to
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
| `github_releases` | Caddy, Traefik, FrankenPHP, PostgreSQL, Redis, Mailpit, Meilisearch, cloudflared, Bun, Deno, ripgrep, jq, NATS, etcd | GitHub releases API, asset `digest` or a checksum asset |
| `go_dev` | Go | `go.dev/dl` manifest with an inline SHA-256 per artifact |
| `pinned` | Nginx, Apache, MariaDB, MongoDB, Python, Composer | Versions and hashes recorded in the catalog |

### Integrity policy

**A version with no obtainable SHA-256 is not offered at all.** Releases whose
checksum the upstream never published are reported separately in the UI rather
than presented as installable, so a download is never unverified. This is why
older GitHub releases of some components do not appear: GitHub only began
recording asset digests recently.

It is also why MySQL is absent. Oracle publishes only an MD5, on a page that
blocks direct fetches, so DevX cannot verify the 300 MB ZIP. MariaDB speaks the
same wire protocol and is offered instead.

MinIO was removed for the same reason in reverse: in September 2026 the
upstream archived every community release (`410 Gone` from
`dl.min.io/server/minio/release`), so the pinned artifact became
undownloadable and the component can no longer be honestly offered.

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

The frontend never calls `invoke` directly. Commands are declared across
`apps/desktop/src-tauri/src/commands/` plus a few shell-owned modules,
registered in `src/ipc.rs`, and `tauri-specta` generates
`apps/desktop/src/bindings.ts`, which is committed so the frontend
type-checks without a Rust build.

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

## License

MIT
