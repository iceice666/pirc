//! Pre-evaluation check (`agent/ptc/preflight.ts`; docs/architecture/ptc.md):
//! strip TypeScript, parse the script and derive the
//! capabilities it may call. Capability names must be literals —
//! `tools.read(…)` or `tools.call("read", …)`. Computed names, aliases of
//! `tools`/`tools.call` and redeclaring `tools` are rejected before
//! anything runs. The runtime separately refuses dispatch outside this
//! manifest, so the check is a fail-closed display aid, not authorization.
//!
//! TS stripped types with `Bun.Transpiler` and checked the JavaScript it
//! printed with acorn; here oxc does both, and the check walks the printed
//! JavaScript too, so type syntax (`(tools as any)[…]`) is judged as it runs.

use std::collections::HashSet;
use std::path::Path;

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Argument, AssignmentTargetPropertyIdentifier, BindingIdentifier, BindingProperty,
    CallExpression, ComputedMemberExpression, Expression, IdentifierReference, ObjectProperty,
    PropertyKey, Statement, StaticMemberExpression,
};
use oxc::ast_visit::{Visit, walk};
use oxc::codegen::{Codegen, CodegenOptions, CommentOptions};
use oxc::parser::{ParseOptions, Parser};
use oxc::semantic::SemanticBuilder;
use oxc::span::{GetSpan, SourceType, Span};
use oxc::transformer::{TransformOptions, Transformer};

use crate::contracts::{PtcError, budgets};

const MAIN: &str = "__ptc_main";

/// `PreflightResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct Preflight {
    /// JavaScript defining `async function __ptc_main()`.
    pub js: String,
    /// Capability names in first-use order.
    pub manifest: Vec<String>,
}

fn invalid(message: impl Into<String>) -> PtcError {
    PtcError::new("InvalidArguments", message)
}

fn syntax_error(diagnostic: &impl std::fmt::Display) -> PtcError {
    invalid(format!("Syntax error: {diagnostic}"))
}

/// `preflight(source)`.
pub fn preflight(source: &str) -> Result<Preflight, PtcError> {
    if source.trim().is_empty() {
        return Err(invalid("code must be a non-empty string"));
    }
    if source.len() > budgets::SOURCE_BYTES {
        return Err(PtcError::new(
            "QuotaExceeded",
            format!(
                "code exceeds {} bytes; split the work across ptc calls",
                budgets::SOURCE_BYTES
            ),
        ));
    }
    // oxc's parser, transformer, printer and the walk below recurse without
    // a depth limit, so deeply nested code (`((((…`, `!!!!…`) within the
    // size budget would overflow the caller's stack and abort the agent
    // (TS refused it: "Maximum call stack size exceeded"). They run on a
    // thread whose stack holds the deepest source the budget allows. A panic
    // there is a bug in oxc; the script is refused instead of taking the
    // agent down.
    let wrapped = format!("async function {MAIN}() {{\n{source}\n}}");
    let spawned = std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("ptc-preflight".to_owned())
            .stack_size(PREFLIGHT_STACK_BYTES)
            .spawn_scoped(scope, || {
                let js = strip_types(&wrapped)?;
                let manifest = check(&js)?;
                Ok(Preflight { js, manifest })
            })
            .map(|handle| handle.join())
    });
    match spawned {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(invalid("Syntax error: the TypeScript transform failed")),
        // Not the script's fault (address-space limits, out of threads).
        Err(error) => Err(PtcError::new(
            "OperationFailed",
            format!("Script runtime failed: could not start the preflight ({error})"),
        )),
    }
}

/// Stack of the preflight thread: room for any source within
/// `SOURCE_BYTES` nested as deeply as it can be (tested below; every shape
/// measured fits in 64 MiB). Address space only, until used, but counted
/// against `RLIMIT_AS` and strict overcommit, so no larger than needed.
const PREFLIGHT_STACK_BYTES: usize = 256 << 20;

/// TypeScript to JavaScript (`Bun.Transpiler({ loader: 'ts' })`), as a
/// script: no imports or exports, sloppy mode unless the code opts in.
fn strip_types(wrapped: &str) -> Result<String, PtcError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, wrapped, SourceType::ts().with_script(true)).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(syntax_error(error));
    }
    if parsed.fatal_error {
        return Err(invalid("Syntax error: Unexpected end of input"));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new()
        .with_enum_eval(true)
        .build(&program)
        .semantic
        .into_scoping();
    let transformed = Transformer::new(
        &allocator,
        Path::new("ptc.ts"),
        &TransformOptions::default(),
    )
    .build_with_scoping(scoping, &mut program);
    if let Some(error) = transformed.diagnostics.first() {
        return Err(syntax_error(error));
    }
    // Without comments, as Bun printed it. Line numbers in the problems below
    // count lines of this printed form, as TS counted Bun's (which kept
    // single-line objects on one line; oxc breaks those with two or more
    // properties).
    Ok(Codegen::new()
        .with_options(CodegenOptions {
            comments: CommentOptions::disabled(),
            ..CodegenOptions::default()
        })
        .build(&program)
        .code)
}

/// `lineOf(js, offset)`: the script's line (the wrapper adds one before it).
fn line_of(js: &str, offset: u32) -> usize {
    let end = (offset as usize).min(js.len());
    let line = 1 + js.as_bytes()[..end].iter().filter(|b| **b == b'\n').count();
    line.saturating_sub(1).max(1)
}

/// Parse the stripped JavaScript as acorn did (`ecmaVersion: 'latest'`,
/// `sourceType: 'script'`) and collect the capability names.
fn check(js: &str) -> Result<Vec<String>, PtcError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, js, SourceType::script())
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(syntax_error(error));
    }
    let program = parsed.program;
    // Early errors acorn reports while parsing (duplicate `let`, …).
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&program);
    if let Some(error) = semantic.diagnostics.first() {
        return Err(syntax_error(error));
    }
    let main = match program.body.as_slice() {
        [Statement::FunctionDeclaration(function)]
            if program.directives.is_empty()
                && function.r#async
                && function.id.as_ref().is_some_and(|id| id.name == MAIN) =>
        {
            Some(function)
        }
        _ => None,
    };
    if main.is_none() {
        return Err(invalid(
            "code must be the body of one async function; unbalanced braces end it early",
        ));
    }
    let mut names = Names {
        js,
        manifest: Vec::new(),
        problems: Vec::new(),
        callees: HashSet::new(),
    };
    names.visit_program(&program);
    if !names.problems.is_empty() {
        return Err(invalid(format!(
            "Capability names must be literals:\n{}",
            names.problems.join("\n")
        )));
    }
    Ok(names.manifest)
}

/// `literalString(node)`: a string literal or a template without
/// substitutions.
fn literal_string(argument: Option<&Argument>) -> Option<String> {
    match argument? {
        Argument::StringLiteral(literal) => Some(literal.value.to_string()),
        Argument::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            template.quasis[0]
                .value
                .cooked
                .as_ref()
                .map(|cooked| cooked.to_string())
        }
        _ => None,
    }
}

fn literal_expression(expression: &Expression) -> Option<String> {
    match expression {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        Expression::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            template.quasis[0]
                .value
                .cooked
                .as_ref()
                .map(|cooked| cooked.to_string())
        }
        _ => None,
    }
}

const TOOLS: &str = "tools";

fn is_tools(expression: &Expression) -> bool {
    matches!(expression, Expression::Identifier(id) if id.name == TOOLS)
}

/// The walk of `preflight`'s `visit`: every reference to `tools` that is
/// not `tools.<name>`, `tools.par` or a direct `tools.call("<name>", …)`.
struct Names<'s> {
    js: &'s str,
    manifest: Vec<String>,
    problems: Vec<String>,
    /// `tools.call` members that are the callee of a call.
    callees: HashSet<(u32, u32)>,
}

impl Names<'_> {
    fn add(&mut self, name: String) {
        if !self.manifest.contains(&name) {
            self.manifest.push(name);
        }
    }

    fn reject(&mut self, span: Span, why: &str) {
        if self.problems.len() < 8 {
            let line = line_of(self.js, span.start);
            self.problems.push(format!("line {line}: {why}"));
        }
    }

    fn reject_reference(&mut self, span: Span) {
        self.reject(
            span,
            "`tools` must be used directly as tools.<name>(…) or tools.call(\"<name>\", …)",
        );
    }

    /// acorn copies a shorthand property's key into its value, so `{ tools }`
    /// had two `tools` identifiers, each rejected.
    fn shorthand(&mut self, key: &PropertyKey, shorthand: bool) {
        if shorthand
            && let PropertyKey::StaticIdentifier(id) = key
            && id.name == TOOLS
        {
            self.reject_reference(id.span);
        }
    }
}

impl<'a> Visit<'a> for Names<'_> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if it.name == TOOLS {
            self.reject_reference(it.span);
        }
    }

    fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
        if it.name == TOOLS {
            self.reject_reference(it.span);
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        self.shorthand(&it.key, it.shorthand);
        walk::walk_object_property(self, it);
    }

    fn visit_binding_property(&mut self, it: &BindingProperty<'a>) {
        self.shorthand(&it.key, it.shorthand);
        walk::walk_binding_property(self, it);
    }

    fn visit_assignment_target_property_identifier(
        &mut self,
        it: &AssignmentTargetPropertyIdentifier<'a>,
    ) {
        if it.binding.name == TOOLS {
            self.reject_reference(it.binding.span);
        }
        walk::walk_assignment_target_property_identifier(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(member) = &it.callee
            && is_tools(&member.object)
            && member.property.name == "call"
        {
            self.callees.insert((member.span.start, member.span.end));
            match literal_string(it.arguments.first()) {
                Some(name) => self.add(name),
                None => self.reject(
                    member.object.span(),
                    "tools.call needs a string literal capability name as its first argument",
                ),
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if !is_tools(&it.object) {
            return walk::walk_static_member_expression(self, it);
        }
        match it.property.name.as_str() {
            "par" => {}
            // Recorded (or rejected) by the call it is the callee of.
            "call" if self.callees.contains(&(it.span.start, it.span.end)) => {}
            "call" => self.reject(
                it.object.span(),
                "tools.call must be called directly, not stored or passed around",
            ),
            property => self.add(property.to_owned()),
        }
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if !is_tools(&it.object) {
            return walk::walk_computed_member_expression(self, it);
        }
        let why = match literal_expression(&it.expression) {
            Some(literal) => format!("write tools.{literal}(…) instead of tools[…]"),
            None => "computed capability names (tools[…]) are not allowed; use a literal name"
                .to_owned(),
        };
        self.reject(it.object.span(), &why);
        self.visit_expression(&it.expression);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(code: &str) -> Vec<String> {
        preflight(code).unwrap().manifest
    }

    fn refused(code: &str) -> PtcError {
        preflight(code).unwrap_err()
    }

    /// Sources at the size budget nested as deeply as they can be: refused
    /// or accepted, never a stack overflow that aborts the agent.
    #[test]
    fn deep_nesting_within_the_budget_does_not_overflow() {
        let budget = budgets::SOURCE_BYTES - 64;
        let shapes: [(&str, &str, &str); 9] = [
            ("return ", "(", ")"),
            ("return ", "[", "]"),
            ("", "{", "}"),
            ("return ", "!", ""),
            ("return ", "-", ""),
            ("return ", "a=>", ""),
            ("return ", "a?", ":0"),
            ("", "if(a)", ""),
            ("return ", "`${", "}`"),
        ];
        for (prefix, open, close) in shapes {
            let mut depth = budget / (open.len() + close.len());
            // Nested blocks take oxc quadratic time (under a second in a
            // release build, half a minute unoptimized).
            if cfg!(debug_assertions) && matches!(open, "{" | "if(a)") {
                depth /= 8;
            }
            let source = format!("{prefix}{}1{};", open.repeat(depth), close.repeat(depth));
            let outcome = preflight(&source);
            assert!(
                outcome.is_ok() || outcome.as_ref().unwrap_err().code == "InvalidArguments",
                "{open}: {outcome:?}"
            );
        }
    }

    #[test]
    fn derives_the_manifest_from_member_calls_and_tools_call_literals() {
        assert_eq!(
            manifest(
                "const a: string = (await tools.read({ path: \"x\" })).text;\n\
                 await tools.call(\"grep\", { pattern: `a` });\n\
                 await tools.par([1], async () => tools.ls({}));\n\
                 return `${(await tools.bash({ command: \"x\" })).text}`;"
            ),
            ["read", "grep", "ls", "bash"]
        );
        assert_eq!(
            manifest("return await tools.call?.(\"read\", {});"),
            ["read"]
        );
        assert_eq!(manifest("return await tools?.read({});"), ["read"]);
    }

    #[test]
    fn rejects_computed_and_aliased_names() {
        for (code, why) in [
            ("return await tools[name]({});", "computed"),
            ("return await tools[\"read\"]({});", "write tools.read"),
            (
                "const n = \"read\"; return await tools.call(n, {});",
                "string literal",
            ),
            (
                "return await tools.call(\"re\" + \"ad\", {});",
                "string literal",
            ),
            ("const t = tools; return t.read({});", "used directly"),
            ("const { read } = tools; return read({});", "used directly"),
            (
                "const call = tools.call; return call(\"read\");",
                "called directly",
            ),
            (
                "const tools = { read() {} }; return tools.read();",
                "used directly",
            ),
            ("return [tools].length;", "used directly"),
            ("return ((tools) => tools.read({}))({});", "used directly"),
            ("return { tools };", "used directly"),
            ("await (tools as any)['ba' + 'sh']({});", "computed"),
        ] {
            let error = refused(code);
            assert_eq!(error.code, "InvalidArguments", "{code}");
            assert!(error.message.contains(why), "{code}: {}", error.message);
        }
    }

    #[test]
    fn names_the_line_of_each_problem() {
        assert_eq!(
            refused("const t = tools;\nconst u = tools;").message,
            "Capability names must be literals:\nline 1: `tools` must be used directly as tools.<name>(…) or tools.call(\"<name>\", …)\nline 2: `tools` must be used directly as tools.<name>(…) or tools.call(\"<name>\", …)"
        );
        // A shorthand property counted twice, as acorn's copied key did.
        assert_eq!(
            refused("return { tools };")
                .message
                .matches("line 1:")
                .count(),
            2
        );
        let many: String = (0..12).map(|i| format!("const t{i} = tools;\n")).collect();
        assert_eq!(refused(&many).message.matches("line ").count(), 8);
    }

    #[test]
    fn allows_property_names_and_keys_that_merely_spell_tools() {
        assert!(
            manifest("const x = { tools: 1 }; return x.tools + ({ tools: 2 }).tools;").is_empty()
        );
        assert!(
            manifest("class A { tools() {} #tools = 1; } tools: for (;;) break tools;").is_empty()
        );
    }

    #[test]
    fn rejects_empty_oversized_and_broken_scripts_and_wrapper_escapes() {
        for code in [
            "",
            "   ",
            "return (;",
            "}); globalThis.x = 1; (async () => {",
            "} function x() {",
            "let a = 1; let a = 2;",
            "import x from 'y';",
        ] {
            assert_eq!(refused(code).code, "InvalidArguments", "{code:?}");
        }
        assert_eq!(
            refused("} function x() {").message,
            "code must be the body of one async function; unbalanced braces end it early"
        );
        let big = refused(&"x".repeat(budgets::SOURCE_BYTES + 1));
        assert_eq!(big.code, "QuotaExceeded");
        assert!(big.message.contains("exceeds"));
    }

    #[test]
    fn strips_types_into_one_async_function() {
        let compiled = preflight(
            "type Hit = { path: string };\nconst hits: Hit[] = [{ path: 'a.ts' }];\nreturn hits[0]!.path as string;",
        )
        .unwrap();
        assert!(compiled.js.starts_with("async function __ptc_main() {"));
        assert!(!compiled.js.contains("Hit[]"));
        assert!(!compiled.js.contains(" as string"));
    }
}
