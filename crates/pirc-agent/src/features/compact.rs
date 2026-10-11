//! `compact` (`agent/features/compact.ts`): `/compact [instructions]`
//! summarizes older context now.

use std::rc::Rc;

use serde_json::Value;

use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::feature::{Feature, FeatureCommand};
use crate::ui::NotifyLevel;

/// `compactFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(CompactFeature)
}

struct CompactFeature;

impl Feature for CompactFeature {
    fn name(&self) -> &'static str {
        "compact"
    }

    fn commands(&self) -> Vec<FeatureCommand> {
        vec![FeatureCommand::new(
            "compact",
            "Summarize older context now (/compact [focus instructions])",
        )]
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        _name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            // `args || undefined`.
            let instructions = (!args.is_empty()).then_some(args);
            let result = match agent.compact(instructions).await {
                Ok(result) => result,
                Err(error) => {
                    // The TS error passed through one more `await` than
                    // the command's response did, so it was told second.
                    tokio::task::yield_now().await;
                    return Err(error);
                }
            };
            let tokens = result
                .get("tokensBefore")
                .and_then(Value::as_number)
                .map_or_else(|| "?".to_owned(), locale_number);
            agent.ui().notify(
                &format!("Compacted {tokens} tokens of context."),
                NotifyLevel::Info,
            );
            Ok(())
        })
    }
}

/// `n.toLocaleString()` in the `en-US` locale Bun runs with: digits
/// grouped by threes with commas, at most three fraction digits.
pub fn locale_number(n: &serde_json::Number) -> String {
    let value = n.as_f64().unwrap_or(0.0);
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".to_owned()
        } else if value > 0.0 {
            "∞".to_owned()
        } else {
            "-∞".to_owned()
        };
    }
    let text = match (n.as_u64(), n.as_i64()) {
        (Some(u), _) => u.to_string(),
        (_, Some(i)) => i.to_string(),
        _ => {
            let rounded = format!("{value:.3}");
            let trimmed = rounded.trim_end_matches('0').trim_end_matches('.');
            if trimmed == "-0" {
                "0".to_owned()
            } else {
                trimmed.to_owned()
            }
        }
    };
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text.as_str()),
    };
    let (whole, fraction) = match rest.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (rest, None),
    };
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn format(value: Value) -> String {
        locale_number(value.as_number().unwrap())
    }

    #[test]
    fn formats_numbers_as_to_locale_string() {
        assert_eq!(format(json!(0)), "0");
        assert_eq!(format(json!(150)), "150");
        assert_eq!(format(json!(1234)), "1,234");
        assert_eq!(format(json!(1_234_567)), "1,234,567");
        assert_eq!(format(json!(-1234)), "-1,234");
        assert_eq!(format(json!(1234.5678)), "1,234.568");
        assert_eq!(format(json!(0.5)), "0.5");
        assert_eq!(format(json!(100_000)), "100,000");
    }
}
