//! A repository's identity across clones: its `origin` remote URL,
//! normalized (docs/history/assistant.md). Two clones of one repository,
//! on two nodes or next to each other, share it, so workspace memory found
//! for one is found for the other.
//!
//! The key is `host/path`: scheme, user info, port, query and fragment are
//! dropped, the host is lowercased, and a trailing `.git` and slashes go.
//! `ssh://git@host/a/b`, `git@host:a/b.git` and `https://host/a/b/` are all
//! `host/a/b`. Local paths and `file://` URLs have no key: no path leaves
//! the node. Neither does a credential: anything with `@` left in it after
//! the user info is dropped is refused rather than guessed at.

/// The longest key a gateway accepts.
pub const REPO_MAX_CHARS: usize = 300;

/// Schemes git fetches over a network.
const SCHEMES: [&str; 6] = ["ssh", "git", "http", "https", "git+ssh", "ssh+git"];

fn path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+')
}

fn host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

/// The repository key of an `origin` URL, or `None` when it has none.
pub fn normalize_origin(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            if !SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
                return None;
            }
            let rest = rest.split(['?', '#']).next().unwrap_or_default();
            rest.split_once('/').unwrap_or((rest, ""))
        }
        // scp-like `[user@]host:path`, which git takes it for only when no
        // slash comes before the colon.
        None => {
            let slash = url.find('/').unwrap_or(url.len());
            let host_end = match url[..slash].rfind('@') {
                Some(at) => at + 1 + url[at + 1..slash].find(':')?,
                None => url[..slash].find(':')?,
            };
            // `C:` is a drive, not a host.
            if host_end < 2 {
                return None;
            }
            (&url[..host_end], &url[host_end + 1..])
        }
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    // The port says how, not what.
    let host = host
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.is_empty() || !host.chars().all(host_char) || host.starts_with(['.', '-']) {
        return None;
    }
    let mut segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if let Some(last) = segments.last_mut() {
        *last = last.strip_suffix(".git").unwrap_or(last);
        if last.is_empty() {
            segments.pop();
        }
    }
    if segments.is_empty()
        || segments
            .iter()
            .any(|part| matches!(*part, "." | "..") || !part.chars().all(path_char))
    {
        return None;
    }
    let key = format!("{host}/{}", segments.join("/"));
    (key.chars().count() <= REPO_MAX_CHARS).then_some(key)
}

/// A key a node sent, if it is one this module could have made.
pub fn valid_repo(key: &str) -> bool {
    normalize_origin(&format!("https://{key}")).as_deref() == Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_a_key() {
        for url in [
            "git@github.com:Owner/Repo.git",
            "ssh://git@github.com/Owner/Repo.git",
            "ssh://git@GitHub.com:22/Owner/Repo",
            "https://github.com/Owner/Repo",
            "https://github.com/Owner/Repo.git/",
            "HTTPS://github.com//Owner/Repo/",
            "git://github.com/Owner/Repo.git",
            "git+ssh://git@github.com/Owner/Repo.git",
            "https://github.com/Owner/Repo.git?ref=main#readme",
            "  https://github.com/Owner/Repo\n",
        ] {
            assert_eq!(
                normalize_origin(url).as_deref(),
                Some("github.com/Owner/Repo"),
                "{url}"
            );
        }
        assert_eq!(
            normalize_origin("git.example.org:/srv/git/tools.git").as_deref(),
            Some("git.example.org/srv/git/tools")
        );
        assert_eq!(
            normalize_origin("https://gitlab.com/group/sub/project").as_deref(),
            Some("gitlab.com/group/sub/project")
        );
    }

    #[test]
    fn credentials_never_leave() {
        for url in [
            "https://user:ghp_secret@github.com/o/r.git",
            "https://x-access-token:abc@github.com/o/r",
            "https://ghp_secret@github.com/o/r",
            "ssh://deploy:hunter2@host.example/o/r",
            "user:pass@host.example:o/r",
        ] {
            let key = normalize_origin(url).unwrap_or_default();
            assert!(
                !key.contains("secret")
                    && !key.contains("abc")
                    && !key.contains("hunter2")
                    && !key.contains("pass")
                    && !key.contains('@'),
                "{url} -> {key}"
            );
        }
        // A password holding a slash or a query mark cannot be told apart
        // from the path: refused, not leaked.
        assert_eq!(normalize_origin("https://u:to/ken@github.com/o/r"), None);
        assert_eq!(normalize_origin("https://u:p?x@github.com/o/r"), None);
    }

    #[test]
    fn local_paths_have_none() {
        for url in [
            "",
            "/home/me/repo.git",
            "./repo",
            "../repo.git",
            "~/repo",
            "file:///home/me/repo.git",
            "C:/repo",
            "C:\\repo",
            "https://github.com",
            "https://github.com/",
            "https://github.com/.git",
            "https://github.com/o/../r",
            "ext::sh -c touch% /tmp/x",
            "https://github.com/o/r with space",
            "https://github.com/o/r%20x",
        ] {
            assert_eq!(normalize_origin(url), None, "{url}");
        }
    }

    #[test]
    fn keys_are_bounded_and_checkable() {
        let long = format!("https://h.example/{}", "a".repeat(REPO_MAX_CHARS));
        assert_eq!(normalize_origin(&long), None);
        assert!(valid_repo("github.com/o/r"));
        assert!(!valid_repo("GitHub.com/o/r"));
        assert!(!valid_repo("github.com/o/r.git"));
        assert!(!valid_repo("user@github.com/o/r"));
    }
}
