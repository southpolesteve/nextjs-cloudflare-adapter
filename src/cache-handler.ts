/**
 * Cache handler for Next.js ISR on Cloudflare Workers KV.
 *
 * This module implements the CacheHandler interface that Next.js uses
 * for incremental static regeneration (ISR) and data caching.
 *
 * Note: This is a placeholder that uses in-memory caching for now.
 * A full implementation would use KV or R2, but requires the Cloudflare
 * context to be available at runtime (via AsyncLocalStorage).
 *
 * For the initial version, we rely on Next.js's default filesystem-based
 * caching which works with the standalone output mode.
 */

// For the initial implementation, we export nothing special.
// Next.js will use its default file-based cache handler, which works
// correctly in the standalone output since .next is bundled.
//
// TODO: Implement KV-based cache handler for production:
// - get(key): read from KV
// - set(key, data, context): write to KV with TTL
// - revalidateTag(tags): purge by tag
//
// The challenge is accessing the KV binding from within the cache handler,
// since it runs inside Next.js internals without direct access to the
// Worker's env. OpenNext solves this with AsyncLocalStorage to pass
// the Cloudflare context through.

export default class CloudflareCacheHandler {
  private cache: Map<
    string,
    { value: any; lastModified: number; tags: string[] }
  > = new Map();

  async get(
    key: string
  ): Promise<{ value: any; lastModified: number } | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    return { value: entry.value, lastModified: entry.lastModified };
  }

  async set(key: string, data: any, ctx?: { tags?: string[] }): Promise<void> {
    this.cache.set(key, {
      value: data,
      lastModified: Date.now(),
      tags: ctx?.tags ?? [],
    });
  }

  async revalidateTag(tags: string | string[]): Promise<void> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const tagSet = new Set(tagList);
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.some((t) => tagSet.has(t))) {
        this.cache.delete(key);
      }
    }
  }

  resetRequestCache(): void {
    // No-op for now
  }
}
