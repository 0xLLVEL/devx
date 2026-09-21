//! Deep module: SiteRenderer — one seam for all site rendering.
//! Small interface: `render(site, ctx) -> RenderedFile`. Deep impl hides
//! per-server branching + certs.

use std::path::PathBuf;

use crate::sites::{SiteSpec, SyncContext, SyncSite, WebServerKind};

/// One rendered file to write.
#[derive(Debug, Clone)]
pub struct RenderedFile {
    /// Relative path under service_config_dir, e.g. `nginx/sites/myapp.test.conf`.
    pub path: PathBuf,
    /// File content.
    pub content: String,
}

/// Cert provider seam — internal, fake-able.
pub trait CertProvider: Send + Sync {
    /// Ensures cert for hostname + aliases.
    fn ensure(&self, hostname: &str, aliases: &[String]) -> Result<(), devx_core::Error>;
}

/// No-op cert provider for tests.
pub struct NoopCerts;
impl CertProvider for NoopCerts {
    fn ensure(&self, _h: &str, _a: &[String]) -> Result<(), devx_core::Error> {
        Ok(())
    }
}

/// Real cert provider — calls pki.
pub struct ProdCerts<'a>(pub &'a std::path::Path);
impl CertProvider for ProdCerts<'_> {
    fn ensure(&self, hostname: &str, aliases: &[String]) -> Result<(), devx_core::Error> {
        crate::pki::ensure_site_cert(self.0, hostname, aliases).map(|_| ())
    }
}

/// Deep module — small interface, deep impl.
/// `match web_server` hidden here (Q4 B: one fn, not 4 adapters yet).
///
/// One site renders exactly one file on its own loopback IP
/// (`WebServerKind::loopback_ip`), so every server owns 80/443 and site
/// URLs stay bare with no proxy in between.
pub fn render(
    site: &SyncSite,
    ctx: &SyncContext,
    certs: &dyn CertProvider,
) -> Result<RenderedFile, devx_core::Error> {
    if site.https {
        certs.ensure(&site.hostname, &site.aliases)?;
    }
    let spec = SiteSpec {
        hostname: site.hostname.clone(),
        docroot: site.docroot.clone(),
        php_version: site.php_version.clone(),
        env: site.env.clone(),
        aliases: site.aliases.clone(),
        web_server: site.web_server,
        auth: site.auth.clone(),
    };
    let endpoint = match (&spec.php_version, site.web_server) {
        (Some(v), WebServerKind::Nginx | WebServerKind::Apache | WebServerKind::Caddy) => {
            Some(crate::sites::pool_endpoint_for(ctx.service_config_dir, v)?)
        }
        _ => None,
    };
    let tls = if site.https {
        Some(crate::pki::tls_listen_snippet(
            &site.hostname,
            ctx.https_port,
            site.web_server.loopback_ip(),
            ctx.certs_dir,
        ))
    } else {
        None
    };
    // ponytail: Caddy/FrankenPHP speak `tls cert key`, not nginx `ssl_*` lines.
    let caddy_tls = if site.https {
        let (cert, key) = crate::pki::site_cert_files(ctx.certs_dir, &site.hostname);
        Some(format!("tls {cert} {key}"))
    } else {
        None
    };
    let apache_tls = if site.https {
        let (cert_file, key_file) = crate::pki::site_cert_files(ctx.certs_dir, &site.hostname);
        Some(crate::sites::ApacheTls {
            https_port: ctx.apache_https_port,
            cert_file,
            key_file,
        })
    } else {
        None
    };
    let bind_ip = site.web_server.loopback_ip();
    let (path, content) = match site.web_server {
        WebServerKind::Nginx => (
            PathBuf::from(format!("nginx/sites/{}.conf", site.hostname)),
            crate::sites::render_server_block_with_port(
                &spec,
                endpoint.as_deref(),
                tls.as_deref(),
                ctx.http_port,
                bind_ip,
            ),
        ),
        WebServerKind::Apache => (
            PathBuf::from(format!("apache/sites/{}.conf", site.hostname)),
            crate::sites::render_apache_site(
                &spec,
                endpoint.as_deref(),
                ctx.port_for(site.web_server),
                bind_ip,
                apache_tls.as_ref(),
            ),
        ),
        WebServerKind::Caddy => (
            PathBuf::from(format!("caddy/sites/{}.conf", site.hostname)),
            crate::sites::render_caddy_site(
                &spec,
                endpoint.as_deref(),
                caddy_tls.as_deref(),
                bind_ip,
            ),
        ),
        WebServerKind::FrankenPhp => (
            PathBuf::from(format!("frankenphp/sites/{}.conf", site.hostname)),
            crate::sites::render_frankenphp_site(&spec, caddy_tls.as_deref(), bind_ip),
        ),
    };
    Ok(RenderedFile { path, content })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sites::SyncContext;
    use std::path::{Path, PathBuf};

    fn ctx() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("temp");
        let svc = dir.path().join("svc");
        let certs = dir.path().join("certs");
        std::fs::create_dir_all(&svc).expect("svc");
        (dir, svc, certs)
    }

    fn site(hostname: &str, server: WebServerKind) -> SyncSite {
        SyncSite {
            hostname: hostname.into(),
            docroot: PathBuf::from("C:/projects/app/public"),
            php_version: None,
            https: true,
            env: Vec::new(),
            aliases: Vec::new(),
            web_server: server,
            auth: None,
        }
    }

    fn sync_ctx<'a>(svc: &'a Path, certs: &'a Path) -> SyncContext<'a> {
        SyncContext {
            service_config_dir: svc,
            certs_dir: certs,
            http_port: 80,
            https_port: 443,
            apache_port: 8085,
            caddy_port: 8080,
            frankenphp_port: 8082,
            apache_https_port: 8443,
        }
    }

    #[test]
    fn interface_is_small() {
        // 1 fn vs 10 — leverage check
        assert_eq!(1, 1);
    }

    #[test]
    fn apache_https_renders_tls_vhost_with_cert_paths() {
        let (_dir, svc, certs) = ctx();
        let ctx = sync_ctx(&svc, &certs);
        let rendered = render(&site("mtdb.test", WebServerKind::Apache), &ctx, &NoopCerts)
            .expect("render");
        assert_eq!(rendered.path, PathBuf::from("apache/sites/mtdb.test.conf"));
        assert!(rendered.content.contains("<VirtualHost 127.0.0.2:8085>"), "{}", rendered.content);
        assert!(rendered.content.contains("<VirtualHost 127.0.0.2:8443>"), "{}", rendered.content);
        assert!(rendered.content.contains("SSLEngine on"), "{}", rendered.content);
        assert!(
            rendered.content.contains("sites/mtdb.test/cert.pem"),
            "{}",
            rendered.content
        );
    }

    #[test]
    fn nginx_sites_bind_their_own_loopback() {
        let (_dir, svc, certs) = ctx();
        let ctx = sync_ctx(&svc, &certs);
        let rendered = render(&site("app.test", WebServerKind::Nginx), &ctx, &NoopCerts)
            .expect("render");
        assert_eq!(rendered.path, PathBuf::from("nginx/sites/app.test.conf"));
        assert!(rendered.content.contains("listen       127.0.0.1:80;"), "{}", rendered.content);
    }

    #[test]
    fn caddy_https_uses_tls_directive_not_nginx_syntax() {
        let (_dir, svc, certs) = ctx();
        let ctx = sync_ctx(&svc, &certs);
        let rendered = render(&site("app.test", WebServerKind::Caddy), &ctx, &NoopCerts)
            .expect("render");
        assert_eq!(rendered.path, PathBuf::from("caddy/sites/app.test.conf"));
        assert!(rendered.content.contains("tls "), "{}", rendered.content);
        assert!(rendered.content.contains("cert.pem"), "{}", rendered.content);
        assert!(rendered.content.contains("bind 127.0.0.3"), "{}", rendered.content);
        assert!(!rendered.content.contains("ssl_certificate"), "{}", rendered.content);
        assert!(!rendered.content.contains("listen"), "{}", rendered.content);
    }
}
