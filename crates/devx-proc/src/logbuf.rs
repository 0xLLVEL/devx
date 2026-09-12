//! In-memory ring buffer of recent log lines.
//!
//! The UI shows a live tail of each service's output. Keeping the whole log in
//! memory would be unbounded, so a fixed-capacity ring holds the most recent
//! lines; the full history lives in the rotated log files on disk (see
//! [`crate::logfile`]). Lines are numbered monotonically so the frontend can
//! request "everything after line N" without gaps or duplicates.

use std::collections::VecDeque;

use serde::Serialize;

/// One captured output line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct LogLine {
    /// Monotonic sequence number, starting at 1.
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    /// Which stream it came from.
    pub stream: LogStream,
    /// The line text, without its trailing newline.
    pub text: String,
}

/// Which standard stream a line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

/// A bounded, monotonically-numbered buffer of recent log lines.
#[derive(Debug)]
pub struct LogRing {
    lines: VecDeque<LogLine>,
    capacity: usize,
    next_seq: u64,
}

impl LogRing {
    /// Creates a ring holding at most `capacity` lines.
    ///
    /// A capacity of zero is treated as one, since a buffer that keeps nothing
    /// is never what the caller wants.
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            capacity: capacity.max(1),
            next_seq: 1,
        }
    }

    /// Appends a line, evicting the oldest if the buffer is full.
    ///
    /// Returns the assigned sequence number.
    pub fn push(&mut self, stream: LogStream, text: impl Into<String>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;

        self.lines.push_back(LogLine {
            seq,
            stream,
            text: text.into(),
        });

        while self.lines.len() > self.capacity {
            self.lines.pop_front();
        }

        seq
    }

    /// Every line currently retained, oldest first.
    pub fn snapshot(&self) -> Vec<LogLine> {
        self.lines.iter().cloned().collect()
    }

    /// Lines with a sequence number strictly greater than `after`.
    ///
    /// Lines evicted since `after` are gone; the caller sees the retained
    /// suffix, which is the correct behaviour for a tail view.
    pub fn since(&self, after: u64) -> Vec<LogLine> {
        self.lines
            .iter()
            .filter(|line| line.seq > after)
            .cloned()
            .collect()
    }

    /// The highest sequence number assigned so far, or 0 if none.
    pub fn latest_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Number of lines currently retained.
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// Whether the buffer holds no lines.
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn assigns_monotonic_sequence_numbers() {
        let mut ring = LogRing::new(10);
        assert_eq!(ring.push(LogStream::Stdout, "one"), 1);
        assert_eq!(ring.push(LogStream::Stderr, "two"), 2);
        assert_eq!(ring.latest_seq(), 2);
    }

    #[test]
    fn evicts_oldest_beyond_capacity_but_keeps_numbering() {
        let mut ring = LogRing::new(2);
        ring.push(LogStream::Stdout, "a");
        ring.push(LogStream::Stdout, "b");
        ring.push(LogStream::Stdout, "c");

        let lines = ring.snapshot();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "b");
        assert_eq!(lines[0].seq, 2, "sequence numbers survive eviction");
        assert_eq!(lines[1].text, "c");
        assert_eq!(lines[1].seq, 3);
    }

    #[test]
    fn since_returns_only_newer_lines() {
        let mut ring = LogRing::new(10);
        for text in ["a", "b", "c"] {
            ring.push(LogStream::Stdout, text);
        }

        let tail = ring.since(1);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].text, "b");

        assert!(ring.since(3).is_empty(), "nothing newer than the latest");
        assert_eq!(ring.since(0).len(), 3, "everything is newer than 0");
    }

    #[test]
    fn since_after_eviction_returns_the_retained_suffix() {
        let mut ring = LogRing::new(2);
        for text in ["a", "b", "c", "d"] {
            ring.push(LogStream::Stdout, text);
        }
        // a and b evicted; asking for lines after 1 yields the retained c, d.
        let tail = ring.since(1);
        assert_eq!(
            tail.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            ["c", "d"]
        );
    }

    #[test]
    fn zero_capacity_is_clamped_to_one() {
        let mut ring = LogRing::new(0);
        ring.push(LogStream::Stdout, "a");
        ring.push(LogStream::Stdout, "b");
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.snapshot()[0].text, "b");
    }
}
