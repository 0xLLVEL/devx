//! Archive extraction with path-traversal protection and layout normalisation.
//!
//! Extraction is a security boundary: an archive is untrusted input, and a
//! malicious or malformed entry must never write outside the destination
//! directory (a "zip slip"). Every entry path is validated before a single byte
//! is written.
//!
//! Extraction also normalises layout. Windows archives are inconsistent: some
//! wrap everything in one versioned directory, others put files at the root.
//! [`StripPrefix`] decides how many leading components to drop so installed
//! trees look the same regardless of how upstream packaged them.

use std::path::{Component, Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};

use crate::catalog::{ArchiveKind, StripPrefix};

/// Extracts `archive` of kind `kind` into `dest`, applying `strip`.
///
/// `dest` must already exist and should be empty; callers extract into a
/// staging directory and rename it into place afterwards.
pub fn extract(
    archive: &Path,
    dest: &Path,
    kind: ArchiveKind,
    strip: StripPrefix,
    executable_name: Option<&str>,
) -> Result<()> {
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest, strip),
        ArchiveKind::TarGz => extract_tar_gz(archive, dest, strip),
        ArchiveKind::Executable => place_executable(archive, dest, executable_name),
    }
}

/// Copies a bare executable download into `dest` under its configured name.
fn place_executable(archive: &Path, dest: &Path, executable_name: Option<&str>) -> Result<()> {
    let name = executable_name
        .ok_or_else(|| Error::config("an executable artifact requires layout.executable_name"))?;

    std::fs::create_dir_all(dest).map_err(|err| io_error(err, dest, "create destination"))?;
    let target = dest.join(name);
    std::fs::copy(archive, &target).map_err(|err| io_error(err, &target, "copy executable"))?;
    Ok(())
}

/// Extracts a zip archive.
fn extract_zip(archive: &Path, dest: &Path, strip: StripPrefix) -> Result<()> {
    let file =
        std::fs::File::open(archive).map_err(|err| io_error(err, archive, "open archive"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("{} is not a valid zip: {err}", archive.display()),
        )
    })?;

    let strip_count = resolve_strip_count(zip_top_level(&mut zip)?, strip);

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read zip entry: {err}")))?;

        // `enclosed_name` returns None for anything that would escape the root
        // (absolute paths, `..`), which is our zip-slip guard.
        let Some(name) = entry.enclosed_name() else {
            return Err(zip_slip_error(entry.name()));
        };

        let Some(relative) = strip_components(&name, strip_count) else {
            continue;
        };

        let out_path = dest.join(&relative);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|err| io_error(err, &out_path, "create directory"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_error(err, parent, "create directory"))?;
        }

        let mut out = std::fs::File::create(&out_path)
            .map_err(|err| io_error(err, &out_path, "create file"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|err| io_error(err, &out_path, "write file"))?;
    }

    Ok(())
}

/// Extracts a gzip-compressed tarball.
fn extract_tar_gz(archive: &Path, dest: &Path, strip: StripPrefix) -> Result<()> {
    // A first pass finds the common top-level directory so `Auto` can decide
    // whether to strip it, then a second pass extracts. Reading twice avoids
    // buffering the whole (large) archive in memory.
    let top_level = tar_top_level(archive)?;
    let strip_count = resolve_strip_count(top_level, strip);

    let file =
        std::fs::File::open(archive).map_err(|err| io_error(err, archive, "open archive"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);

    for entry in tar
        .entries()
        .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read tarball: {err}")))?
    {
        let mut entry = entry
            .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read tar entry: {err}")))?;
        let path = entry
            .path()
            .map_err(|err| {
                Error::new(
                    ErrorCode::Io,
                    format!("tar entry has an invalid path: {err}"),
                )
            })?
            .into_owned();

        if !is_safe_relative(&path) {
            return Err(zip_slip_error(&path.to_string_lossy()));
        }

        let Some(relative) = strip_components(&path, strip_count) else {
            continue;
        };

        let out_path = dest.join(&relative);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_error(err, parent, "create directory"))?;
        }

        entry
            .unpack(&out_path)
            .map_err(|err| io_error(err, &out_path, "unpack tar entry"))?;
    }

    Ok(())
}

/// Resolves the number of leading components to strip for a given policy.
fn resolve_strip_count(single_top_level: Option<String>, strip: StripPrefix) -> usize {
    match strip {
        StripPrefix::None => 0,
        StripPrefix::Components(count) => count as usize,
        // Strip exactly one level, but only when everything shares one wrapper
        // directory; otherwise stripping would discard real content.
        StripPrefix::Auto => usize::from(single_top_level.is_some()),
    }
}

/// The shared top-level directory of a zip, if there is exactly one.
fn zip_top_level<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<Option<String>> {
    let mut names = Vec::with_capacity(zip.len());
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read zip entry: {err}")))?;
        if let Some(name) = entry.enclosed_name() {
            names.push(name);
        }
    }
    Ok(single_top_level(&names))
}

/// The shared top-level directory of a tarball, if there is exactly one.
fn tar_top_level(archive: &Path) -> Result<Option<String>> {
    let file =
        std::fs::File::open(archive).map_err(|err| io_error(err, archive, "open archive"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);

    let mut names = Vec::new();
    for entry in tar
        .entries()
        .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read tarball: {err}")))?
    {
        let entry = entry
            .map_err(|err| Error::new(ErrorCode::Io, format!("failed to read tar entry: {err}")))?;
        let path = entry
            .path()
            .map_err(|err| {
                Error::new(
                    ErrorCode::Io,
                    format!("tar entry has an invalid path: {err}"),
                )
            })?
            .into_owned();
        if is_safe_relative(&path) {
            names.push(path);
        }
    }
    Ok(single_top_level(&names))
}

/// Returns the sole top-level directory shared by every path, if any.
fn single_top_level(paths: &[PathBuf]) -> Option<String> {
    let mut top: Option<String> = None;

    for path in paths {
        let first = path.components().next()?;
        let Component::Normal(component) = first else {
            return None;
        };
        let component = component.to_string_lossy().into_owned();

        match &top {
            None => top = Some(component),
            Some(existing) if *existing == component => {}
            // More than one distinct top-level entry: nothing to strip.
            Some(_) => return None,
        }
    }

    top
}

/// Drops `count` leading components, returning `None` if nothing remains.
fn strip_components(path: &Path, count: usize) -> Option<PathBuf> {
    let mut components = path.components();
    for _ in 0..count {
        components.next()?;
    }

    let remaining: PathBuf = components.as_path().to_path_buf();
    (!remaining.as_os_str().is_empty()).then_some(remaining)
}

/// Whether a tar entry path is a safe relative path (no `..`, not absolute).
fn is_safe_relative(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Error for an entry that would escape the destination directory.
fn zip_slip_error(name: &str) -> Error {
    Error::new(
        ErrorCode::Integrity,
        format!("archive entry `{name}` would extract outside the target directory"),
    )
    .with_hint("the archive may be malicious; DevX refuses to extract it")
}

/// Wraps an IO error with context.
fn io_error(err: std::io::Error, path: &Path, action: &str) -> Error {
    Error::new(
        ErrorCode::Io,
        format!("failed to {action} at {}: {err}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a zip in memory from `(name, contents)` pairs.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, contents) in entries {
                writer.start_file(*name, options).expect("start file");
                writer.write_all(contents).expect("write");
            }
            writer.finish().expect("finish");
        }
        buffer
    }

    fn write_zip(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join("archive.zip");
        std::fs::write(&path, build_zip(entries)).expect("write zip");
        path
    }

    #[test]
    fn extracts_a_flat_zip_without_stripping() {
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = write_zip(dir.path(), &[("php.exe", b"MZ"), ("php.ini", b"[PHP]")]);
        let dest = dir.path().join("out");

        extract(&archive, &dest, ArchiveKind::Zip, StripPrefix::None, None).expect("extract");

        assert_eq!(std::fs::read(dest.join("php.exe")).expect("php.exe"), b"MZ");
        assert_eq!(
            std::fs::read(dest.join("php.ini")).expect("php.ini"),
            b"[PHP]"
        );
    }

    #[test]
    fn auto_strips_a_single_wrapper_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = write_zip(
            dir.path(),
            &[
                ("node-v26.5.0-win-x64/node.exe", b"MZ"),
                ("node-v26.5.0-win-x64/npm.cmd", b"@echo"),
            ],
        );
        let dest = dir.path().join("out");

        extract(&archive, &dest, ArchiveKind::Zip, StripPrefix::Auto, None).expect("extract");

        // The wrapper directory is gone; files sit at the root.
        assert!(dest.join("node.exe").is_file());
        assert!(dest.join("npm.cmd").is_file());
        assert!(!dest.join("node-v26.5.0-win-x64").exists());
    }

    #[test]
    fn auto_keeps_files_when_there_is_no_single_wrapper() {
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = write_zip(dir.path(), &[("php.exe", b"MZ"), ("ext/redis.dll", b"x")]);
        let dest = dir.path().join("out");

        extract(&archive, &dest, ArchiveKind::Zip, StripPrefix::Auto, None).expect("extract");

        // Two distinct top-level entries: nothing should be stripped.
        assert!(dest.join("php.exe").is_file());
        assert!(dest.join("ext").join("redis.dll").is_file());
    }

    #[test]
    fn rejects_a_zip_slip_entry() {
        // `enclosed_name` refuses `..` traversal, so a crafted name is caught.
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = write_zip(dir.path(), &[("../escape.txt", b"pwned")]);
        let dest = dir.path().join("out");

        let err = extract(&archive, &dest, ArchiveKind::Zip, StripPrefix::None, None)
            .expect_err("must reject traversal");
        assert_eq!(err.code, ErrorCode::Integrity);

        // Nothing was written outside the destination.
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn places_a_bare_executable_under_its_configured_name() {
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = dir.path().join("download.bin");
        std::fs::write(&archive, b"MZexe").expect("write");
        let dest = dir.path().join("out");

        extract(
            &archive,
            &dest,
            ArchiveKind::Executable,
            StripPrefix::None,
            Some("minio.exe"),
        )
        .expect("place executable");

        assert_eq!(
            std::fs::read(dest.join("minio.exe")).expect("minio.exe"),
            b"MZexe"
        );
    }

    #[test]
    fn explicit_component_count_is_honoured() {
        let dir = tempfile::tempdir().expect("temp dir");
        let archive = write_zip(dir.path(), &[("a/b/file.txt", b"deep")]);
        let dest = dir.path().join("out");

        extract(
            &archive,
            &dest,
            ArchiveKind::Zip,
            StripPrefix::Components(2),
            None,
        )
        .expect("extract");

        assert_eq!(std::fs::read(dest.join("file.txt")).expect("file"), b"deep");
    }

    #[test]
    fn single_top_level_detection() {
        assert_eq!(
            single_top_level(&[PathBuf::from("wrap/a"), PathBuf::from("wrap/b/c")]),
            Some("wrap".to_owned())
        );
        assert_eq!(
            single_top_level(&[PathBuf::from("a"), PathBuf::from("b")]),
            None
        );
        assert_eq!(single_top_level(&[]), None);
    }

    #[test]
    fn is_safe_relative_rejects_traversal_and_absolute() {
        assert!(is_safe_relative(Path::new("a/b/c.txt")));
        assert!(is_safe_relative(Path::new("./a")));
        assert!(!is_safe_relative(Path::new("../a")));
        assert!(!is_safe_relative(Path::new("/etc/passwd")));
    }
}
