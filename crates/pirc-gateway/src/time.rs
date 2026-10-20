//! Time arithmetic shared by the gateway's timed work.
//!
//! [`cron`] was the schedules' fire-time engine. Schedules are gone
//! (plans/rewrite/00-demolition.md); it stays for the recurring open loops of
//! plans/rewrite/04-open-loops.md ("every Wednesday at 18:00"), which have no
//! caller yet.

#![allow(dead_code)]

pub mod cron;
