//! Markdown front matter shared by skill, role, and configuration files.
//!
//! The permissive parser follows `parseSkillFile`: YAML is read as Bun reads
//! it, sequence indices become metadata keys, and scalar metadata is ignored.

pub mod js;
pub mod yaml;

use indexmap::IndexMap;

use yaml::Yaml;

/// A Markdown file's front matter and trimmed body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarkdownFile {
    /// The front matter's keys (an array's indices, as `Object.keys` gives
    /// them; nothing for a scalar).
    pub meta: IndexMap<String, Yaml>,
    pub body: String,
}

/// `parseSkillFile(text)`, preserving Bun's permissive YAML semantics.
pub fn parse(text: &str) -> Result<MarkdownFile, String> {
    parse_file(text, false)
}

/// Parse a file with required, single-mapping YAML front matter.
/// Duplicate explicit keys, non-string mapping keys, and unsupported YAML
/// tags are rejected recursively. Unlike [`parse`], scalars, sequences,
/// empty metadata, and absent delimiters are errors.
pub fn parse_strict(text: &str) -> Result<MarkdownFile, String> {
    parse_file(text, true)
}

fn parse_file(text: &str, strict: bool) -> Result<MarkdownFile, String> {
    static FRONT_MATTER: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    let pattern = FRONT_MATTER.get_or_init(|| {
        regex_lite::Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)")
            .expect("front matter pattern")
    });
    let Some(found) = pattern.captures(text) else {
        if strict {
            return Err("YAML front matter is required".to_owned());
        }
        return Ok(MarkdownFile {
            meta: IndexMap::new(),
            body: text.trim_matches(crate::js_space).to_owned(),
        });
    };
    let whole = found.get(0).map_or(0, |m| m.end());
    let yaml = found.get(1).map_or("", |m| m.as_str());
    let meta = if strict {
        yaml::parse_strict_mapping(yaml)?
    } else {
        match yaml::parse(yaml)? {
            Yaml::Map(map) => map,
            Yaml::Seq(items) => items
                .into_iter()
                .enumerate()
                .map(|(index, item)| (index.to_string(), item))
                .collect(),
            _ => IndexMap::new(),
        }
    };
    Ok(MarkdownFile {
        meta,
        body: text[whole..].trim_matches(crate::js_space).to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_front_matter_and_body() {
        let file = parse("---\nname: x\ndescription: y\n---\n\nBody text.\n").unwrap();
        assert_eq!(file.meta.get("name"), Some(&Yaml::String("x".into())));
        assert_eq!(file.body, "Body text.");
        let none = parse("  no front matter \n").unwrap();
        assert!(none.meta.is_empty());
        assert_eq!(none.body, "no front matter");
        let crlf = parse("---\r\na: 1\r\n---  \r\nrest").unwrap();
        assert_eq!(crlf.meta.get("a"), Some(&Yaml::Number(1.0)));
        assert_eq!(crlf.body, "rest");
        assert!(parse("---\n---\nx").unwrap().meta.is_empty());
        let list = parse("---\n- a\n---\n").unwrap();
        assert_eq!(list.meta.keys().collect::<Vec<_>>(), ["0"]);
        assert!(parse("---\na: [\n---\n").is_err());
    }

    #[test]
    fn strict_requires_mapping_front_matter() {
        for text in [
            "body",
            "---\na: 1",
            "---\n\n---\nbody",
            "---\nnull\n---\nbody",
            "---\nscalar\n---\nbody",
            "---\n[]\n---\nbody",
            "---\n- name: x\n---\nbody",
        ] {
            assert!(parse_strict(text).is_err(), "{text:?}");
        }
        let empty = parse_strict("---\n{}\n---\nbody").unwrap();
        assert!(empty.meta.is_empty());
        assert_eq!(empty.body, "body");
        let valid = "---\r\nname: x\r\n--- \r\n\u{feff}body\u{a0}";
        assert_eq!(parse_strict(valid).unwrap(), parse(valid).unwrap());
    }

    #[test]
    fn strict_rejects_recursive_duplicate_explicit_keys() {
        for yaml in [
            "a: 1\na: 2",
            "a: {b: 1, b: 2}",
            "a: [{b: 1, b: 2}]",
            "'1': first\n'1': second",
            "a: &a {b: 1, b: 2}\nc: *a",
            "a: &a {b: 1}\nc: {<<: *a, <<: *a}",
        ] {
            let text = format!("---\n{yaml}\n---\nbody");
            assert!(parse(&text).is_ok(), "{yaml:?}");
            assert!(
                parse_strict(&text).unwrap_err().contains("Duplicate"),
                "{yaml:?}"
            );
        }
        let text = "---\na: &a {b: 1}\nc: {<<: *a, b: 2}\n---\nbody";
        assert_eq!(parse_strict(text).unwrap(), parse(text).unwrap());
    }

    #[test]
    fn preserves_delimiters_and_javascript_trimming() {
        for text in [
            "---\nname: x",
            " ---\nname: x\n---\nbody",
            "---\na: 1\n---x\nbody",
        ] {
            let file = parse(text).unwrap();
            assert!(file.meta.is_empty(), "{text:?}");
            assert_eq!(file.body, text.trim_matches(crate::js_space));
        }
        assert_eq!(parse("\u{feff} body \u{a0}").unwrap().body, "body");
        assert_eq!(parse("\u{85}body\u{85}").unwrap().body, "\u{85}body\u{85}");
        assert_eq!(
            parse("---\na: 1\n---\n\u{feff}body\u{a0}").unwrap().body,
            "body"
        );
        assert!(parse("---\nscalar\n---\nbody").unwrap().meta.is_empty());
        assert_eq!(
            parse("---\na: 1\na: 2\n---").unwrap().meta["a"],
            Yaml::Number(2.0)
        );
    }
}
