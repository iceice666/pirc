//! pi-ai's own SSE reader for Anthropic (`iterateSseMessages`): it does not
//! use the SDK's decoder. Lines end at the first `\r` or `\n` in what has
//! arrived so far (so a `\r\n` split across reads gives an extra blank
//! line), an event is dispatched when it has an `event` or `data` field, and
//! the last event is delivered even without a blank line after it.

/// One dispatched event.
#[derive(Debug, PartialEq)]
pub struct SseMessage {
    /// `None` when no `event:` field was given.
    pub event: Option<String>,
    pub data: String,
    /// Every non-blank line of the event, comments included.
    pub raw: Vec<String>,
}

#[derive(Default)]
pub struct Decoder {
    /// Undecoded bytes after the last line break. Lines are decoded whole,
    /// which gives `TextDecoder`'s replacement characters: line breaks are
    /// ASCII and never split a UTF-8 sequence.
    buffer: Vec<u8>,
    /// Bytes already checked for CR/LF in the retained partial line.
    scanned: usize,
    event: Option<String>,
    data: Vec<String>,
    raw: Vec<String>,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseMessage> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.buffer[self.scanned..]
            .iter()
            .position(|&b| b == b'\r' || b == b'\n')
        {
            let end = self.scanned + offset;
            let line = String::from_utf8_lossy(&self.buffer[start..end]).into_owned();
            start = end + 1;
            if self.buffer[end] == b'\r' && self.buffer.get(start) == Some(&b'\n') {
                start += 1;
            }
            self.scanned = start;
            out.extend(self.line(line));
        }
        // Preserve Pi's chunk-sensitive CRLF handling: only consume LF with
        // CR when both arrived in this push. Compact just once per push.
        self.scanned = self.buffer.len() - start;
        if start != 0 {
            self.buffer.drain(..start);
        }
        out
    }

    /// The body ended: the unterminated last line, then any pending event.
    pub fn finish(&mut self) -> Vec<SseMessage> {
        let mut out = Vec::new();
        if !self.buffer.is_empty() {
            let line = String::from_utf8_lossy(&self.buffer).into_owned();
            self.buffer.clear();
            self.scanned = 0;
            out.extend(self.line(line));
        }
        out.extend(self.flush());
        out
    }

    fn flush(&mut self) -> Option<SseMessage> {
        let has_event = self.event.as_deref().is_some_and(|event| !event.is_empty());
        if !has_event && self.data.is_empty() {
            return None;
        }
        Some(SseMessage {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
            raw: std::mem::take(&mut self.raw),
        })
    }

    fn line(&mut self, line: String) -> Option<SseMessage> {
        if line.is_empty() {
            return self.flush();
        }
        if !line.starts_with(':') {
            let (name, value) = line.split_once(':').unwrap_or((&line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match name {
                "event" => self.event = Some(value.to_owned()),
                "data" => self.data.push(value.to_owned()),
                _ => {}
            }
        }
        self.raw.push(line);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> Vec<(Option<String>, String)> {
        let mut decoder = Decoder::default();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(decoder.push(chunk));
        }
        out.extend(decoder.finish());
        out.into_iter().map(|m| (m.event, m.data)).collect()
    }

    #[test]
    fn splits_lines_like_pi_ai() {
        let some = |s: &str| Some(s.to_owned());
        assert_eq!(
            decode(&[b"event: a\r\ndata: 1\r\rdata:2\ndata: 3\n\n: c\nevent\n\n"]),
            [(some("a"), "1".to_owned()), (None, "2\n3".to_owned())]
        );
        // A CR ending a read is a line end; the LF after it a blank line.
        assert_eq!(
            decode(&[b"event: a\r", b"\ndata: 1\n\n"]),
            [(some("a"), String::new()), (None, "1".to_owned())]
        );
        // The last event needs no blank line.
        assert_eq!(
            decode(&[b"event: e\ndata: x"]),
            [(some("e"), "x".to_owned())]
        );
        assert_eq!(
            decode(&[b"data: caf\xc3", b"\xa9\n\n"]),
            [(None, "caf\u{e9}".to_owned())]
        );
    }

    fn messages(chunks: &[&[u8]]) -> Vec<SseMessage> {
        let mut decoder = Decoder::default();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(decoder.push(chunk));
        }
        out.extend(decoder.finish());
        out
    }

    #[test]
    fn lf_byte_partitions_preserve_raw_utf8_and_eof() {
        let bytes =
            b": hi\nevent: e\ndata: caf\xc3\xa9\ndata: \xff\xe2\x82\n\nevent: tail\ndata: last";
        let expected = vec![
            SseMessage {
                event: Some("e".to_owned()),
                data: "caf\u{e9}\n\u{fffd}\u{fffd}".to_owned(),
                raw: vec![
                    ": hi".to_owned(),
                    "event: e".to_owned(),
                    "data: caf\u{e9}".to_owned(),
                    "data: \u{fffd}\u{fffd}".to_owned(),
                ],
            },
            SseMessage {
                event: Some("tail".to_owned()),
                data: "last".to_owned(),
                raw: vec!["event: tail".to_owned(), "data: last".to_owned()],
            },
        ];
        assert_eq!(messages(&[bytes]), expected);
        for first in 1..bytes.len() {
            for second in first + 1..bytes.len() {
                assert_eq!(
                    messages(&[&bytes[..first], &bytes[first..second], &bytes[second..]]),
                    expected,
                    "cuts {first}, {second}"
                );
            }
        }
        assert_eq!(messages(&bytes.chunks(1).collect::<Vec<_>>()), expected);
    }

    #[test]
    fn crlf_byte_splits_keep_pi_chunk_sensitivity() {
        let bytes = b"event: e\r\ndata: caf\xc3\xa9\r\n";
        let together = vec![SseMessage {
            event: Some("e".to_owned()),
            data: "caf\u{e9}".to_owned(),
            raw: vec!["event: e".to_owned(), "data: caf\u{e9}".to_owned()],
        }];
        let split = vec![
            SseMessage {
                event: Some("e".to_owned()),
                data: String::new(),
                raw: vec!["event: e".to_owned()],
            },
            SseMessage {
                event: None,
                data: "caf\u{e9}".to_owned(),
                raw: vec!["data: caf\u{e9}".to_owned()],
            },
        ];
        for cut in 1..bytes.len() {
            let expected = if &bytes[..cut] == b"event: e\r" {
                &split
            } else {
                &together
            };
            assert_eq!(
                &messages(&[&bytes[..cut], &bytes[cut..]]),
                expected,
                "cut {cut}"
            );
        }
        assert_eq!(messages(&bytes.chunks(1).collect::<Vec<_>>()), split);
    }

    #[test]
    fn keeps_raw_lines() {
        let mut decoder = Decoder::default();
        let events = decoder.push(b": hi\nevent: x\ndata: y\n\n");
        assert_eq!(events[0].raw, [": hi", "event: x", "data: y"]);
    }
}
