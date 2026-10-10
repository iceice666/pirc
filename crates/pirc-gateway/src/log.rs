//! One JSON object per line on stderr, like the TS gateway's logger (pino
//! levels: 30 info, 40 warn, 50 error). Messages never carry secrets.

use serde_json::json;

use crate::util::now_ms;

fn write(level: u8, message: &str) {
    eprintln!(
        "{}",
        json!({ "level": level, "time": now_ms(), "msg": message })
    );
}

pub fn info(message: &str) {
    write(30, message);
}

pub fn warn(message: &str) {
    write(40, message);
}

pub fn error(message: &str) {
    write(50, message);
}
