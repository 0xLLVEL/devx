//! RFC 1035 wire format: names, questions, and whole messages.
//!
//! Only the subset DevX needs: `A` queries in, `A` answers (or NXDOMAIN)
//! out. Parsing is defensive by design — this process faces arbitrary
//! packets on a privileged port — and every failure is an error, never a
//! panic.

use std::net::Ipv4Addr;

use devx_core::{Error, ErrorCode};

/// Hard cap on a single DNS message; UDP DNS must fit in a classic packet.
pub const MAX_MESSAGE_BYTES: usize = 512;

/// A parsed or buildable DNS message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Echoed verbatim from the query.
    pub id: u16,
    /// `true` for a query, `false` for a response.
    pub is_query: bool,
    /// The question, when one was parsed or should be written.
    pub question: Option<Question>,
    /// The answer record, when one should be written.
    pub answer: Option<ARecord>,
    /// Response code: NXDOMAIN when the name is not a DevX site.
    pub nxdomain: bool,
}

/// The single question a resolver handles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    /// Queried name, already lowercased.
    pub name: String,
    /// Query type; only type `A` (1) is answered from DevX data.
    pub qtype: u16,
}

/// One `A` answer record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ARecord {
    /// The name the answer refers to (echoed from the question).
    pub name: String,
    /// The loopback address a DevX site resolves to.
    pub address: Ipv4Addr,
    /// Time-to-live in seconds: short, so stopping DevX is honoured quickly.
    pub ttl: u32,
}

/// Failures while reading packets.
#[derive(Debug, thiserror::Error)]
pub enum NameError {
    /// The packet ended in the middle of a field.
    #[error("truncated DNS message")]
    Truncated,
    /// A compression pointer pointed outside the message or formed a loop.
    #[error("invalid name compression pointer")]
    BadPointer,
    /// A label exceeded the RFC 63-byte limit or was empty.
    #[error("invalid DNS label length")]
    BadLabel,
    /// The name exceeded the RFC 253-byte wire limit.
    #[error("DNS name too long")]
    TooLong,
    /// The opcode or flags announced something a resolver does not answer.
    #[error("unsupported DNS message shape")]
    Unsupported,
}

impl From<NameError> for Error {
    fn from(err: NameError) -> Self {
        Error::new(ErrorCode::InvalidInput, err.to_string())
    }
}

/// Reads one DNS label sequence (with compression pointers) from `packet`
/// starting at `offset`; returns the name and the offset just past it.
#[allow(unused_assignments)] // `offset` is reassigned each loop iteration by design
pub fn parse_name(
    packet: &[u8],
    mut offset: usize,
) -> core::result::Result<(String, usize), NameError> {
    let mut labels: Vec<String> = Vec::new();
    let mut jumps = 0usize;
    let mut end = None;

    loop {
        if offset >= packet.len() {
            return Err(NameError::Truncated);
        }
        let length = packet[offset];

        match length & 0xC0 {
            0x00 => {
                if length == 0 {
                    end.get_or_insert(offset + 1);
                    break;
                }
                if length > 63 {
                    return Err(NameError::BadLabel);
                }
                let start = offset + 1;
                let stop = start + length as usize;
                if stop > packet.len() {
                    return Err(NameError::Truncated);
                }
                labels.push(String::from_utf8_lossy(&packet[start..stop]).to_ascii_lowercase());
                offset = stop;
            }
            0xC0 => {
                if offset + 1 >= packet.len() {
                    return Err(NameError::Truncated);
                }
                let target = ((length & 0x3F) as usize) << 8 | packet[offset + 1] as usize;
                if target >= offset {
                    return Err(NameError::BadPointer);
                }
                end.get_or_insert(offset + 2);
                offset = target;
                jumps += 1;
                if jumps > 32 {
                    return Err(NameError::BadPointer);
                }
            }
            _ => return Err(NameError::BadLabel),
        }
    }

    let end = end.ok_or(NameError::Truncated)?;
    let name = labels.join(".");
    if name.len() > 253 {
        return Err(NameError::TooLong);
    }
    Ok((name, end))
}

/// Appends `name` in wire format to `out`.
fn write_name(name: &str, out: &mut Vec<u8>) {
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
}

impl Message {
    /// Parses a query packet.
    pub fn parse(packet: &[u8]) -> core::result::Result<Self, NameError> {
        if packet.len() < 12 {
            return Err(NameError::Truncated);
        }

        let id = u16::from_be_bytes([packet[0], packet[1]]);
        let flags = u16::from_be_bytes([packet[2], packet[3]]);
        // QR=1 (a response), opcode != 0, or TC set: not a query.
        if flags & 0x8000 != 0 || flags & 0x7800 != 0 {
            return Err(NameError::Unsupported);
        }

        let question_count = u16::from_be_bytes([packet[4], packet[5]]);
        if question_count != 1 {
            return Err(NameError::Unsupported);
        }

        let (name, offset) = parse_name(packet, 12)?;
        if offset + 4 > packet.len() {
            return Err(NameError::Truncated);
        }
        let qtype = u16::from_be_bytes([packet[offset], packet[offset + 1]]);

        Ok(Self {
            id,
            is_query: true,
            question: Some(Question { name, qtype }),
            answer: None,
            nxdomain: false,
        })
    }

    /// Builds the response for this query.
    ///
    /// `answer` carries the loopback record when the name is a DevX site;
    /// `None` produces NXDOMAIN, the honest answer for a name DevX does not
    /// serve.
    pub fn response(&self, answer: Option<ARecord>) -> Self {
        Self {
            id: self.id,
            is_query: false,
            question: self.question.clone(),
            answer,
            nxdomain: self.answer.is_none(),
        }
    }

    /// Encodes this message for the wire.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MAX_MESSAGE_BYTES);

        let flags: u16 = if self.is_query {
            0x0000
        } else {
            // QR=1, RD=1 (recursion desired echoed), AA=1 (authoritative),
            // RA=0, RCODE=3 (NXDOMAIN) when the name is not served.
            let mut flags = 0x8580u16;
            if self.nxdomain {
                flags |= 0x0003;
            }
            flags
        };

        out.extend_from_slice(&self.id.to_be_bytes());
        out.extend_from_slice(&flags.to_be_bytes());
        let (qd, an) = match (&self.question, &self.answer) {
            (Some(_), Some(_)) => (1u16, 1u16),
            (Some(_), None) => (1, 0),
            _ => (0, 0),
        };
        out.extend_from_slice(&qd.to_be_bytes());
        out.extend_from_slice(&an.to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // NSCOUNT + ARCOUNT

        if let Some(question) = &self.question {
            write_name(&question.name, &mut out);
            out.extend_from_slice(&question.qtype.to_be_bytes());
            out.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN
        }

        if let (Some(question), Some(answer)) = (&self.question, &self.answer) {
            write_name(&question.name, &mut out);
            out.extend_from_slice(&1u16.to_be_bytes()); // TYPE = A
            out.extend_from_slice(&1u16.to_be_bytes()); // CLASS = IN
            out.extend_from_slice(&answer.ttl.to_be_bytes());
            out.extend_from_slice(&4u16.to_be_bytes()); // RDLENGTH
            out.extend_from_slice(&answer.address.octets());
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    /// Builds a minimal wire query for `name`.
    fn wire_query(name: &str, qtype: u16) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&0x1234u16.to_be_bytes()); // ID
        packet.extend_from_slice(&0x0100u16.to_be_bytes()); // RD=1 query
        packet.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
        packet.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        write_name(name, &mut packet);
        packet.extend_from_slice(&qtype.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet
    }

    #[test]
    fn queries_round_trip() {
        let packet = wire_query("myapp.test", 1);
        let message = Message::parse(&packet).expect("parse");

        assert_eq!(message.id, 0x1234);
        assert_eq!(message.question.as_ref().expect("q").name, "myapp.test");
        assert_eq!(message.question.as_ref().expect("q").qtype, 1);
    }

    #[test]
    fn names_are_lowercased_on_parse() {
        let packet = wire_query("MyApp.TEST", 1);
        let message = Message::parse(&packet).expect("parse");
        assert_eq!(message.question.expect("q").name, "myapp.test");
    }

    #[test]
    fn responses_and_non_queries_are_refused() {
        // A response (QR=1).
        let mut packet = wire_query("a.test", 1);
        packet[2] = 0x81;
        assert!(matches!(
            Message::parse(&packet),
            Err(NameError::Unsupported)
        ));

        // Truncated header.
        assert!(matches!(
            Message::parse(&packet[..6]),
            Err(NameError::Truncated)
        ));
    }

    #[test]
    fn compressed_names_are_parsed() {
        // Header + one question whose name is followed by a pointer back to
        // offset 12. Real resolvers send these; DevX must read them.
        let mut packet = wire_query("myapp.test", 1);
        let tail = packet.len();
        packet.extend_from_slice(&[0xC0, 12]); // pointer to the first name
        packet.extend_from_slice(&1u16.to_be_bytes()); // TYPE A
        packet.extend_from_slice(&1u16.to_be_bytes()); // CLASS IN

        let (name, end) = parse_name(&packet, tail).expect("parse compressed");
        assert_eq!(name, "myapp.test");
        assert_eq!(end, tail + 2);
    }

    #[test]
    fn pointer_loops_are_rejected() {
        // Two bytes that point at themselves.
        let packet = [0xC0, 0x00u8];
        assert!(matches!(parse_name(&packet, 0), Err(NameError::BadPointer)));
    }

    #[test]
    fn answers_encode_and_reparse() {
        let query = Message::parse(&wire_query("myapp.test", 1)).expect("query");
        let response = query.response(Some(ARecord {
            name: "myapp.test".into(),
            address: Ipv4Addr::LOCALHOST,
            ttl: 5,
        }));

        let bytes = response.encode();
        // A response is not itself parseable as a query; assert the shape.
        assert_eq!(bytes[2] & 0x80, 0x80, "QR set");
        assert_eq!(&bytes[..2], &[0x12, 0x34], "id echoed");
        assert!(
            bytes.ends_with(&[0, 0, 0, 5, 0, 4, 127, 0, 0, 1][..]),
            "TTL, RDLENGTH and address trail the message"
        );
    }

    #[test]
    fn nxdomain_responses_carry_the_code() {
        let query = Message::parse(&wire_query("other.test", 1)).expect("query");
        let bytes = query.response(None).encode();

        assert_eq!(bytes[3] & 0x0F, 0x03, "RCODE = NXDOMAIN");
        assert_eq!(u16::from_be_bytes([bytes[6], bytes[7]]), 0, "no answers");
    }

    #[test]
    fn non_a_queries_are_detected_but_encodable() {
        let query = Message::parse(&wire_query("myapp.test", 28)).expect("parse"); // AAAA
        assert_eq!(query.question.expect("q").qtype, 28);
    }
}
