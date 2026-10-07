/**
 * Execution-time validation of capability arguments against the JSON schema
 * subset the tool definitions use (type, properties, required,
 * additionalProperties, enum, items, numeric and length bounds, pattern).
 * Unknown keywords are ignored; a schema this cannot interpret never turns an
 * invalid value into a valid one, because every listed keyword is checked.
 */
type Schema = Record<string, unknown>;

const MAX_ERRORS = 8;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function check(value: unknown, schema: Schema, at: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return;
  // Alternatives (result schemas of action-dependent capabilities): exactly one must match.
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const matching = branches.filter((branch) => {
      const inner: string[] = [];
      check(value, branch as Schema, at, inner);
      return inner.length === 0;
    }).length;
    if (keyword === 'oneOf' ? matching !== 1 : matching === 0) {
      errors.push(`${at || 'value'} matches ${matching} of the ${keyword} alternatives`);
      return;
    }
  }
  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : typeof schema.type === 'string'
      ? [schema.type]
      : undefined;
  if (types && !types.some((type) => matchesType(value, type))) {
    errors.push(`${at || 'arguments'} must be ${types.join(' or ')}, got ${typeOf(value)}`);
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push(`${at} must be a finite number`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${at || 'arguments'} must be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
    return;
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    errors.push(`${at} must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength)
      errors.push(`${at} must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength)
      errors.push(`${at} must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      let pattern: RegExp | undefined;
      try {
        pattern = new RegExp(schema.pattern, 'u');
      } catch {
        pattern = undefined;
      }
      if (!pattern) errors.push(`${at} has an unusable pattern in its schema`);
      else if (!pattern.test(value)) errors.push(`${at} must match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${at} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      errors.push(`${at} must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      errors.push(`${at} must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
      errors.push(`${at} must be < ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${at} must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      errors.push(`${at} must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object')
      value.forEach((item, index) =>
        check(item, schema.items as Schema, `${at}[${index}]`, errors),
      );
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required))
      for (const key of schema.required as string[])
        if (!Object.hasOwn(record, key) || record[key] === undefined)
          errors.push(`${at ? `${at}.` : ''}${key} is required`);
    for (const [key, item] of Object.entries(record)) {
      const path = at ? `${at}.${key}` : key;
      if (Object.hasOwn(properties, key)) check(item, properties[key]!, path, errors);
      else if (schema.additionalProperties === false) errors.push(`${path} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        check(item, schema.additionalProperties as Schema, path, errors);
    }
  }
}

/** Errors for `value` against `schema`; empty when valid. */
export function validateSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  check(value, schema, '', errors);
  return errors;
}
