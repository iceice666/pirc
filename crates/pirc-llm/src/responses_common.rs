use pirc_llm_types::ToolChoice;
/// How a stream ended other than successfully.
pub(crate) enum Failure {
    Cancelled,
    Upstream(String),
}

impl Failure {
    pub(crate) fn upstream(text: &str) -> Self {
        Self::Upstream(text.to_owned())
    }
}

pub(crate) fn tool_choice_name(choice: ToolChoice) -> &'static str {
    match choice {
        ToolChoice::Auto => "auto",
        ToolChoice::None => "none",
    }
}
