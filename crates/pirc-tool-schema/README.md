# pirc-tool-schema

Pure tool-argument validation and compact TypeScript documentation from JSON
schema/description metadata. The only runtime dependencies are `serde_json` and
`regress` (ECMAScript regular expressions). There is no agent, configuration,
protocol, JavaScript VM, I/O or async-runtime dependency.

```rust
use pirc_tool_schema::{signature_of, validate_schema};
use serde_json::json;

let input = json!({
    "type": "object",
    "properties": { "query": { "type": "string", "minLength": 1 } },
    "required": ["query"],
    "additionalProperties": false
});
let parameters = input.as_object().unwrap();
assert!(validate_schema(&json!({ "query": "hello" }), parameters).is_empty());
assert_eq!(validate_schema(&json!({}), parameters), ["query is required"]);

let result = json!({ "type": "array", "items": { "type": "string" } });
assert_eq!(
    signature_of("api.search", parameters, &result, "Search records."),
    "`api.search(args: { query: string }): string[]`\n  Search records."
);
```

## Validation: a compatibility subset, not full JSON Schema

`validate_schema(value, schema_object)` returns ordered problem strings (empty
means accepted). It preserves the existing PTC tool validator's behavior and
error wording; it does **not** validate schemas against a meta-schema.

Supported keywords:

- `type` (a string or array of strings): null, boolean, integer, number, string,
  array, object. Integral floating-point values match integer; integer matches number.
- `properties`, `required`, `additionalProperties` (false or a nested schema).
- `enum`, `const`.
- `items` (one schema), `minItems`, `maxItems`.
- `minimum`, `maximum`, numeric `exclusiveMinimum`, numeric `exclusiveMaximum`.
- `minLength`, `maxLength`, `pattern`.
- `oneOf`, `anyOf`.

Unknown keywords, including `$ref`, `$defs`, `allOf`, `not`, `format`,
`patternProperties`, `uniqueItems` and tuple validation, are ignored. There is no
reference resolution, coercion, default insertion or schema compilation.
Boolean and other non-object nested schemas impose no constraints; an
array-shaped schema also constrains nothing. Malformed keyword values are
mostly ignored rather than rejected.

Compatibility details worth knowing:

- `enum`/`const` use scalar JavaScript `Object.is`-style comparison, **not** deep
  JSON equality. Objects and arrays never compare equal; negative zero differs
  from positive zero. Numeric comparisons use floating-point values.
- String length bounds count Unicode scalar values. Documentation budgets count
  UTF-16 units instead, and cuts never split a Unicode scalar.
- Patterns use `regress` with ECMAScript Unicode (`u`) semantics, supporting
  lookaround and backreferences. Invalid patterns produce a validation problem
  when a string is checked, not a schema-construction error.
- The eight-error threshold stops subsequent recursive checks; a single object
  check can still emit more than eight required/additional-property problems.
- Property traversal preserves the `serde_json` map's insertion order.
- Required keys are converted to text using the existing JSON/text compatibility
  rules. Error paths use dots and array indices, not JSON Pointer.

These rules are intentionally unsuitable as a general standards-compliant JSON
Schema validator or an adversarial schema/resource-limit boundary.

## Documentation API

- `ts_type(schema, depth)` produces simplified TypeScript. Start at depth `0`;
  objects with properties become `object` at depth `3`. It is a display type,
  not an exact representation of every validation rule.
- `summary_of(description, max)` selects the bounded first sentence/line,
  including the existing abbreviation and whitespace handling.
- `signature_of(callable, parameters, result_schema, description)` includes the
  call/result types, a summary and parameter-description notes.
- `compact_signature_of(callable, parameters, description)` emits a one-line
  arguments-only signature and summary.
- `fit_signatures(core_blocks, other_blocks, budget)` fits caller-supplied
  `Block { name, block }` values, core first and then others in input order.
  Each block costs its UTF-16 length plus one separator unit. Non-fitting names
  are returned sorted in `Fitted::unlisted`; a large skipped block does not
  prevent a smaller later block from fitting.

The caller supplies the full callable expression (e.g. `api.search`) and chooses
which result fields to document. The crate has no built-in tool routing prefix,
core-capability list, default prompt budget, common-result conventions or
product-specific notes. PTC keeps those policies in its agent-side wrappers.
