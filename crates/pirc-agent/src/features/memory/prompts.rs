//! Memory prompts extracted verbatim from the TS 0.3.0 template values.
//! No legacy server source is needed to build the agent.

use std::sync::LazyLock;

pub static OBSERVER_SYSTEM: LazyLock<String> =
    LazyLock::new(|| include_str!("../../../prompts/memory/observer_system.txt").to_owned());
pub static REFLECTOR_SYSTEM: LazyLock<String> =
    LazyLock::new(|| include_str!("../../../prompts/memory/reflector_system.txt").to_owned());
pub static DROPPER_SYSTEM: LazyLock<String> =
    LazyLock::new(|| include_str!("../../../prompts/memory/dropper_system.txt").to_owned());
pub static WORKSPACE_PROMOTER_SYSTEM: LazyLock<String> = LazyLock::new(|| {
    include_str!("../../../prompts/memory/workspace_promoter_system.txt").to_owned()
});

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
