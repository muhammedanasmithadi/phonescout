let instance: Deno.Kv | null = null;
let unavailable = false;

/**
 * The single infra edge for the process-wide KV store. Returns null when
 * the runtime has no KV (tests, restricted sandboxes); callers degrade to
 * no-history behaviour instead of crashing.
 */
export async function defaultKv(): Promise<Deno.Kv | null> {
  if (unavailable) return null;
  if (instance) return instance;
  try {
    instance = await Deno.openKv();
    return instance;
  } catch {
    unavailable = true;
    return null;
  }
}
