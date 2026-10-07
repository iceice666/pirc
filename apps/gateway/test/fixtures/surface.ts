/** The provider-facing tools of the hybrid surface: `ptc`, `ptc_docs`, then direct core ones. */
export const CODING_DIRECT = ['read', 'write', 'edit', 'ls', 'grep', 'find', 'bash'] as const;
export const surface = (...direct: string[]) => ['ptc', 'ptc_docs', ...direct];
/** A coding session without a gateway or browser. */
export const CODING_SURFACE = surface(...CODING_DIRECT);
/** A session with a gateway (web_search) but no browser. */
export const GATEWAY_SURFACE = surface(...CODING_DIRECT, 'web_search');
