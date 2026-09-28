/** A caught error's message for the UI, or `fallback` for anything that is not an Error. */
export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;
