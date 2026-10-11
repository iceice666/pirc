//! JSONL framing of the agent's stdout (`node/rpc-framing.ts`). Owner:
//! **runner**.
//!
//! LF only: a line ending in `\r` is an error ("RPC protocol requires
//! LF-only framing"); empty lines are skipped; each line, complete or still
//! buffered, is limited to `max_line_bytes` UTF-8 bytes; the total is not
//! (an agent streams for as long as it lives, so a cap on the running total
//! would eventually kill any long-lived session). A multi-byte character
//! split across reads is reassembled. Golden cases: `rpc-framing.test.ts`.
//! Outbound lines are `JSON + "\n"`.
//!
//! Differences from TS, none reachable from the Rust agent: bytes that are
//! not UTF-8 become U+FFFD as in Node's `StringDecoder`, but count as one
//! byte towards the limit, not three; `JSON.parse` error texts are
//! serde_json's; JSON nested deeper than 128 levels or holding lone
//! surrogate escapes is an error (serde_json's limits).

use serde_json::Value;

/// `JsonlParser`.
pub struct JsonlParser {
    max_line_bytes: usize,
    buffer: Vec<u8>,
}

impl JsonlParser {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes,
            buffer: Vec::new(),
        }
    }

    /// Hand the value of every complete line in `chunk` to `on_value`, in
    /// order. A framing error, or the first error `on_value` returns, ends
    /// the push with that error (TS threw out of `push`; the runner then
    /// kills the agent), after the values before it were handled.
    pub fn push(
        &mut self,
        chunk: &[u8],
        mut on_value: impl FnMut(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut start = self.buffer.len();
        self.buffer.extend_from_slice(chunk);
        let mut consumed = 0;
        let result = loop {
            let Some(offset) = self.buffer[start..].iter().position(|&byte| byte == b'\n') else {
                break Ok(());
            };
            let end = start + offset;
            let line = &self.buffer[consumed..end];
            consumed = end + 1;
            start = consumed;
            if line.len() > self.max_line_bytes {
                break Err("RPC line limit exceeded".to_owned());
            }
            if line.last() == Some(&b'\r') {
                break Err("RPC protocol requires LF-only framing".to_owned());
            }
            if line.is_empty() {
                continue;
            }
            let text = String::from_utf8_lossy(line);
            match serde_json::from_str::<Value>(&text) {
                Ok(value) => {
                    if let Err(error) = on_value(value) {
                        break Err(error);
                    }
                }
                Err(error) => break Err(error.to_string()),
            }
        };
        self.buffer.drain(..consumed);
        result?;
        // `StringDecoder` holds back an incomplete trailing character, so
        // it does not count yet.
        if self.buffer.len() - incomplete_tail(&self.buffer) > self.max_line_bytes {
            return Err("RPC line limit exceeded".to_owned());
        }
        Ok(())
    }

    /// The stream ended: an unterminated line is an error.
    pub fn end(&mut self) -> Result<(), String> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err("RPC stream ended with an unterminated JSON line".to_owned())
        }
    }
}

/// How many bytes at the end of `bytes` start a UTF-8 character that is
/// not complete yet.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=3.min(bytes.len()) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let width = match byte {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return 0,
        };
        return if width > back { back } else { 0 };
    }
    0
}

/// An outbound line: `JSON.stringify(value) + "\n"`.
pub fn line(value: &Value) -> String {
    let mut line = value.to_string();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn collect(
        parser: &mut JsonlParser,
        chunk: &[u8],
        values: &mut Vec<Value>,
    ) -> Result<(), String> {
        parser.push(chunk, |value| {
            values.push(value);
            Ok(())
        })
    }

    // rpc-framing.test.ts: "preserves split UTF-8 and treats only LF as framing"
    #[test]
    fn preserves_split_utf8() {
        let mut values = Vec::new();
        let mut parser = JsonlParser::new(1024);
        let bytes = "{\"text\":\"☃ still-one-line\"}\n".as_bytes();
        collect(&mut parser, &bytes[..11], &mut values).unwrap();
        collect(&mut parser, &bytes[11..], &mut values).unwrap();
        parser.end().unwrap();
        assert_eq!(values, [json!({ "text": "☃ still-one-line" })]);
    }

    // "rejects CRLF and unterminated lines"
    #[test]
    fn rejects_crlf_and_unterminated_lines() {
        let error = JsonlParser::new(100)
            .push(b"{}\r\n", |_| Ok(()))
            .unwrap_err();
        assert!(error.contains("LF-only"), "{error}");
        let mut parser = JsonlParser::new(100);
        parser.push(b"{}", |_| Ok(())).unwrap();
        assert!(parser.end().unwrap_err().contains("unterminated"));
    }

    // "bounds a single line, complete or still buffered"
    #[test]
    fn bounds_a_single_line() {
        let error = JsonlParser::new(2).push(b"{}{}\n", |_| Ok(())).unwrap_err();
        assert!(error.contains("line limit"));
        let error = JsonlParser::new(2).push(b"{\"a\"", |_| Ok(())).unwrap_err();
        assert!(error.contains("line limit"));
        // An incomplete character does not count until it is complete.
        let snowman = "☃".as_bytes();
        let mut parser = JsonlParser::new(2);
        parser.push(&snowman[..2], |_| Ok(())).unwrap();
        assert!(
            parser
                .push(&snowman[2..], |_| Ok(()))
                .unwrap_err()
                .contains("line limit")
        );
    }

    // "never limits the total a long-lived agent writes"
    #[test]
    fn never_limits_the_total() {
        let mut count = 0;
        let mut parser = JsonlParser::new(1024);
        let line = line(&json!({ "pad": "x".repeat(1000) }));
        for _ in 0..20_000 {
            parser
                .push(line.as_bytes(), |_| {
                    count += 1;
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(count, 20_000);
    }

    #[test]
    fn values_before_an_error_are_handled_and_empty_lines_skipped() {
        let mut values = Vec::new();
        let error = collect(
            &mut JsonlParser::new(100),
            b"{\"a\":1}\n\n{\"b\":2}\nnot json\n{\"c\":3}\n",
            &mut values,
        )
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(values, [json!({ "a": 1 }), json!({ "b": 2 })]);
        let mut seen = 0;
        let error = JsonlParser::new(100)
            .push(b"1\n2\n", |_| {
                seen += 1;
                Err("RPC emitted a non-object JSON value".to_owned())
            })
            .unwrap_err();
        assert_eq!(
            (seen, error.as_str()),
            (1, "RPC emitted a non-object JSON value")
        );
    }
}
