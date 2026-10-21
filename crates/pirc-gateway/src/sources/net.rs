//! HTTP for sources: https only (plain http to this machine, for tests),
//! redirects followed only to https and at most 5, answers capped in size.

use std::time::Duration;

use url::Url;

use super::SourceError;

const TIMEOUT: Duration = Duration::from_secs(30);

pub fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// A source's URL: absolute, https (http only to loopback), no user info.
pub fn check_url(text: &str) -> Result<Url, String> {
    let url = Url::parse(text.trim()).map_err(|_| format!("{} is not a URL", text.trim()))?;
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "https" => {}
        "http" if loopback(host) => {}
        _ => return Err("The address must start with https://".to_owned()),
    }
    if host.is_empty() || !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not hold a user name or password".to_owned());
    }
    Ok(url)
}

/// The client every source request goes through.
pub fn client() -> reqwest::Client {
    // ring, not aws-lc (as pirc-providers).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .timeout(TIMEOUT)
        .user_agent("pirc-gateway")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let safe = url.scheme() == "https"
                || (url.scheme() == "http" && loopback(url.host_str().unwrap_or_default()));
            if attempt.previous().len() >= 5 || !safe {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .expect("the HTTP client builds with the ring provider installed")
}

/// A request's error, as a source's.
pub fn failed(error: &reqwest::Error) -> SourceError {
    let message = if error.is_timeout() {
        "the server did not answer in time".to_owned()
    } else if error.is_connect() {
        "the server cannot be reached".to_owned()
    } else {
        // Without the URL: it may be a secret (an ICS address).
        error.without_url_ref().to_string()
    };
    SourceError::new(message)
}

trait WithoutUrl {
    fn without_url_ref(&self) -> String;
}

impl WithoutUrl for reqwest::Error {
    fn without_url_ref(&self) -> String {
        let mut text = self.to_string();
        if let Some(url) = self.url() {
            text = text.replace(url.as_str(), "(the address)");
        }
        text
    }
}

/// The body of an answer, at most `max` bytes.
pub async fn body(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, SourceError> {
    if response
        .content_length()
        .is_some_and(|length| length as usize > max)
    {
        return Err(SourceError::new("the server's answer is too large"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| failed(&error))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > max {
            return Err(SourceError::new("the server's answer is too large"));
        }
    }
    Ok(bytes)
}

/// An HTTP status that is not success, as a source's error (401 and 403:
/// the credentials).
pub fn status_error(status: reqwest::StatusCode) -> SourceError {
    let mut error = SourceError::new(format!("the server answered {status}"));
    if matches!(status.as_u16(), 401 | 403) {
        error.auth = true;
    }
    error
}

/// HTML as plain text: tags out, block ends as line breaks, entities
/// decoded, blank runs squeezed.
pub fn html_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            rest = "";
            break;
        };
        let tag = rest[open + 1..open + close].trim().to_ascii_lowercase();
        let name = tag
            .trim_start_matches('/')
            .split([' ', '/', '\t', '\n'])
            .next()
            .unwrap_or_default();
        if matches!(name, "script" | "style") && !tag.starts_with('/') {
            let end = format!("</{name}");
            match rest[open..].to_ascii_lowercase().find(&end) {
                Some(at) => {
                    rest = &rest[open + at..];
                    continue;
                }
                None => {
                    rest = "";
                    break;
                }
            }
        }
        if matches!(
            name,
            "br" | "p"
                | "div"
                | "li"
                | "tr"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "table"
                | "ul"
                | "ol"
        ) {
            out.push('\n');
            if name == "li" && !tag.starts_with('/') {
                out.push_str("- ");
            }
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    let decoded = entities(&out);
    let mut squeezed = String::with_capacity(decoded.len());
    let mut blank = 0;
    for line in decoded.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        squeezed.push_str(&line);
        squeezed.push('\n');
    }
    squeezed.trim().to_owned()
}

/// `&amp;`, `&lt;`, `&#39;`, `&#x4e2d;` and the like.
pub fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail[..tail.len().min(12)].find(';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|n| n.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(check_url("https://moodle.school.edu").is_ok());
        assert!(check_url("http://127.0.0.1:8080/x").is_ok());
        assert!(check_url("http://moodle.school.edu").is_err());
        assert!(check_url("https://me:pw@moodle.school.edu").is_err());
        assert!(check_url("ftp://x").is_err());
        assert!(check_url("nope").is_err());
    }

    #[test]
    fn html_as_text() {
        assert_eq!(
            html_text(
                "<p>Hello&nbsp;<b>world</b></p><ul><li>one</li><li>two &amp; 三</li></ul><script>x()</script><p>&#x4e2d;&#25991;</p>"
            ),
            "Hello world\n\n- one\n\n- two & 三\n\n中文"
        );
        assert_eq!(entities("a &unknown; b & c"), "a &unknown; b & c");
    }
}
