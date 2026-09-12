//! Security descriptor for the helper's named pipe.
//!
//! The helper creates its pipe with a DACL expressed in SDDL (Security
//! Descriptor Definition Language). A pipe whose DACL is wrong turns the
//! helper into a privilege-escalation service, so the descriptor is built in
//! one place, parsed back for verification, and shared by the helper (which
//! applies it) and tests (which assert its shape).
//!
//! Meaning of the descriptor built by [`helper_pipe_sddl`]:
//!
//! * `D:` — DACL section.
//! * `P` — protected: inherited ACEs are ignored.
//! * `(A;;GA;;;SY)` — LocalSystem (the helper's account) gets generic all.
//! * `(A;;GA;;;BA)` — Administrators keep full control for servicing.
//! * `(A;;GRGW;;;WD)` — the interactive user (Everyone at connect time) may
//!   open the pipe to *talk*, which is what impersonation then gates.
//!
//! The write-side risk is bounded by design: the helper validates every
//! request against its allow-list and impersonates the caller during the
//! privileged step, so a low- integrity writer cannot widen what runs.

use devx_core::{Error, Result};

/// Marker the helper's `Hello` response must carry to be trusted.
///
/// Kept beside the SDDL because both answer "is this really our helper?".
pub const HELPER_PROTOCOL_MARKER: &str = "devx-helper";

/// The SDDL string the helper's pipe is created with.
pub fn helper_pipe_sddl() -> String {
    "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;WD)".to_owned()
}

/// Minimal structural validation of an SDDL string.
///
/// The full grammar is large; what matters here is catching a truncated or
/// hand-mangled descriptor before it reaches `CreateNamedPipeW`, where a
/// wrong-but-valid ACL would silently weaken the pipe. Checks that the DACL
/// flag is present, the flag field is present, and every ACE is
/// parenthesised with the six semicolon-separated fields.
pub fn validate_sddl(sddl: &str) -> Result<()> {
    let body = sddl.strip_prefix("D:").ok_or_else(|| {
        Error::invalid_input(format!("`{sddl}` is not a DACL: it must start with `D:`"))
    })?;

    // Everything before the first ACE parenthesis is the flag field.
    let flags_end = body
        .find('(')
        .ok_or_else(|| Error::invalid_input("SDDL has no ACEs"))?;
    let flags = &body[..flags_end];
    if !flags.contains('P') {
        return Err(Error::invalid_input(
            "SDDL must be protected against inherited ACEs (flag `P`)",
        ));
    }

    let aces = &body[flags_end..];
    let mut depth = 0usize;
    let mut current = String::new();
    let mut seen_ace = false;

    for ch in aces.chars() {
        match ch {
            '(' => {
                depth += 1;
                if depth > 1 {
                    return Err(Error::invalid_input("nested ACE parenthesis"));
                }
                current.clear();
            }
            ')' => {
                if depth == 0 {
                    return Err(Error::invalid_input("unbalanced ACE parenthesis"));
                }
                depth -= 1;
                validate_ace(&current)?;
                seen_ace = true;
            }
            other if depth > 0 => current.push(other),
            other => {
                return Err(Error::invalid_input(format!(
                    "unexpected character `{other}` outside an ACE"
                )))
            }
        }
    }

    if depth != 0 {
        return Err(Error::invalid_input("unterminated ACE"));
    }
    if !seen_ace {
        return Err(Error::invalid_input("SDDL has no ACEs"));
    }

    Ok(())
}

/// Validates one ACE body: `type;flags;rights;object_guid;inherit_guid;trustee`.
///
/// Real SDDL puts the rights in the third field and the trustee (a two-letter
/// alias like `SY`, or a full `S-1-…` SID) last.
fn validate_ace(ace: &str) -> Result<()> {
    let fields: Vec<&str> = ace.split(';').collect();
    if fields.len() != 6 {
        return Err(Error::invalid_input(format!(
            "ACE `{ace}` must have six semicolon-separated fields"
        )));
    }
    let type_ok = fields[0]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase());
    if fields[0].len() != 1 || !type_ok {
        return Err(Error::invalid_input(format!(
            "ACE `{ace}` must start with an ACE type letter"
        )));
    }
    if fields[2].is_empty() {
        return Err(Error::invalid_input(format!(
            "ACE `{ace}` must carry an access-rights mask"
        )));
    }
    if fields[5].is_empty() {
        return Err(Error::invalid_input(format!(
            "ACE `{ace}` must name a trustee"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn the_helper_descriptor_is_valid_and_protected() {
        let sddl = helper_pipe_sddl();
        assert_eq!(sddl, "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;WD)");
        validate_sddl(&sddl).expect("the shipped descriptor must validate");
    }

    #[test]
    fn the_descriptor_grants_least_privilege() {
        let sddl = helper_pipe_sddl();
        assert!(sddl.contains("(A;;GA;;;SY)"), "SYSTEM needs full control");
        assert!(
            sddl.contains("(A;;GA;;;BA)"),
            "admins keep servicing access"
        );
        assert!(
            sddl.contains("(A;;GRGW;;;WD)"),
            "the interactive user may only read and write the pipe"
        );
        assert!(
            !sddl.contains("GA;;;WD"),
            "Everyone must not hold generic all"
        );
    }

    #[test]
    fn validation_rejects_broken_descriptors() {
        for bad in [
            "",
            "P(A;;GA;;;SY)",              // no D:
            "D:(A;;GA;;;SY)",             // not protected
            "D:P",                        // no ACEs
            "D:P(A;;GA)",                 // truncated ACE
            "D:P(A;;GA;;;SY)(A;;GA;;;SY", // unbalanced
            "D:P(;;)",                    // wrong field count
            "D:P(AA;;GA;;;SY)",           // bad type letter
            "D:P(A;;;;;;SY)",             // no rights mask
            "D:P(A;;GA;;;)",              // no trustee
        ] {
            assert!(validate_sddl(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn marker_is_stable() {
        assert_eq!(HELPER_PROTOCOL_MARKER, "devx-helper");
    }
}
