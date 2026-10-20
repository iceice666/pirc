//! The brain's tools: gateway-side only (plans/rewrite/02-brain-host.md),
//! each a direct tool. This plan has `web_search`, the node agents' tool
//! with the gateway's own search behind it instead of a node channel.

use std::rc::Rc;

use pirc_agent::LocalBoxFuture;
use pirc_agent::channels::ChannelError;
use pirc_agent::features::web_search::{self, SearchBackend};
use pirc_agent::signal::AbortSignal;
use pirc_agent::tools::Tool;
use serde_json::{Map, Value, json};
use tokio::runtime::Handle;

use super::stream::AbortOnDrop;
use crate::app::AppState;

/// The tools the brain has with this gateway's configuration.
pub fn brain_tools(app: &AppState, runtime: &Handle) -> Vec<Rc<dyn Tool>> {
    let mut tools = Vec::new();
    if app.config.exa_api_key.is_some() {
        tools.push(web_search::tool(Rc::new(GatewaySearch {
            app: app.clone(),
            runtime: runtime.clone(),
        })));
    }
    tools
}

/// `web.search` as a node agent's request would run it, on the gateway's
/// main runtime (where its HTTP client lives).
struct GatewaySearch {
    app: AppState,
    runtime: Handle,
}

impl SearchBackend for GatewaySearch {
    fn search<'a>(
        &'a self,
        request: Map<String, Value>,
        signal: &'a AbortSignal,
    ) -> LocalBoxFuture<'a, Result<Value, ChannelError>> {
        Box::pin(async move {
            let args = crate::web_search::parse_args(&Value::Object(request))
                .map_err(|()| ChannelError::coded("invalid_input", "Invalid request"))?;
            let app = self.app.clone();
            let task = self
                .runtime
                .spawn(async move { crate::web_search::searcher(&app).search(&args).await });
            let _abort = AbortOnDrop(task.abort_handle());
            tokio::select! {
                () = signal.cancelled() => Err(ChannelError::Plain("This operation was aborted".to_owned())),
                joined = task => match joined {
                    Ok(Ok((results, cached))) => Ok(json!({ "results": results, "cached": cached })),
                    Ok(Err(error)) => Err(ChannelError::Coded {
                        code: error.code.to_owned(),
                        message: error.message,
                        status: Some(f64::from(error.status)),
                        details: error.details.map(Box::new),
                    }),
                    Err(_) => Err(ChannelError::coded("internal_error", "Internal server error")),
                },
            }
        })
    }
}
