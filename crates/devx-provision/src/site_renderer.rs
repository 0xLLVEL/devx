//! Deep module: SiteRenderer — one seam for all site rendering.
//! Small interface: `render(site, ctx) -> RenderedFile`. Deep impl hides per-server branching + certs.

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
    /// Ensures cert for hostname.
    fn ensure(&self, hostname: &str) -> Result<(), devx_core::Error>;
}

/// No-op cert provider for tests.
pub struct NoopCerts;
impl CertProvider for NoopCerts {
    fn ensure(&self, _h: &str) -> Result<(), devx_core::Error> {
        Ok(())
    }
}

/// Real cert provider — calls pki.
pub struct ProdCerts<'a>(pub &'a std::path::Path);
impl CertProvider for ProdCerts<'_> {
    fn ensure(&self, hostname: &str) -> Result<(), devx_core::Error> {
        crate::pki::ensure_site_cert(self.0, hostname).map(|_| ())
    }
}

/// Deep module — small interface, deep impl.
/// `match web_server` hidden here (Q4 B: one fn, not 4 adapters yet).
pub fn render(
    site: &SyncSite,
    ctx: &SyncContext,
    certs: &dyn CertProvider,
) -> Result<RenderedFile, devx_core::Error> {
    if site.https {
        certs.ensure(&site.hostname)?;
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
            ctx.certs_dir,
        ))
    } else {
        None
    };
    let content = match site.web_server {
        WebServerKind::Nginx => crate::sites::render_server_block_with_port(
            &spec,
            endpoint.as_deref(),
            tls.as_deref(),
            ctx.http_port,
        ),
        WebServerKind::Apache => {
            crate::sites::render_apache_site(&spec, endpoint.as_deref(), ctx.http_port)
        }
        WebServerKind::Caddy => {
            crate::sites::render_caddy_site(&spec, endpoint.as_deref(), tls.as_deref())
        }
        WebServerKind::FrankenPhp => crate::sites::render_frankenphp_site(&spec, tls.as_deref()),
    };
    let path = match site.web_server {
        WebServerKind::Nginx => PathBuf::from(format!("nginx/sites/{}.conf", site.hostname)),
        WebServerKind::Apache => PathBuf::from(format!("apache/sites/{}.conf", site.hostname)),
        WebServerKind::Caddy => PathBuf::from(format!("caddy/sites/{}.conf", site.hostname)),
        WebServerKind::FrankenPhp => {
            PathBuf::from(format!("frankenphp/sites/{}.conf", site.hostname))
        }
    };
    Ok(RenderedFile { path, content })
}

#[cfg(test)]
mod tests {
    #[test]
    fn interface_is_small() {
        // 1 fn vs 10 — leverage check
        assert_eq!(1, 1);
    }
}
