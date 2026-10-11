//! The memory agents' system prompts (`features/memory/prompts.ts`, copied
//! verbatim from the Pi observational-memory extension, and the workspace
//! promoter's in `workspace.ts`). The TS files are embedded as they are and
//! their template literals are read once, so the model-visible text cannot
//! drift from TS.

use std::sync::LazyLock;

const PROMPTS: &str =
    include_str!("../../../../../apps/gateway/src/agent/features/memory/prompts.ts");
const WORKSPACE: &str =
    include_str!("../../../../../apps/gateway/src/agent/features/memory/workspace.ts");

/// The value of `export const <name> = \`…\`;` in `source`: a template
/// literal without substitutions, its escapes undone.
fn template(source: &str, name: &str) -> String {
    let start = format!("export const {name} = `");
    let at = source
        .find(&start)
        .unwrap_or_else(|| panic!("{name} in the memory sources"))
        + start.len();
    let mut out = String::new();
    let mut chars = source[at..].chars();
    while let Some(c) = chars.next() {
        match c {
            '`' => return out,
            '\\' => match chars.next() {
                Some(escaped @ ('\\' | '`' | '$')) => out.push(escaped),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                other => panic!("{name}: unsupported escape \\{other:?}"),
            },
            '$' if chars.as_str().starts_with('{') => panic!("{name}: a substitution"),
            c => out.push(c),
        }
    }
    panic!("{name}: unterminated template")
}

/// `OBSERVER_SYSTEM`.
pub static OBSERVER_SYSTEM: LazyLock<String> =
    LazyLock::new(|| template(PROMPTS, "OBSERVER_SYSTEM"));
/// `REFLECTOR_SYSTEM`.
pub static REFLECTOR_SYSTEM: LazyLock<String> =
    LazyLock::new(|| template(PROMPTS, "REFLECTOR_SYSTEM"));
/// `DROPPER_SYSTEM`.
pub static DROPPER_SYSTEM: LazyLock<String> = LazyLock::new(|| template(PROMPTS, "DROPPER_SYSTEM"));
/// `WORKSPACE_PROMOTER_SYSTEM`.
pub static WORKSPACE_PROMOTER_SYSTEM: LazyLock<String> =
    LazyLock::new(|| template(WORKSPACE, "WORKSPACE_PROMOTER_SYSTEM"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ts_prompts_verbatim() {
        assert!(
            OBSERVER_SYSTEM.starts_with(
                "You are the observation agent for a coding assistant.\n\nThese records"
            )
        );
        assert!(OBSERVER_SYSTEM.contains(
            "(such copies are escaped as \"\\[User @ ...\", \"\\[Source entry id: ...\")"
        ));
        assert!(OBSERVER_SYSTEM.ends_with("Make them count."));
        assert!(REFLECTOR_SYSTEM.starts_with("You are the reflection agent"));
        assert!(REFLECTOR_SYSTEM.ends_with("partial work with no durable conclusion yet."));
        assert!(DROPPER_SYSTEM.starts_with("You are the dropper agent"));
        assert!(DROPPER_SYSTEM.ends_with("less important than preserving load-bearing memory."));
        assert!(WORKSPACE_PROMOTER_SYSTEM.starts_with("You maintain the workspace memory"));
        assert!(WORKSPACE_PROMOTER_SYSTEM.ends_with("then do not call the tool."));
    }
}
