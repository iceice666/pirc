//! PTC scripts (`agent/ptc/**`, plans/rust-rewrite.md M5): what runs on the
//! script's side of the boundary. The preflight strips TypeScript and
//! derives the capabilities a script may call; the guest (feature `guest`)
//! runs one script in QuickJS inside the killable `ptc-guest` process. The
//! agent's side, which holds every authority and record, is
//! `pirc_agent::ptc::runtime`.

pub mod contracts;
#[cfg(feature = "guest")]
pub mod guest;
pub mod preflight;
pub mod protocol;
