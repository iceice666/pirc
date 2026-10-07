/**
 * Helpers for `Tool.resultSchema`: the typed fields a capability's result
 * carries for `ptc` scripts, besides `text` and `images` (added by the
 * registry, ptc/registry.ts `resultSchemaOf`). The shapes stay small: they
 * are documentation the model reads through `ptc_docs`.
 */
type Schema = Record<string, unknown>;

const described = (schema: Schema, description?: string): Schema =>
  description ? { ...schema, description } : schema;

export const str = (description?: string): Schema => described({ type: 'string' }, description);
export const int = (description?: string): Schema => described({ type: 'integer' }, description);
export const num = (description?: string): Schema => described({ type: 'number' }, description);
export const bool = (description?: string): Schema => described({ type: 'boolean' }, description);
export const arr = (items: Schema, description?: string): Schema =>
  described({ type: 'array', items }, description);
export const literal = (value: string): Schema => ({ const: value });
export const oneOfStrings = (values: string[], description?: string): Schema =>
  described({ type: 'string', enum: values }, description);
/** `schema` or null. */
export const nullable = (schema: Schema): Schema => ({
  ...schema,
  type: [schema.type as string, 'null'],
});
/** Any JSON value (a record whose shape belongs to another service). */
export const json = (description?: string): Schema => described({}, description);

/** A closed object; every property is required unless listed in `optional`. */
export function obj(properties: Record<string, Schema>, optional: string[] = []): Schema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  };
}

/**
 * A record another component owns and may extend (team events, agents):
 * the listed fields are documented, others may appear.
 */
export function record(properties: Record<string, Schema>, optional: string[] = []): Schema {
  return { ...obj(properties, optional), additionalProperties: true };
}

/** A capability result with these fields (`text`/`images` are added by the registry). */
export const fields = (properties: Record<string, Schema>, optional: string[] = []) =>
  obj(properties, optional);

/**
 * Results of an action-dependent capability: one alternative per action,
 * each with `action` set to that action.
 */
export function byAction(
  actions: Record<string, { properties?: Record<string, Schema>; optional?: string[] }>,
): Schema {
  return {
    oneOf: Object.entries(actions).map(([action, spec]) =>
      obj({ action: literal(action), ...spec.properties }, spec.optional),
    ),
  };
}
