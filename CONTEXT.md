# CONTEXT — DevX Domain Glossary

Domain language for deep modules. Good seams are named here.

- **Site** — a hostname + docroot + phpVersion + https + env + aliases + auth + webServer. Unit the user thinks in. Persisted in `config.toml [[sites]]`, rendered to one block on the owning server (`service-config/<server>/sites/<host>.conf`). One Config::Site = one server block on its own loopback (nginx `.1`, Apache `.2`, Caddy `.3`, FrankenPHP `.4`), so every URL stays bare with no proxy.

- **SiteOrchestrator** — deep module that owns site mutations. Small interface (`add`, `remove`, `setEnv`, `setAliases`, `setHttps`) behind one seam. Deep implementation hides validate → ConfigStore::update → sync_site_blocks → ensure_site_cert → reconcile_hosts → restart owner server, with snapshot+replace rollback. This is the correct seam for site atomicity. (Candidate 1, grilled 2026-09-18: location src-tauri/site_orchestrator.rs, interface 5 explicit methods, behind-seam hosts/certs/restarter as internal fakes, atomicity config-first+rollback).

- **Pool** — one supervised `php-cgi` per installed PHP version, on its own port. `PhpPool` deep module owns port alloc + pool.conf truth + render + restart. (Candidate 2)

- **Service** — 13 supervised backing services (nginx, mariadb, etc.) with declarative `ServiceDefinition`. Plan + prepare + register + start.

- **HostReconciliation** — syncing `*.test` names to their owning server's loopback via hosts file or bundled resolver + NRPT, kept in step with sites.

- **Provision** — catalog + resolver + download → verify → extract → promote. Nothing installs without SHA-256.

- **Paths** — `AppPaths` (config_dir, data_dir, service_config_dir, certs_dir, runtimes_dir) — the filesystem seam.
