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
struct Lines {
    buffer: Vec<u8>,
    /// A `\r` ended the previous chunk; a leading `\n` belongs to it.
    after_cr: bool,
}

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
pub struct SdkDecoder {
    lines: Lines,
    event: Option<String>,
    data: Vec<String>,
}

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
pub struct NativeDecoder {
    buffer: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl NativeDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=newline).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
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
