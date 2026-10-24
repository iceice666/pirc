//! A separate Send consumer, with no change to the local host's scheduling.
//! Run: cargo run -p pirc-agent-loop --example send
mod support;

use pirc_agent_loop::*;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let history = tokio::spawn(async move {
        let mut core = Loop::new(0, vec![]);
        let mut step = core.advance(vec![]).unwrap();
        loop {
            step = match step {
                Step::Model(request) => {
                    // This future and its owned state must be Send for tokio::spawn.
                    tokio::task::yield_now().await;
                    core.finish_model(request.ticket, support::answer(&request), None)
                        .unwrap()
                }
                Step::Tools(calls) => {
                    let mut next = Step::Idle;
                    for call in calls {
                        tokio::task::yield_now().await;
                        next = core.resume_tool(call.key, support::tool_result()).unwrap();
                    }
                    next
                }
                Step::Idle => core.complete().unwrap(),
                Step::Done(reason) => {
                    assert_eq!(reason, TerminalReason::Completed);
                    break;
                }
                other => panic!("unexpected fake adapter step: {other:?}"),
            };
        }
        core.history().to_vec()
    })
    .await
    .unwrap();
    assert_eq!(history.len(), 3); // assistant/tool result/assistant
}
