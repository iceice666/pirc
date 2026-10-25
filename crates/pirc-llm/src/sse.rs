//! `text/event-stream` decoders. The two TS transports parse SSE
//! differently, and the differences decide which events a truncated stream
//! still delivers, so each keeps its own decoder.

/// One dispatched event.
#[derive(Debug, PartialEq)]
pub struct Event {
    /// `None` when no `event:` field was given.
    pub event: Option<String>,
    pub data: String,
}

/// Splits bytes into lines ending in `\n`, `\r\n` or `\r`.
#[derive(Default)]
#[cfg(any(
    test,
    any(feature = "openai-completions", feature = "openai-responses")
))]
struct Lines {
    buffer: Vec<u8>,
    /// A `\r` ended the previous chunk; a leading `\n` belongs to it.
    after_cr: bool,
}

#[cfg(any(
    test,
    any(feature = "openai-completions", feature = "openai-responses")
))]
impl Lines {
    fn push(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        let mut bytes = bytes;
        if self.after_cr && bytes.first() == Some(&b'\n') {
            bytes = &bytes[1..];
        }
        self.after_cr = false;
        let mut start = 0;
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\n' | b'\r' => {
                    self.buffer.extend_from_slice(&bytes[start..index]);
                    out.push(String::from_utf8_lossy(&self.buffer).into_owned());
                    self.buffer.clear();
                    if bytes[index] == b'\r' {
                        if bytes.get(index + 1) == Some(&b'\n') {
                            index += 1;
                        } else if index + 1 == bytes.len() {
                            self.after_cr = true;
                        }
                    }
                    index += 1;
                    start = index;
                }
                _ => index += 1,
            }
        }
        self.buffer.extend_from_slice(&bytes[start..]);
    }

    fn flush(&mut self, out: &mut Vec<String>) {
        if !self.buffer.is_empty() {
            out.push(String::from_utf8_lossy(&self.buffer).into_owned());
            self.buffer.clear();
        }
    }
}

fn field(line: &str) -> (&str, &str) {
    let (name, value) = line.split_once(':').unwrap_or((line, ""));
    (name, value.strip_prefix(' ').unwrap_or(value))
}

/// The OpenAI SDK's decoder (`openai` 6.26.0 `core/streaming`): an event
/// dispatches on a blank line if it has an `event` or `data` field; a last
/// event without a blank line after it is dropped.
#[derive(Default)]
#[cfg(any(
    test,
    any(feature = "openai-completions", feature = "openai-responses")
))]
pub struct SdkDecoder {
    lines: Lines,
    event: Option<String>,
    data: Vec<String>,
}

#[cfg(any(
    test,
    any(feature = "openai-completions", feature = "openai-responses")
))]
impl SdkDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut lines = Vec::new();
        self.lines.push(bytes, &mut lines);
        self.decode(lines)
    }

    pub fn finish(&mut self) -> Vec<Event> {
        let mut lines = Vec::new();
        self.lines.flush(&mut lines);
        self.decode(lines)
    }

    fn decode(&mut self, lines: Vec<String>) -> Vec<Event> {
        let mut events = Vec::new();
        for line in lines {
            if line.is_empty() {
                let has_event = self.event.as_deref().is_some_and(|e| !e.is_empty());
                if !has_event && self.data.is_empty() {
                    continue;
                }
                events.push(Event {
                    event: self.event.take(),
                    data: std::mem::take(&mut self.data).join("\n"),
                });
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (name, value) = field(&line);
            match name {
                "event" => self.event = Some(value.to_owned()),
                "data" => self.data.push(value.to_owned()),
                _ => {}
            }
        }
        events
    }
}

/// The native transports' decoder (`sse()` in `agent/providers/types.ts`):
/// lines end in `\n`; an event dispatches on a blank line if it has data,
/// and a pending event is still delivered when the body ends.
#[derive(Default)]
#[cfg(any(test, any(feature = "openai-chat", feature = "anthropic-messages")))]
pub struct NativeDecoder {
    buffer: Vec<u8>,
    /// Bytes already checked for a newline in the retained partial line.
    scanned: usize,
    event: String,
    data: Vec<String>,
}

#[cfg(any(test, any(feature = "openai-chat", feature = "anthropic-messages")))]
impl NativeDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.buffer[self.scanned..].iter().position(|&b| b == b'\n') {
            let newline = self.scanned + offset;
            let line = &self.buffer[start..newline];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let line = String::from_utf8_lossy(line);
            start = newline + 1;
            self.scanned = start;
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(Event {
                        event: Some(std::mem::replace(&mut self.event, "message".to_owned())),
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                self.event = "message".to_owned();
            } else if !line.starts_with(':') {
                let (name, value) = field(&line);
                match name {
                    "event" => self.event = value.to_owned(),
                    "data" => self.data.push(value.to_owned()),
                    _ => {}
                }
            }
        }
        // Compact once per push, not once per line. On the next push only
        // newly appended bytes need scanning; decode UTF-8 only at line ends.
        self.scanned = self.buffer.len() - start;
        if start != 0 {
            self.buffer.drain(..start);
        }
        events
    }

    pub fn finish(&mut self) -> Option<Event> {
        (!self.data.is_empty()).then(|| Event {
            event: Some(std::mem::take(&mut self.event)),
            data: std::mem::take(&mut self.data).join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(events: &[Event]) -> Vec<&str> {
        events.iter().map(|event| event.data.as_str()).collect()
    }

    fn sdk_chunks(chunks: &[&[u8]]) -> Vec<Event> {
        let mut decoder = SdkDecoder::default();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.push(chunk));
        }
        events.extend(decoder.finish());
        events
    }

    fn native_chunks(chunks: &[&[u8]]) -> Vec<Event> {
        let mut decoder = NativeDecoder::default();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.push(chunk));
        }
        events.extend(decoder.finish());
        events
    }

    #[test]
    fn sdk_byte_partitions_preserve_crlf_utf8_and_eof() {
        let bytes = b": hi\r\nevent: e\r\ndata: caf\xc3\xa9\r\ndata: \xff\xe2\x82\r\n\r\nevent: only\n\nevent: dropped\ndata: tail";
        let expected = vec![
            Event {
                event: Some("e".to_owned()),
                data: "caf\u{e9}\n\u{fffd}\u{fffd}".to_owned(),
            },
            Event {
                event: Some("only".to_owned()),
                data: String::new(),
            },
        ];
        assert_eq!(sdk_chunks(&[bytes]), expected);
        // Every pair of byte boundaries, including inside UTF-8 and CRLF.
        // Chunks are nonempty: an empty push has its own after-CR behavior.
        for first in 1..bytes.len() {
            for second in first + 1..bytes.len() {
                assert_eq!(
                    sdk_chunks(&[&bytes[..first], &bytes[first..second], &bytes[second..]]),
                    expected,
                    "cuts {first}, {second}"
                );
            }
        }
        assert_eq!(sdk_chunks(&bytes.chunks(1).collect::<Vec<_>>()), expected);
    }

    #[test]
    fn native_byte_partitions_preserve_utf8_and_unterminated_line_drop() {
        let bytes = b"event: e\r\ndata: caf\xc3\xa9\r\ndata: \xff\xe2\x82\n\nevent: ignored\n\ndata: pending\ndata: unterminated";
        let expected = vec![
            Event {
                event: Some("e".to_owned()),
                data: "caf\u{e9}\n\u{fffd}\u{fffd}".to_owned(),
            },
            Event {
                event: Some("message".to_owned()),
                data: "pending".to_owned(),
            },
        ];
        assert_eq!(native_chunks(&[bytes]), expected);
        for first in 1..bytes.len() {
            for second in first + 1..bytes.len() {
                assert_eq!(
                    native_chunks(&[&bytes[..first], &bytes[first..second], &bytes[second..]]),
                    expected,
                    "cuts {first}, {second}"
                );
            }
        }
        assert_eq!(
            native_chunks(&bytes.chunks(1).collect::<Vec<_>>()),
            expected
        );
    }

    #[test]
    fn native_only_lf_ends_lines_and_eof_does_not_parse_tail() {
        assert_eq!(
            native_chunks(&[b"event: e\ndata: a\rdata: b\n"]),
            vec![Event {
                event: Some("e".to_owned()),
                data: "a\rdata: b".to_owned(),
            }]
        );
        assert!(native_chunks(&[b"data: tail"]).is_empty());
        assert_eq!(
            sdk_chunks(&[b"data: a\r\r"]),
            vec![Event {
                event: None,
                data: "a".to_owned(),
            }]
        );
    }

    #[test]
    fn sdk_empty_push_after_cr_preserves_existing_behavior() {
        // An empty read clears after_cr, so LF is a separate blank line.
        assert_eq!(
            sdk_chunks(&[b"event: e\r", b"", b"\ndata: tail"]),
            vec![Event {
                event: Some("e".to_owned()),
                data: String::new(),
            }]
        );
    }

    #[test]
    fn sdk_decoder_needs_a_blank_line() {
        let mut decoder = SdkDecoder::default();
        let mut events = decoder.push(b"data: a\r\n\r\ndata: b\ndata:c\n\n: comment\n\nevent: x\n");
        events.extend(decoder.push(b"\ndata: tail"));
        events.extend(decoder.finish());
        assert_eq!(data(&events), ["a", "b\nc", ""]);
        assert_eq!(events[2].event.as_deref(), Some("x"));
    }

    #[test]
    fn sdk_decoder_handles_split_crlf() {
        let mut decoder = SdkDecoder::default();
        let mut events = decoder.push(b"data: a\r");
        events.extend(decoder.push(b"\n\r"));
        events.extend(decoder.push(b"\n"));
        assert_eq!(data(&events), ["a"]);
    }

    #[test]
    fn native_decoder_delivers_a_pending_event() {
        let mut decoder = NativeDecoder::default();
        let mut events = decoder.push(b"data: a\n\nevent: e\n\ndata: b\r\n");
        events.extend(decoder.push(b"data: c"));
        events.extend(decoder.finish());
        assert_eq!(data(&events), ["a", "b"]);
    }
}
