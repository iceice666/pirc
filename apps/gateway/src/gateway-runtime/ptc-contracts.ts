import { z } from 'zod';
import { BUDGETS, WRAPPER_NAMES } from '../agent/ptc/contracts.js';
import { preflight } from '../agent/ptc/preflight.js';
import { capabilityMetadata } from '../environment/catalog.js';
import { canonicalJson, parseJson } from '../environment/json.js';
import {
  descriptorSchema,
  DESCRIPTOR_BYTES,
  REQUEST_BYTES,
  textMemo,
  type Descriptor,
} from '../environment/protocol.js';

export const ptcArgumentsSchema = z
  .object({
    code: z.string().min(1),
    timeout: z
      .number()
      .finite()
      .positive()
      .max(BUDGETS.maxActiveTimeoutMs / 1000)
      .optional(),
  })
  .strict();

export interface PtcPlan {
  placement: 'node' | 'gateway';
  manifest: string[];
  /** Shipped preflight output; never accept compiled code supplied by a remote guest. */
  js: string;
  timeoutMs: number;
}

const plans = textMemo<PtcPlan>(8 * 1024 * 1024, DESCRIPTOR_BYTES + 64 * 1024);
/** Static placement is metadata, not an execution grant. Every inner call is authorized again. */
export function planPtc(args: unknown, catalog: Descriptor['capabilityCatalog']): PtcPlan {
  // Pure in (arguments, catalog); the same script is planned at dispatch, polling and commit.
  let key: string;
  try {
    key = `${canonicalJson(args, REQUEST_BYTES)}\n${canonicalJson(catalog, DESCRIPTOR_BYTES)}`;
  } catch {
    return computePlan(args, catalog);
  }
  return plans(key, () => computePlan(args, catalog));
}
function computePlan(args: unknown, catalog: Descriptor['capabilityCatalog']): PtcPlan {
  canonicalJson(args, REQUEST_BYTES);
  const input = ptcArgumentsSchema.parse(args);
  const entries = descriptorSchema.innerType().shape.capabilityCatalog.parse(catalog);
  const available = new Map(entries.map((entry) => [entry.name, entry]));
  if (available.size !== entries.length) throw new Error('Duplicate PTC capability');
  // Validate the complete trusted catalog, including entries not used by this script.
  // A descriptor cannot move an environment operation onto the gateway.
  for (const entry of entries) {
    const metadata = capabilityMetadata(entry.name);
    for (const key of ['placement', 'effects', 'concurrency', 'approval'] as const)
      if (entry[key] !== metadata[key])
        throw new Error(`Conflicting capability metadata: ${entry.name}`);
  }
  const compiled = preflight(input.code);
  let placement: PtcPlan['placement'] = 'gateway';
  for (const name of compiled.manifest) {
    const entry = available.get(name);
    if (WRAPPER_NAMES.has(name) || !entry) throw new Error(`PTC capability unavailable: ${name}`);
    if (entry.placement === 'node') placement = 'node';
  }
  return {
    ...compiled,
    placement,
    timeoutMs: input.timeout === undefined ? 120_000 : Math.ceil(input.timeout * 1000),
  };
}

export interface PtcStoreSnapshot {
  branchId: string;
  revision: string;
  store: string;
  untrusted: string[];
}

/** Reject damaged stores rather than silently losing durable data; budgets are characters. */
export function validatePtcStore(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > BUDGETS.storeTotalChars + 2)
    throw new Error('Invalid PTC store size');
  const value = parseJson(raw, REQUEST_BYTES);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid PTC store object');
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 200 || JSON.stringify(item).length > BUDGETS.storeValueChars)
      throw new Error('Invalid PTC store value');
  }
  const encoded = canonicalJson(value, REQUEST_BYTES);
  if (encoded.length > BUDGETS.storeTotalChars + 2) throw new Error('Invalid PTC store size');
  return encoded;
}

export function validatePtcProvenance(value: unknown): string[] {
  const names = z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .max(64)
    .parse(value);
  return [...new Set(names)].sort();
}
