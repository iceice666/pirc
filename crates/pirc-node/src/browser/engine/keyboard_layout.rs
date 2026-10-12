//! Playwright's US keyboard layout (`usKeyboardLayout.ts`) and the key
//! descriptions `input.ts` builds from it (`buildLayoutClosure` with its
//! aliases), plus the macOS editing commands Chromium gets with key events
//! (`macEditingCommands.ts`), copied verbatim from playwright-core 1.63.0.
//!
//! Ported from playwright-core 1.63.0 `src/server/usKeyboardLayout.ts`,
//! `src/server/macEditingCommands.ts`, `src/server/input.ts` (Apache-2.0,
//! Copyright (c) Microsoft Corporation, see `crates/pirc-node/NOTICE`).

use std::collections::HashMap;
use std::sync::OnceLock;

/// `keypadLocation`.
pub const KEYPAD_LOCATION: u32 = 3;

/// One entry of `USKeyboardLayout` (`KeyDefinition`); zero and `None` stand
/// for absent properties.
#[derive(Clone, Copy, Debug)]
pub struct Def {
    pub code: &'static str,
    pub key_code: u32,
    pub key_code_without_location: u32,
    pub shift_key_code: u32,
    pub key: &'static str,
    pub shift_key: Option<&'static str>,
    pub text: Option<&'static str>,
    pub location: u32,
}

impl Def {
    const NONE: Self = Self {
        code: "",
        key_code: 0,
        key_code_without_location: 0,
        shift_key_code: 0,
        key: "",
        shift_key: None,
        text: None,
        location: 0,
    };
}

/// `USKeyboardLayout`, in its order (later entries win in the closure).
#[rustfmt::skip]
pub const US_KEYBOARD_LAYOUT: &[Def] = &[
    Def { code: "Escape", key_code: 27, key: "Escape", ..Def::NONE },
    Def { code: "F1", key_code: 112, key: "F1", ..Def::NONE },
    Def { code: "F2", key_code: 113, key: "F2", ..Def::NONE },
    Def { code: "F3", key_code: 114, key: "F3", ..Def::NONE },
    Def { code: "F4", key_code: 115, key: "F4", ..Def::NONE },
    Def { code: "F5", key_code: 116, key: "F5", ..Def::NONE },
    Def { code: "F6", key_code: 117, key: "F6", ..Def::NONE },
    Def { code: "F7", key_code: 118, key: "F7", ..Def::NONE },
    Def { code: "F8", key_code: 119, key: "F8", ..Def::NONE },
    Def { code: "F9", key_code: 120, key: "F9", ..Def::NONE },
    Def { code: "F10", key_code: 121, key: "F10", ..Def::NONE },
    Def { code: "F11", key_code: 122, key: "F11", ..Def::NONE },
    Def { code: "F12", key_code: 123, key: "F12", ..Def::NONE },
    // Numbers row
    Def { code: "Backquote", key_code: 192, key: "`", shift_key: Some("~"), ..Def::NONE },
    Def { code: "Digit1", key_code: 49, key: "1", shift_key: Some("!"), ..Def::NONE },
    Def { code: "Digit2", key_code: 50, key: "2", shift_key: Some("@"), ..Def::NONE },
    Def { code: "Digit3", key_code: 51, key: "3", shift_key: Some("#"), ..Def::NONE },
    Def { code: "Digit4", key_code: 52, key: "4", shift_key: Some("$"), ..Def::NONE },
    Def { code: "Digit5", key_code: 53, key: "5", shift_key: Some("%"), ..Def::NONE },
    Def { code: "Digit6", key_code: 54, key: "6", shift_key: Some("^"), ..Def::NONE },
    Def { code: "Digit7", key_code: 55, key: "7", shift_key: Some("&"), ..Def::NONE },
    Def { code: "Digit8", key_code: 56, key: "8", shift_key: Some("*"), ..Def::NONE },
    Def { code: "Digit9", key_code: 57, key: "9", shift_key: Some("("), ..Def::NONE },
    Def { code: "Digit0", key_code: 48, key: "0", shift_key: Some(")"), ..Def::NONE },
    Def { code: "Minus", key_code: 189, key: "-", shift_key: Some("_"), ..Def::NONE },
    Def { code: "Equal", key_code: 187, key: "=", shift_key: Some("+"), ..Def::NONE },
    Def { code: "Backslash", key_code: 220, key: "\\", shift_key: Some("|"), ..Def::NONE },
    Def { code: "Backspace", key_code: 8, key: "Backspace", ..Def::NONE },
    // First row
    Def { code: "Tab", key_code: 9, key: "Tab", ..Def::NONE },
    Def { code: "KeyQ", key_code: 81, key: "q", shift_key: Some("Q"), ..Def::NONE },
    Def { code: "KeyW", key_code: 87, key: "w", shift_key: Some("W"), ..Def::NONE },
    Def { code: "KeyE", key_code: 69, key: "e", shift_key: Some("E"), ..Def::NONE },
    Def { code: "KeyR", key_code: 82, key: "r", shift_key: Some("R"), ..Def::NONE },
    Def { code: "KeyT", key_code: 84, key: "t", shift_key: Some("T"), ..Def::NONE },
    Def { code: "KeyY", key_code: 89, key: "y", shift_key: Some("Y"), ..Def::NONE },
    Def { code: "KeyU", key_code: 85, key: "u", shift_key: Some("U"), ..Def::NONE },
    Def { code: "KeyI", key_code: 73, key: "i", shift_key: Some("I"), ..Def::NONE },
    Def { code: "KeyO", key_code: 79, key: "o", shift_key: Some("O"), ..Def::NONE },
    Def { code: "KeyP", key_code: 80, key: "p", shift_key: Some("P"), ..Def::NONE },
    Def { code: "BracketLeft", key_code: 219, key: "[", shift_key: Some("{"), ..Def::NONE },
    Def { code: "BracketRight", key_code: 221, key: "]", shift_key: Some("}"), ..Def::NONE },
    // Second row
    Def { code: "CapsLock", key_code: 20, key: "CapsLock", ..Def::NONE },
    Def { code: "KeyA", key_code: 65, key: "a", shift_key: Some("A"), ..Def::NONE },
    Def { code: "KeyS", key_code: 83, key: "s", shift_key: Some("S"), ..Def::NONE },
    Def { code: "KeyD", key_code: 68, key: "d", shift_key: Some("D"), ..Def::NONE },
    Def { code: "KeyF", key_code: 70, key: "f", shift_key: Some("F"), ..Def::NONE },
    Def { code: "KeyG", key_code: 71, key: "g", shift_key: Some("G"), ..Def::NONE },
    Def { code: "KeyH", key_code: 72, key: "h", shift_key: Some("H"), ..Def::NONE },
    Def { code: "KeyJ", key_code: 74, key: "j", shift_key: Some("J"), ..Def::NONE },
    Def { code: "KeyK", key_code: 75, key: "k", shift_key: Some("K"), ..Def::NONE },
    Def { code: "KeyL", key_code: 76, key: "l", shift_key: Some("L"), ..Def::NONE },
    Def { code: "Semicolon", key_code: 186, key: ";", shift_key: Some(":"), ..Def::NONE },
    Def { code: "Quote", key_code: 222, key: "'", shift_key: Some("\""), ..Def::NONE },
    Def { code: "Enter", key_code: 13, key: "Enter", text: Some("\r"), ..Def::NONE },
    // Third row
    Def { code: "ShiftLeft", key_code: 160, key: "Shift", key_code_without_location: 16, location: 1, ..Def::NONE },
    Def { code: "KeyZ", key_code: 90, key: "z", shift_key: Some("Z"), ..Def::NONE },
    Def { code: "KeyX", key_code: 88, key: "x", shift_key: Some("X"), ..Def::NONE },
    Def { code: "KeyC", key_code: 67, key: "c", shift_key: Some("C"), ..Def::NONE },
    Def { code: "KeyV", key_code: 86, key: "v", shift_key: Some("V"), ..Def::NONE },
    Def { code: "KeyB", key_code: 66, key: "b", shift_key: Some("B"), ..Def::NONE },
    Def { code: "KeyN", key_code: 78, key: "n", shift_key: Some("N"), ..Def::NONE },
    Def { code: "KeyM", key_code: 77, key: "m", shift_key: Some("M"), ..Def::NONE },
    Def { code: "Comma", key_code: 188, key: ",", shift_key: Some("<"), ..Def::NONE },
    Def { code: "Period", key_code: 190, key: ".", shift_key: Some(">"), ..Def::NONE },
    Def { code: "Slash", key_code: 191, key: "/", shift_key: Some("?"), ..Def::NONE },
    Def { code: "ShiftRight", key_code: 161, key: "Shift", key_code_without_location: 16, location: 2, ..Def::NONE },
    // Last row
    Def { code: "ControlLeft", key_code: 162, key: "Control", key_code_without_location: 17, location: 1, ..Def::NONE },
    Def { code: "MetaLeft", key_code: 91, key: "Meta", location: 1, ..Def::NONE },
    Def { code: "AltLeft", key_code: 164, key: "Alt", key_code_without_location: 18, location: 1, ..Def::NONE },
    Def { code: "Space", key_code: 32, key: " ", ..Def::NONE },
    Def { code: "AltRight", key_code: 165, key: "Alt", key_code_without_location: 18, location: 2, ..Def::NONE },
    Def { code: "AltGraph", key_code: 225, key: "AltGraph", ..Def::NONE },
    Def { code: "MetaRight", key_code: 92, key: "Meta", location: 2, ..Def::NONE },
    Def { code: "ContextMenu", key_code: 93, key: "ContextMenu", ..Def::NONE },
    Def { code: "ControlRight", key_code: 163, key: "Control", key_code_without_location: 17, location: 2, ..Def::NONE },
    // Center block
    Def { code: "PrintScreen", key_code: 44, key: "PrintScreen", ..Def::NONE },
    Def { code: "ScrollLock", key_code: 145, key: "ScrollLock", ..Def::NONE },
    Def { code: "Pause", key_code: 19, key: "Pause", ..Def::NONE },
    Def { code: "PageUp", key_code: 33, key: "PageUp", ..Def::NONE },
    Def { code: "PageDown", key_code: 34, key: "PageDown", ..Def::NONE },
    Def { code: "Insert", key_code: 45, key: "Insert", ..Def::NONE },
    Def { code: "Delete", key_code: 46, key: "Delete", ..Def::NONE },
    Def { code: "Home", key_code: 36, key: "Home", ..Def::NONE },
    Def { code: "End", key_code: 35, key: "End", ..Def::NONE },
    Def { code: "ArrowLeft", key_code: 37, key: "ArrowLeft", ..Def::NONE },
    Def { code: "ArrowUp", key_code: 38, key: "ArrowUp", ..Def::NONE },
    Def { code: "ArrowRight", key_code: 39, key: "ArrowRight", ..Def::NONE },
    Def { code: "ArrowDown", key_code: 40, key: "ArrowDown", ..Def::NONE },
    // Media keys
    Def { code: "AudioVolumeMute", key_code: 173, key: "AudioVolumeMute", ..Def::NONE },
    Def { code: "AudioVolumeDown", key_code: 174, key: "AudioVolumeDown", ..Def::NONE },
    Def { code: "AudioVolumeUp", key_code: 175, key: "AudioVolumeUp", ..Def::NONE },
    Def { code: "MediaTrackNext", key_code: 176, key: "MediaTrackNext", ..Def::NONE },
    Def { code: "MediaTrackPrevious", key_code: 177, key: "MediaTrackPrevious", ..Def::NONE },
    Def { code: "MediaPlayPause", key_code: 179, key: "MediaPlayPause", ..Def::NONE },
    // Numpad
    Def { code: "NumLock", key_code: 144, key: "NumLock", ..Def::NONE },
    Def { code: "NumpadDivide", key_code: 111, key: "/", location: 3, ..Def::NONE },
    Def { code: "NumpadMultiply", key_code: 106, key: "*", location: 3, ..Def::NONE },
    Def { code: "NumpadSubtract", key_code: 109, key: "-", location: 3, ..Def::NONE },
    Def { code: "Numpad7", key_code: 36, key: "Home", shift_key_code: 103, shift_key: Some("7"), location: 3, ..Def::NONE },
    Def { code: "Numpad8", key_code: 38, key: "ArrowUp", shift_key_code: 104, shift_key: Some("8"), location: 3, ..Def::NONE },
    Def { code: "Numpad9", key_code: 33, key: "PageUp", shift_key_code: 105, shift_key: Some("9"), location: 3, ..Def::NONE },
    Def { code: "Numpad4", key_code: 37, key: "ArrowLeft", shift_key_code: 100, shift_key: Some("4"), location: 3, ..Def::NONE },
    Def { code: "Numpad5", key_code: 12, key: "Clear", shift_key_code: 101, shift_key: Some("5"), location: 3, ..Def::NONE },
    Def { code: "Numpad6", key_code: 39, key: "ArrowRight", shift_key_code: 102, shift_key: Some("6"), location: 3, ..Def::NONE },
    Def { code: "NumpadAdd", key_code: 107, key: "+", location: 3, ..Def::NONE },
    Def { code: "Numpad1", key_code: 35, key: "End", shift_key_code: 97, shift_key: Some("1"), location: 3, ..Def::NONE },
    Def { code: "Numpad2", key_code: 40, key: "ArrowDown", shift_key_code: 98, shift_key: Some("2"), location: 3, ..Def::NONE },
    Def { code: "Numpad3", key_code: 34, key: "PageDown", shift_key_code: 99, shift_key: Some("3"), location: 3, ..Def::NONE },
    Def { code: "Numpad0", key_code: 45, key: "Insert", shift_key_code: 96, shift_key: Some("0"), location: 3, ..Def::NONE },
    Def { code: "NumpadDecimal", key_code: 46, key: "\0", shift_key_code: 110, shift_key: Some("."), location: 3, ..Def::NONE },
    Def { code: "NumpadEnter", key_code: 13, key: "Enter", text: Some("\r"), location: 3, ..Def::NONE },
];

/// A key as `Keyboard` sends it (`KeyDescription`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyDescription {
    pub key: &'static str,
    pub key_code: u32,
    pub key_code_without_location: u32,
    pub code: &'static str,
    pub text: &'static str,
    pub location: u32,
    /// The description with Shift held, for keys that have one.
    pub shifted: Option<Box<KeyDescription>>,
}

/// `aliases` of `input.ts`.
const ALIASES: &[(&str, &[&str])] = &[
    ("ShiftLeft", &["Shift"]),
    ("ControlLeft", &["Control"]),
    ("AltLeft", &["Alt"]),
    ("MetaLeft", &["Meta"]),
    ("Enter", &["\n", "\r"]),
];

/// JavaScript's `string.length` (UTF-16 code units).
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `buildLayoutClosure(USKeyboardLayout)`: every name a key may be given by
/// (codes, aliases, unlocated keys' characters, their shifted characters).
pub fn us_keyboard_layout() -> &'static HashMap<&'static str, KeyDescription> {
    static LAYOUT: OnceLock<HashMap<&'static str, KeyDescription>> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        let mut result = HashMap::new();
        for definition in US_KEYBOARD_LAYOUT {
            let mut description = KeyDescription {
                key: definition.key,
                key_code: definition.key_code,
                key_code_without_location: if definition.key_code_without_location != 0 {
                    definition.key_code_without_location
                } else {
                    definition.key_code
                },
                code: definition.code,
                text: definition.text.unwrap_or(""),
                location: definition.location,
                shifted: None,
            };
            if js_length(definition.key) == 1 {
                description.text = description.key;
            }
            let shifted = definition.shift_key.map(|shift_key| {
                let mut shifted = description.clone();
                shifted.key = shift_key;
                shifted.text = shift_key;
                if definition.shift_key_code != 0 {
                    shifted.key_code = definition.shift_key_code;
                }
                shifted
            });
            result.insert(
                definition.code,
                KeyDescription {
                    shifted: shifted.clone().map(Box::new),
                    ..description.clone()
                },
            );
            if let Some((_, aliases)) = ALIASES.iter().find(|(code, _)| *code == definition.code) {
                for alias in *aliases {
                    result.insert(alias, description.clone());
                }
            }
            if definition.location != 0 {
                continue;
            }
            if js_length(description.key) == 1 {
                result.insert(description.key, description.clone());
            }
            if let Some(shifted) = shifted {
                result.insert(shifted.key, shifted);
            }
        }
        result
    })
}

/// `macEditingCommands`: shortcut (`Shift+Control+Alt+Meta+<code>`) to the
/// Cocoa selectors Chromium runs.
#[rustfmt::skip]
pub const MAC_EDITING_COMMANDS: &[(&str, &[&str])] = &[
    ("Backspace", &["deleteBackward:"]),
    ("Enter", &["insertNewline:"]),
    ("NumpadEnter", &["insertNewline:"]),
    ("Escape", &["cancelOperation:"]),
    ("ArrowUp", &["moveUp:"]),
    ("ArrowDown", &["moveDown:"]),
    ("ArrowLeft", &["moveLeft:"]),
    ("ArrowRight", &["moveRight:"]),
    ("F5", &["complete:"]),
    ("Delete", &["deleteForward:"]),
    ("Home", &["scrollToBeginningOfDocument:"]),
    ("End", &["scrollToEndOfDocument:"]),
    ("PageUp", &["scrollPageUp:"]),
    ("PageDown", &["scrollPageDown:"]),
    ("Shift+Backspace", &["deleteBackward:"]),
    ("Shift+Enter", &["insertNewline:"]),
    ("Shift+NumpadEnter", &["insertNewline:"]),
    ("Shift+Escape", &["cancelOperation:"]),
    ("Shift+ArrowUp", &["moveUpAndModifySelection:"]),
    ("Shift+ArrowDown", &["moveDownAndModifySelection:"]),
    ("Shift+ArrowLeft", &["moveLeftAndModifySelection:"]),
    ("Shift+ArrowRight", &["moveRightAndModifySelection:"]),
    ("Shift+F5", &["complete:"]),
    ("Shift+Delete", &["deleteForward:"]),
    ("Shift+Home", &["moveToBeginningOfDocumentAndModifySelection:"]),
    ("Shift+End", &["moveToEndOfDocumentAndModifySelection:"]),
    ("Shift+PageUp", &["pageUpAndModifySelection:"]),
    ("Shift+PageDown", &["pageDownAndModifySelection:"]),
    ("Shift+Numpad5", &["delete:"]),
    ("Control+Tab", &["selectNextKeyView:"]),
    ("Control+Enter", &["insertLineBreak:"]),
    ("Control+NumpadEnter", &["insertLineBreak:"]),
    ("Control+Quote", &["insertSingleQuoteIgnoringSubstitution:"]),
    ("Control+KeyA", &["moveToBeginningOfParagraph:"]),
    ("Control+KeyB", &["moveBackward:"]),
    ("Control+KeyD", &["deleteForward:"]),
    ("Control+KeyE", &["moveToEndOfParagraph:"]),
    ("Control+KeyF", &["moveForward:"]),
    ("Control+KeyH", &["deleteBackward:"]),
    ("Control+KeyK", &["deleteToEndOfParagraph:"]),
    ("Control+KeyL", &["centerSelectionInVisibleArea:"]),
    ("Control+KeyN", &["moveDown:"]),
    ("Control+KeyO", &["insertNewlineIgnoringFieldEditor:", "moveBackward:"]),
    ("Control+KeyP", &["moveUp:"]),
    ("Control+KeyT", &["transpose:"]),
    ("Control+KeyV", &["pageDown:"]),
    ("Control+KeyY", &["yank:"]),
    ("Control+Backspace", &["deleteBackwardByDecomposingPreviousCharacter:"]),
    ("Control+ArrowUp", &["scrollPageUp:"]),
    ("Control+ArrowDown", &["scrollPageDown:"]),
    ("Control+ArrowLeft", &["moveToLeftEndOfLine:"]),
    ("Control+ArrowRight", &["moveToRightEndOfLine:"]),
    ("Shift+Control+Enter", &["insertLineBreak:"]),
    ("Shift+Control+NumpadEnter", &["insertLineBreak:"]),
    ("Shift+Control+Tab", &["selectPreviousKeyView:"]),
    ("Shift+Control+Quote", &["insertDoubleQuoteIgnoringSubstitution:"]),
    ("Shift+Control+KeyA", &["moveToBeginningOfParagraphAndModifySelection:"]),
    ("Shift+Control+KeyB", &["moveBackwardAndModifySelection:"]),
    ("Shift+Control+KeyE", &["moveToEndOfParagraphAndModifySelection:"]),
    ("Shift+Control+KeyF", &["moveForwardAndModifySelection:"]),
    ("Shift+Control+KeyN", &["moveDownAndModifySelection:"]),
    ("Shift+Control+KeyP", &["moveUpAndModifySelection:"]),
    ("Shift+Control+KeyV", &["pageDownAndModifySelection:"]),
    ("Shift+Control+Backspace", &["deleteBackwardByDecomposingPreviousCharacter:"]),
    ("Shift+Control+ArrowUp", &["scrollPageUp:"]),
    ("Shift+Control+ArrowDown", &["scrollPageDown:"]),
    ("Shift+Control+ArrowLeft", &["moveToLeftEndOfLineAndModifySelection:"]),
    ("Shift+Control+ArrowRight", &["moveToRightEndOfLineAndModifySelection:"]),
    ("Alt+Backspace", &["deleteWordBackward:"]),
    ("Alt+Enter", &["insertNewlineIgnoringFieldEditor:"]),
    ("Alt+NumpadEnter", &["insertNewlineIgnoringFieldEditor:"]),
    ("Alt+Escape", &["complete:"]),
    ("Alt+ArrowUp", &["moveBackward:", "moveToBeginningOfParagraph:"]),
    ("Alt+ArrowDown", &["moveForward:", "moveToEndOfParagraph:"]),
    ("Alt+ArrowLeft", &["moveWordLeft:"]),
    ("Alt+ArrowRight", &["moveWordRight:"]),
    ("Alt+Delete", &["deleteWordForward:"]),
    ("Alt+PageUp", &["pageUp:"]),
    ("Alt+PageDown", &["pageDown:"]),
    ("Shift+Alt+Backspace", &["deleteWordBackward:"]),
    ("Shift+Alt+Enter", &["insertNewlineIgnoringFieldEditor:"]),
    ("Shift+Alt+NumpadEnter", &["insertNewlineIgnoringFieldEditor:"]),
    ("Shift+Alt+Escape", &["complete:"]),
    ("Shift+Alt+ArrowUp", &["moveParagraphBackwardAndModifySelection:"]),
    ("Shift+Alt+ArrowDown", &["moveParagraphForwardAndModifySelection:"]),
    ("Shift+Alt+ArrowLeft", &["moveWordLeftAndModifySelection:"]),
    ("Shift+Alt+ArrowRight", &["moveWordRightAndModifySelection:"]),
    ("Shift+Alt+Delete", &["deleteWordForward:"]),
    ("Shift+Alt+PageUp", &["pageUp:"]),
    ("Shift+Alt+PageDown", &["pageDown:"]),
    ("Control+Alt+KeyB", &["moveWordBackward:"]),
    ("Control+Alt+KeyF", &["moveWordForward:"]),
    ("Control+Alt+Backspace", &["deleteWordBackward:"]),
    ("Shift+Control+Alt+KeyB", &["moveWordBackwardAndModifySelection:"]),
    ("Shift+Control+Alt+KeyF", &["moveWordForwardAndModifySelection:"]),
    ("Shift+Control+Alt+Backspace", &["deleteWordBackward:"]),
    ("Meta+NumpadSubtract", &["cancel:"]),
    ("Meta+Backspace", &["deleteToBeginningOfLine:"]),
    ("Meta+ArrowUp", &["moveToBeginningOfDocument:"]),
    ("Meta+ArrowDown", &["moveToEndOfDocument:"]),
    ("Meta+ArrowLeft", &["moveToLeftEndOfLine:"]),
    ("Meta+ArrowRight", &["moveToRightEndOfLine:"]),
    ("Shift+Meta+NumpadSubtract", &["cancel:"]),
    ("Shift+Meta+Backspace", &["deleteToBeginningOfLine:"]),
    ("Shift+Meta+ArrowUp", &["moveToBeginningOfDocumentAndModifySelection:"]),
    ("Shift+Meta+ArrowDown", &["moveToEndOfDocumentAndModifySelection:"]),
    ("Shift+Meta+ArrowLeft", &["moveToLeftEndOfLineAndModifySelection:"]),
    ("Shift+Meta+ArrowRight", &["moveToRightEndOfLineAndModifySelection:"]),
    ("Meta+KeyA", &["selectAll:"]),
    ("Meta+KeyC", &["copy:"]),
    ("Meta+KeyX", &["cut:"]),
    ("Meta+KeyV", &["paste:"]),
    ("Meta+KeyZ", &["undo:"]),
    ("Shift+Meta+KeyZ", &["redo:"]),
];

/// `_commandsForCode` of `crInput.ts` for macOS: the commands for `code`
/// with `modifiers` held (`insert*` ones dropped, without the final `:`).
pub fn mac_commands(code: &str, modifiers: &[&str]) -> Vec<String> {
    let mut parts: Vec<&str> = ["Shift", "Control", "Alt", "Meta"]
        .into_iter()
        .filter(|modifier| modifiers.contains(modifier))
        .collect();
    parts.push(code);
    let shortcut = parts.join("+");
    MAC_EDITING_COMMANDS
        .iter()
        .find(|(name, _)| *name == shortcut)
        .map_or(&[][..], |(_, commands)| *commands)
        .iter()
        .filter(|command| !command.starts_with("insert"))
        .map(|command| command[..command.len() - 1].to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_playwrights_closure() {
        let layout = us_keyboard_layout();
        assert_eq!(US_KEYBOARD_LAYOUT.len(), 111);
        let a = &layout["KeyA"];
        assert_eq!((a.key, a.text, a.key_code, a.code), ("a", "a", 65, "KeyA"));
        let shifted = a.shifted.as_deref().unwrap();
        assert_eq!(
            (shifted.key, shifted.text, shifted.key_code),
            ("A", "A", 65)
        );
        // Characters and aliases carry no shifted description.
        assert!(layout["a"].shifted.is_none());
        assert_eq!(layout["A"].code, "KeyA");
        assert_eq!(layout["A"].text, "A");
        assert_eq!(layout["Shift"].code, "ShiftLeft");
        assert_eq!(layout["Shift"].key_code_without_location, 16);
        assert_eq!(layout["Shift"].location, 1);
        assert_eq!(layout["Shift"].text, "");
        assert_eq!(layout["\n"].code, "Enter");
        assert_eq!(layout["\r"].text, "\r");
        assert_eq!(layout[" "].code, "Space");
        // Located keys are reached by code only.
        assert_eq!(layout["/"].code, "Slash");
        assert_eq!(layout["*"].code, "Digit8");
        assert_eq!(layout["+"].code, "Equal");
        assert!(!layout.contains_key("Clear"));
        let numpad7 = &layout["Numpad7"];
        assert_eq!(
            (numpad7.key, numpad7.text, numpad7.location),
            ("Home", "", 3)
        );
        let numpad7_shifted = numpad7.shifted.as_deref().unwrap();
        assert_eq!(
            (
                numpad7_shifted.key,
                numpad7_shifted.key_code,
                numpad7_shifted.key_code_without_location
            ),
            ("7", 103, 36)
        );
        assert_eq!(layout["NumpadDecimal"].text, "\0");
        assert_eq!(layout["Enter"].text, "\r");
        assert_eq!(layout["Escape"].text, "");
    }

    #[test]
    fn maps_mac_editing_commands() {
        assert_eq!(MAC_EDITING_COMMANDS.len(), 114);
        assert_eq!(mac_commands("KeyA", &["Meta"]), ["selectAll"]);
        assert_eq!(
            mac_commands("ArrowUp", &["Alt"]),
            ["moveBackward", "moveToBeginningOfParagraph"]
        );
        // `insert*` commands are Chromium's own.
        assert_eq!(mac_commands("KeyO", &["Control"]), ["moveBackward"]);
        assert!(mac_commands("Enter", &[]).is_empty());
        assert_eq!(
            mac_commands("ArrowLeft", &["Meta", "Shift"]),
            ["moveToLeftEndOfLineAndModifySelection"]
        );
    }
}
