//! A genuinely non-Send async adapter: Rc/RefCell survives across an await.
//! Run: cargo run -p pirc-agent-loop --example local
mod support;

use std::cell::RefCell;
use std::rc::Rc;

use pirc_agent_loop::*;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let local = tokio::task::LocalSet::new();
    let log = Rc::new(RefCell::new(Vec::new()));
    let observed = log.clone();
    local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                let core = Rc::new(RefCell::new(Loop::new(0, vec![])));
                let mut step = core.borrow_mut().advance(vec![]).unwrap();
                loop {
                    step = match step {
                        Step::Model(request) => {
                            // A real remote adapter can use the host's existing local futures.
                            let callback_state = log.clone();
                            tokio::task::yield_now().await;
                            callback_state.borrow_mut().push("model");
                            let reply = support::answer(&request);
                            core.borrow_mut()
                                .finish_model(request.ticket, reply, None)
                                .unwrap()
                        }
                        Step::Tools(calls) => {
                            // Host performs validation/approval before invoking any effect.
                            let mut next = Step::Idle;
                            for call in calls {
                                tokio::task::yield_now().await;
                                log.borrow_mut().push("tool");
                                next = core
                                    .borrow_mut()
                                    .resume_tool(call.key, support::tool_result())
                                    .unwrap();
                            }
                            next
                        }
                        Step::Idle => core.borrow_mut().complete().unwrap(),
                        Step::Done(reason) => {
                            assert_eq!(reason, TerminalReason::Completed);
                            break;
                        }
                        other => panic!("unexpected fake adapter step: {other:?}"),
                    };
                }
            })
            .await
            .unwrap();
        })
        .await;
    assert_eq!(*observed.borrow(), ["model", "tool", "model"]);
}
