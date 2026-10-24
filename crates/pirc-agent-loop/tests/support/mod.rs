#![allow(dead_code)]
use pirc_agent_loop::*;
use pirc_llm_types::*;

pub fn reply(reason: StopReason, ids: &[&str]) -> AssistantMessage {
    AssistantMessage {
        content: ids
            .iter()
            .map(|id| AssistantContent::ToolCall {
                id: (*id).into(),
                name: "fake".into(),
                arguments: Default::default(),
                thought_signature: None,
            })
            .collect(),
        api: "fake".into(),
        provider: "fake".into(),
        model: "fake".into(),
        usage: Usage {
            input: 2,
            output: 3,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 5,
        },
        stop_reason: reason,
        error_message: None,
        timestamp: 1,
        completed_at: Some(2),
        canonical_provider: None,
        response_id: None,
        response_model: None,
    }
}

pub fn text_reply(reason: StopReason, text: &str) -> AssistantMessage {
    let mut reply = reply(reason, &[]);
    reply.content.push(AssistantContent::Text {
        text: text.into(),
        text_signature: None,
    });
    reply
}

pub fn user(text: &str) -> Message {
    Message::User {
        content: UserContent::Text(text.into()),
        timestamp: 0,
    }
}

pub fn model(step: Step) -> ModelRequest {
    let Step::Model(request) = step else {
        panic!("expected model, got {step:?}")
    };
    request
}

pub fn tools(step: Step) -> Vec<ToolCall> {
    let Step::Tools(calls) = step else {
        panic!("expected tools, got {step:?}")
    };
    calls
}

pub fn outcome(status: ToolStatus, text: &str) -> ToolOutcome {
    ToolOutcome {
        status,
        content: vec![UserBlock::Text {
            text: text.into(),
            text_signature: None,
        }],
        details: None,
        timestamp: 3,
    }
}

pub fn failure(kind: FailureKind) -> Failure {
    Failure {
        kind,
        message: "raw adapter error".into(),
        retryable: true,
        retry_after_ms: Some(100),
        outcome_unknown: false,
    }
}
