//! `read`, `write`, `edit`, `ls`, `find`, `grep` (`agent/tools/files.ts`).

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use pirc_policy::truncate_output;
use pirc_protocol::UserBlock;
use serde_json::{Map, Value, json};

use super::glob::Glob;
use super::js::{self, JsRegex, fs_error};
use super::result_schema::{arr, bool_, fields, int, nullable, obj, one_of_strings, str_};
use super::{
    ToolContext, ToolResult, ToolSpec, blocking, optional_number, require_string, spec_tool,
    string_or, typed,
};

/// Bytes of `content` (as JSON) a `read` result carries at most.
const READ_CONTENT_BYTES: usize = 4 * 1024 * 1024;

fn image_type(file: &str) -> Option<&'static str> {
    match js::extname(file).to_lowercase().as_str() {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

/// Bytes one character takes in a JSON string.
fn json_char_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{08}' | '\u{0C}' | '\n' | '\r' | '\t' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

fn json_len(text: &str) -> usize {
    2 + text.chars().map(json_char_len).sum::<usize>()
}

/// `cutJson`: the longest prefix of `text` whose JSON encoding fits `bytes`.
fn cut_json(text: &str, bytes: usize) -> &str {
    let mut used = 2;
    for (index, c) in text.char_indices() {
        used += json_char_len(c);
        if used > bytes {
            return &text[..index];
        }
    }
    text
}

/// `fs.stat`.
fn stat(path: &str) -> Result<fs::Metadata, String> {
    fs::metadata(path).map_err(|error| fs_error(&error, "stat", Some(path)))
}

/// `fs.readFile(path)`.
fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|error| fs_error(&error, "open", Some(path)))?;
    let mut out = Vec::new();
    file.read_to_end(&mut out)
        .map_err(|error| fs_error(&error, "read", None))?;
    Ok(out)
}

/// `fs.readFile(path, 'utf8')`.
pub(crate) fn read_text(path: &str) -> Result<String, String> {
    read_bytes(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `fs.realpath`.
fn realpath(path: &str) -> Result<String, String> {
    fs::canonicalize(path)
        .map(|real| real.display().to_string())
        .map_err(|error| fs_error(&error, "lstat", Some(path)))
}

pub struct ReadTool {
    spec: ToolSpec,
}

impl Default for ReadTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadTool {
    pub fn new() -> Self {
        let text = fields(
            vec![
                ("kind", json!({ "const": "text" })),
                ("path", str_(Some("The path as requested"))),
                (
                    "content",
                    str_(Some("The lines read, without line numbers (at most 4 MiB)")),
                ),
                (
                    "contentTruncated",
                    bool_(Some("content was cut at 4 MiB; read fewer lines")),
                ),
                ("offset", int(Some("1-based first line returned"))),
                ("lines", int(Some("Lines returned"))),
                ("totalLines", int(None)),
                (
                    "nextOffset",
                    nullable(int(Some(
                        "Offset of the next unread line, or null at the end",
                    ))),
                ),
                ("truncated", bool_(Some("text was cut to the output limit"))),
            ],
            &[],
        );
        let image = fields(
            vec![
                ("kind", json!({ "const": "image" })),
                ("path", str_(None)),
                ("mimeType", str_(None)),
                ("bytes", int(None)),
            ],
            &[],
        );
        Self {
            spec: ToolSpec::new(
                "read",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the workspace or absolute" },
                        "offset": { "type": "number", "description": "1-based first line" },
                        "limit": { "type": "number", "description": "Maximum lines to return" },
                    },
                    "required": ["path"],
                    "additionalProperties": false,
                }),
                Some(json!({ "oneOf": [text, image] })),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let requested = require_string(&args, "path")?.to_owned();
        let file = ctx.guard.resolve(&requested, false)?;
        let info = {
            let file = file.clone();
            blocking(move || stat(&file)).await?
        };
        if info.is_dir() {
            return Err(format!("{requested} is a directory; use ls"));
        }
        if let Some(mime) = image_type(&file) {
            if info.size() > 5 * 1024 * 1024 {
                return Err("Image is larger than 5 MiB".to_owned());
            }
            let bytes = blocking(move || read_bytes(&file)).await?;
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Ok(ToolResult {
                content: vec![
                    UserBlock::Text {
                        text: format!("Image {requested} ({} bytes)", info.size()),
                        text_signature: None,
                    },
                    UserBlock::Image {
                        data,
                        mime_type: mime.to_owned(),
                    },
                ],
                data: json!({ "kind": "image", "path": requested, "mimeType": mime, "bytes": info.size() })
                    .as_object()
                    .cloned(),
                ..ToolResult::default()
            });
        }
        let raw = blocking(move || read_text(&file)).await?;
        let lines: Vec<&str> = raw.split('\n').collect();
        let offset = optional_number(&args, "offset")?
            .unwrap_or(1.0)
            .floor()
            .max(1.0);
        let limit = optional_number(&args, "limit")?
            .unwrap_or(2000.0)
            .floor()
            .max(1.0);
        let total = lines.len() as f64;
        let start = (offset - 1.0).min(total) as usize;
        let stop = (offset - 1.0 + limit).min(total) as usize;
        let slice = &lines[start..stop.max(start)];
        let width = js::float_text(offset + slice.len() as f64).len();
        let mut body = slice
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let number = js::float_text(offset + index as f64);
                format!("{number:>width$}\t{}", js::head16(line, 4000))
            })
            .collect::<Vec<_>>()
            .join("\n");
        let end = offset - 1.0 + slice.len() as f64;
        let more = end < total;
        if more {
            body.push_str(&format!(
                "\n\n[Showing lines {}-{} of {}. Use offset={} to continue.]",
                js::float_text(offset),
                js::float_text(end),
                lines.len(),
                js::float_text(end + 1.0)
            ));
        }
        let (shown, truncated) =
            truncate_output(&body, (ctx.config.limits.tool_output_bytes * 2) as usize);
        let content = slice.join("\n");
        let content_truncated = json_len(&content) > READ_CONTENT_BYTES;
        let content = if content_truncated {
            cut_json(&content, READ_CONTENT_BYTES).to_owned()
        } else {
            content
        };
        Ok(typed(
            shown,
            json!({
                "kind": "text",
                "path": requested,
                "content": content,
                "contentTruncated": content_truncated,
                "offset": offset as u64,
                "lines": slice.len(),
                "totalLines": lines.len(),
                "nextOffset": if more { json!((end + 1.0) as u64) } else { Value::Null },
                "truncated": truncated,
            }),
            None,
            false,
        ))
    }
}

spec_tool!(ReadTool, ptc: true);

/// The file a write to `file` (already allowed by the guard) really lands
/// in. The guard resolves a dangling symlink to its own location, so a link
/// to a missing file outside the writable roots would pass it: refuse those,
/// and re-check the target of any other link.
async fn write_target(file: String, ctx: &ToolContext, shown: &str) -> Result<String, String> {
    let link = {
        let file = file.clone();
        blocking(move || {
            fs::symlink_metadata(&file)
                .ok()
                .filter(|info| info.file_type().is_symlink())
                .map(|_| fs::canonicalize(&file).map(|real| real.display().to_string()))
        })
        .await
    };
    match link {
        None => Ok(file),
        Some(Err(_)) => Err(format!(
            "{shown} is a symbolic link to a missing target; refusing to write through it"
        )),
        Some(Ok(target)) => ctx.guard.resolve(&target, true),
    }
}

/// Write `content` to `file` once its directory exists, re-checked against
/// the guard; never through a symlink in the last component.
async fn write_checked(file: &str, content: String, ctx: &ToolContext) -> Result<(), String> {
    let dir = js::dirname(file);
    let real = blocking(move || realpath(&dir)).await?;
    ctx.guard
        .resolve(&js::join(&real, js::basename(file)), true)?;
    let file = file.to_owned();
    blocking(move || {
        let mut handle = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&file)
            .map_err(|error| fs_error(&error, "open", Some(&file)))?;
        handle
            .write_all(content.as_bytes())
            .map_err(|error| fs_error(&error, "write", None))
    })
    .await
}

pub struct WriteTool {
    spec: ToolSpec,
}

impl Default for WriteTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WriteTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "write",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" },
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false,
                }),
                Some(fields(
                    vec![
                        ("path", str_(Some("The path as requested"))),
                        ("bytes", int(Some("Bytes written"))),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let requested = require_string(&args, "path")?.to_owned();
        let Some(Value::String(content)) = args.get("content") else {
            return Err("content must be a string".to_owned());
        };
        let resolved = ctx.guard.resolve(&requested, true)?;
        let file = write_target(resolved, &ctx, &requested).await?;
        (ctx.acquire_write)(file.clone()).await?;
        let dir = js::dirname(&file);
        blocking(move || fs::create_dir_all(&dir).map_err(|e| fs_error(&e, "mkdir", Some(&dir))))
            .await?;
        write_checked(&file, content.clone(), &ctx).await?;
        let bytes = content.len();
        Ok(typed(
            format!("Wrote {bytes} bytes to {requested}"),
            json!({ "path": requested, "bytes": bytes }),
            None,
            false,
        ))
    }
}

spec_tool!(WriteTool, ptc: true);

/// `simpleDiff`.
fn simple_diff(before: &str, after: &str, file: &str) -> String {
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut start = 0usize;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end_a = a.len() as isize - 1;
    let mut end_b = b.len() as isize - 1;
    while end_a >= start as isize
        && end_b >= start as isize
        && a[end_a as usize] == b[end_b as usize]
    {
        end_a -= 1;
        end_b -= 1;
    }
    let from = start.saturating_sub(3);
    let mut lines = vec![
        format!("--- {file}"),
        format!("+++ {file}"),
        format!("@@ -{} +{} @@", from + 1, from + 1),
    ];
    for line in &a[from..start] {
        lines.push(format!(" {line}"));
    }
    for i in start as isize..=end_a {
        lines.push(format!("-{}", a[i as usize]));
    }
    for i in start as isize..=end_b {
        lines.push(format!("+{}", b[i as usize]));
    }
    let context_end = (a.len() as isize).min(end_a + 4);
    for i in (end_a + 1)..context_end {
        lines.push(format!(" {}", a[i as usize]));
    }
    lines.join("\n")
}

pub struct EditTool {
    spec: ToolSpec,
}

impl Default for EditTool {
    fn default() -> Self {
        Self::new()
    }
}

impl EditTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "edit",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "oldText": { "type": "string" },
                        "newText": { "type": "string" },
                        "replaceAll": { "type": "boolean" },
                    },
                    "required": ["path", "oldText", "newText"],
                    "additionalProperties": false,
                }),
                Some(fields(
                    vec![
                        ("path", str_(Some("The path as requested"))),
                        ("replacements", int(None)),
                        ("diff", str_(Some("A unified diff of the change"))),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let requested = require_string(&args, "path")?.to_owned();
        let resolved = ctx.guard.resolve(&requested, true)?;
        let file = write_target(resolved, &ctx, &requested).await?;
        let old_text = require_string(&args, "oldText")?.to_owned();
        let Some(Value::String(new_text)) = args.get("newText") else {
            return Err("newText must be a string".to_owned());
        };
        let before = {
            let file = file.clone();
            blocking(move || read_text(&file)).await?
        };
        let count = before.matches(old_text.as_str()).count();
        if count == 0 {
            return Err(format!("oldText not found in {requested}"));
        }
        let replace_all = js::truthy(args.get("replaceAll"));
        if count > 1 && !replace_all {
            return Err(format!(
                "oldText matches {count} times in {requested}; add context or set replaceAll"
            ));
        }
        let after = if replace_all {
            before.replace(old_text.as_str(), new_text)
        } else {
            before.replacen(old_text.as_str(), new_text, 1)
        };
        (ctx.acquire_write)(file.clone()).await?;
        let diff = simple_diff(&before, &after, &requested);
        write_checked(&file, after, &ctx).await?;
        Ok(typed(
            format!(
                "Edited {requested} ({count} replacement{})",
                if count == 1 { "" } else { "s" }
            ),
            json!({ "path": requested, "replacements": count, "diff": diff }),
            Some(json!({ "diff": diff })),
            false,
        ))
    }
}

spec_tool!(EditTool, ptc: true);

pub struct LsTool {
    spec: ToolSpec,
}

impl Default for LsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl LsTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "ls",
                json!({
                    "type": "object",
                    "properties": { "path": { "type": "string", "description": "Default: workspace root" } },
                    "additionalProperties": false,
                }),
                Some(fields(
                    vec![
                        (
                            "entries",
                            arr(
                                obj(
                                    vec![
                                        ("name", str_(None)),
                                        (
                                            "type",
                                            one_of_strings(
                                                &["file", "directory", "symlink", "other"],
                                                None,
                                            ),
                                        ),
                                    ],
                                    &[],
                                ),
                                Some("Sorted by name; at most 1000"),
                            ),
                        ),
                        ("total", int(Some("Entries in the directory"))),
                        ("truncated", bool_(None)),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let dir = ctx.guard.resolve(string_or(&args, "path", "."), false)?;
        let mut entries = blocking(move || {
            let read = fs::read_dir(&dir).map_err(|e| fs_error(&e, "scandir", Some(&dir)))?;
            Ok::<_, String>(
                read.filter_map(Result::ok)
                    .map(|entry| {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let kind = match entry.file_type() {
                            Ok(t) if t.is_dir() => "directory",
                            Ok(t) if t.is_file() => "file",
                            Ok(t) if t.is_symlink() => "symlink",
                            _ => "other",
                        };
                        (name, kind)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .await?;
        entries.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
        let names: Vec<String> = entries
            .iter()
            .map(|(name, kind)| {
                if *kind == "directory" {
                    format!("{name}/")
                } else {
                    name.clone()
                }
            })
            .collect();
        let shown = &names[..names.len().min(1000)];
        let mut text = shown.join("\n");
        if names.len() > shown.len() {
            text.push_str(&format!("\n[{} more]", names.len() - shown.len()));
        }
        if text.is_empty() {
            text = "(empty)".to_owned();
        }
        let listed: Vec<Value> = entries
            .iter()
            .take(1000)
            .map(|(name, kind)| json!({ "name": name, "type": kind }))
            .collect();
        Ok(typed(
            text,
            json!({ "entries": listed, "total": entries.len(), "truncated": entries.len() > 1000 }),
            None,
            false,
        ))
    }
}

spec_tool!(LsTool, ptc: true);

const SKIP_DIRS: [&str; 6] = [
    ".git",
    "node_modules",
    ".direnv",
    "result",
    "dist",
    "target",
];

/// `walk(root, {left})`: files depth-first (the last directory found
/// first), skipping `SKIP_DIRS`, at most `left`; `visit` returns false to
/// stop.
fn walk(
    root: &str,
    mut left: i64,
    mut visit: impl FnMut(String) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stack = vec![root.to_owned()];
    while left > 0 {
        let Some(dir) = stack.pop() else {
            break;
        };
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = js::join(&dir, &name);
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(full);
                }
            } else if kind.is_file() {
                if left <= 0 {
                    return Ok(());
                }
                left -= 1;
                if !visit(full)? {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

pub struct FindTool {
    spec: ToolSpec,
}

impl Default for FindTool {
    fn default() -> Self {
        Self::new()
    }
}

impl FindTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "find",
                json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string" },
                        "path": { "type": "string", "description": "Directory to search (default workspace)" },
                    },
                    "required": ["pattern"],
                    "additionalProperties": false,
                }),
                Some(fields(
                    vec![
                        (
                            "paths",
                            arr(
                                str_(None),
                                Some(
                                    "Matching files relative to the searched directory, sorted; at most 500",
                                ),
                            ),
                        ),
                        ("truncated", bool_(Some("The 500-match limit was reached"))),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let root = ctx.guard.resolve(string_or(&args, "path", "."), false)?;
        let glob = Glob::new(require_string(&args, "pattern")?);
        // TS walked synchronously and could not be stopped; an abort here
        // ends the walk, as grep's does.
        let aborted = Arc::new(AtomicBool::new(false));
        {
            let aborted = aborted.clone();
            ctx.signal
                .on_abort(move || aborted.store(true, Ordering::Relaxed));
        }
        let mut matches = blocking(move || {
            let mut matches = Vec::new();
            walk(&root, 200_000, |file| {
                if aborted.load(Ordering::Relaxed) {
                    return Err("Aborted".to_owned());
                }
                let relative = js::relative(&root, &file);
                if glob.is_match(&relative) {
                    matches.push(relative);
                }
                Ok(matches.len() < 500)
            })
            .map(|()| matches)
        })
        .await?;
        matches.sort_by(|a, b| js::compare16(a, b));
        let text = if matches.is_empty() {
            "No matches".to_owned()
        } else {
            matches.join("\n")
        };
        let truncated = matches.len() >= 500;
        Ok(typed(
            text,
            json!({ "paths": matches, "truncated": truncated }),
            None,
            false,
        ))
    }
}

spec_tool!(FindTool, ptc: true);

pub struct GrepTool {
    spec: ToolSpec,
}

impl Default for GrepTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GrepTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "grep",
                json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string" },
                        "path": { "type": "string" },
                        "glob": { "type": "string" },
                        "ignoreCase": { "type": "boolean" },
                        "limit": { "type": "number", "description": "Maximum matches (default 200)" },
                    },
                    "required": ["pattern"],
                    "additionalProperties": false,
                }),
                Some(fields(
                    vec![
                        (
                            "matches",
                            arr(
                                obj(
                                    vec![
                                        ("path", str_(Some("Relative to the searched directory"))),
                                        ("line", int(Some("1-based"))),
                                        ("text", str_(Some("The line, cut at 300 characters"))),
                                    ],
                                    &[],
                                ),
                                None,
                            ),
                        ),
                        ("truncated", bool_(Some("The match limit was reached"))),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let root = ctx.guard.resolve(string_or(&args, "path", "."), false)?;
        let flags = if js::truthy(args.get("ignoreCase")) {
            "i"
        } else {
            ""
        };
        let regex = JsRegex::new(require_string(&args, "pattern")?, flags)?;
        let filter = match args.get("glob") {
            Some(Value::String(glob)) if !glob.is_empty() => Some(Glob::new(glob)),
            _ => None,
        };
        let limit = optional_number(&args, "limit")?
            .unwrap_or(200.0)
            .floor()
            .max(1.0);
        let aborted = Arc::new(AtomicBool::new(false));
        {
            let aborted = aborted.clone();
            ctx.signal
                .on_abort(move || aborted.store(true, Ordering::Relaxed));
        }
        let (results, matches) = blocking(move || {
            let info = stat(&root)?;
            let base = if info.is_file() {
                js::dirname(&root)
            } else {
                root.clone()
            };
            let mut results: Vec<String> = Vec::new();
            let mut matches: Vec<Value> = Vec::new();
            let mut search = |file: String| -> Result<bool, String> {
                if aborted.load(Ordering::Relaxed) {
                    return Err("Aborted".to_owned());
                }
                let relative = js::relative(&base, &file);
                if let Some(filter) = &filter
                    && !filter.is_match(&relative)
                    && !filter.is_match(js::basename(&file))
                {
                    return Ok(true);
                }
                let Ok(size) = fs::metadata(&file).map(|info| info.size()) else {
                    return Ok(true);
                };
                if size > 2 * 1024 * 1024 {
                    return Ok(true);
                }
                let Ok(content) = read_text(&file) else {
                    return Ok(true);
                };
                if content.contains('\0') {
                    return Ok(true);
                }
                for (index, line) in content.split('\n').enumerate() {
                    if regex.test(line) {
                        let text = js::head16(line, 300);
                        results.push(format!("{relative}:{}: {text}", index + 1));
                        matches.push(json!({ "path": relative, "line": index + 1, "text": text }));
                        if results.len() as f64 >= limit {
                            break;
                        }
                    }
                }
                Ok((results.len() as f64) < limit)
            };
            if info.is_file() {
                search(root.clone())?;
            } else {
                walk(&root, 100_000, search)?;
            }
            Ok::<_, String>((results, matches))
        })
        .await?;
        let reached = results.len() as f64 >= limit;
        let text = if results.is_empty() {
            "No matches".to_owned()
        } else if reached {
            format!(
                "{}\n[limit {} reached]",
                results.join("\n"),
                js::float_text(limit)
            )
        } else {
            results.join("\n")
        };
        Ok(typed(
            text,
            json!({ "matches": matches, "truncated": reached }),
            None,
            false,
        ))
    }
}

spec_tool!(GrepTool, ptc: true);
