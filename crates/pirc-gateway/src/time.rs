//! Time arithmetic shared by the gateway's timed work.
//!
//! [`cron`] was the schedules' fire-time engine. Schedules are gone
//! (plans/rewrite/00-demolition.md); it stays for the open loops' time
//! anchors (plans/rewrite/04-open-loops.md: "every Wednesday at 18:00").

pub mod cron;
