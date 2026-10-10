//! M1 spike B (plans/rust-rewrite.md): the cost of running `ptc` scripts in
//! a Rust `ptc-guest`. Built three ways to measure what each piece adds:
//!
//! - no features: tokio only (the node has it anyway), the baseline;
//! - `quickjs`: plus native QuickJS through rquickjs, with the guest's
//!   limits (heap, interrupt) and an async host call like `tools.call`;
//! - `quickjs,oxc`: plus TypeScript type stripping and the preflight's
//!   `tools.<name>` manifest, replacing `Bun.Transpiler` and acorn.
//!
//! `cargo run --release --features quickjs,oxc` also checks behaviour.

#[cfg(feature = "oxc")]
mod strip {
    use std::path::Path;

    use oxc::allocator::Allocator;
    use oxc::ast::ast::{Expression, StaticMemberExpression};
    use oxc::ast_visit::Visit;
    use oxc::codegen::Codegen;
    use oxc::parser::Parser;
    use oxc::semantic::SemanticBuilder;
    use oxc::span::SourceType;
    use oxc::transformer::{TransformOptions, Transformer};

    /// TypeScript to JavaScript, plus the `tools.<name>` capabilities used.
    pub fn preflight(source: &str) -> Result<(String, Vec<String>), String> {
        let wrapped = format!("async function __ptc_main() {{\n{source}\n}}");
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &wrapped, SourceType::ts()).parse();
        if let Some(error) = parsed.diagnostics.first() {
            return Err(format!("Syntax error: {error}"));
        }
        let mut program = parsed.program;
        let mut manifest = Manifest(Vec::new());
        manifest.visit_program(&program);
        let scoping = SemanticBuilder::new()
            .build(&program)
            .semantic
            .into_scoping();
        let transformed = Transformer::new(
            &allocator,
            Path::new("script.ts"),
            &TransformOptions::default(),
        )
        .build_with_scoping(scoping, &mut program);
        if let Some(error) = transformed.diagnostics.first() {
            return Err(format!("{error}"));
        }
        Ok((Codegen::new().build(&program).code, manifest.0))
    }

    struct Manifest(Vec<String>);

    impl<'a> Visit<'a> for Manifest {
        fn visit_static_member_expression(&mut self, member: &StaticMemberExpression<'a>) {
            if let Expression::Identifier(object) = &member.object
                && object.name == "tools"
                && !self.0.iter().any(|name| name == member.property.name.as_str())
            {
                self.0.push(member.property.name.to_string());
            }
            oxc::ast_visit::walk::walk_static_member_expression(self, member);
        }
    }
}

#[cfg(feature = "quickjs")]
#[allow(deprecated)] // async_with!: the spike does not need the closure form
mod guest {
    use std::time::{Duration, Instant};

    use rquickjs::prelude::Async;
    use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, Function, Promise, async_with};

    /// Run `js` (defining `async function __ptc_main`) with the guest's
    /// limits; `tools.call` answers after a short await, like an IPC round trip.
    pub async fn run(js: &str, heap_bytes: usize, budget: Duration) -> Result<String, String> {
        let runtime = AsyncRuntime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(heap_bytes).await;
        let deadline = Instant::now() + budget;
        runtime
            .set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)))
            .await;
        let context = AsyncContext::full(&runtime)
            .await
            .map_err(|e| e.to_string())?;
        let script = format!(
            "{js}\nconst tools = {{ call: (name, args) => __call(name, JSON.stringify(args)).then(JSON.parse) }};\n\
             (async () => JSON.stringify(await __ptc_main()))()"
        );
        async_with!(context => |ctx| {
            let call = Function::new(
                ctx.clone(),
                Async(|name: String, args: String| async move {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    Ok::<_, rquickjs::Error>(format!(
                        "{{\"ok\":true,\"data\":{{\"text\":{}}}}}",
                        rquickjs_json_string(&format!("{name} {args}"))
                    ))
                }),
            )
            .map_err(|e| e.to_string())?;
            ctx.globals().set("__call", call).map_err(|e| e.to_string())?;
            let promise: Promise = ctx.eval(script).catch(&ctx).map_err(|e| e.to_string())?;
            promise
                .into_future::<String>()
                .await
                .catch(&ctx)
                .map_err(|e| e.to_string())
        })
        .await
    }

    fn rquickjs_json_string(text: &str) -> String {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    #[cfg(feature = "oxc")]
    let (js, manifest) = strip::preflight(
        "type Hit = { path: string };\n\
         const hits: Hit[] = [{ path: 'a.ts' }];\n\
         const read = await tools.call('read', { path: hits[0]!.path });\n\
         const n = tools.ls ? 1 : 0;\n\
         return { read, n } as const;",
    )
    .expect("preflight");
    #[cfg(feature = "oxc")]
    println!("manifest: {manifest:?}\nstripped:\n{js}");
    #[cfg(not(feature = "oxc"))]
    let js = "async function __ptc_main() { return await tools.call('read', { path: 'a.ts' }); }"
        .to_owned();

    #[cfg(feature = "quickjs")]
    {
        use std::time::Duration;
        let ok = guest::run(&js, 128 << 20, Duration::from_secs(5)).await;
        println!("result: {ok:?}");
        let spin = guest::run(
            "async function __ptc_main() { for (;;) {} }",
            128 << 20,
            Duration::from_millis(200),
        )
        .await;
        println!("busy loop: {spin:?}");
        let heap = guest::run(
            "async function __ptc_main() { const a = []; for (;;) a.push('x'.repeat(1 << 20)); }",
            32 << 20,
            Duration::from_secs(10),
        )
        .await;
        println!("heap: {heap:?}");
    }
    #[cfg(not(feature = "quickjs"))]
    println!("{}", js.len());
}
