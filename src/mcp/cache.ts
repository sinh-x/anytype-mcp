import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface CachedObject {
  spaceId: string;
  objectId: string;
  data: Record<string, unknown>;
  sizeBytes: number;
  cachedAt: number;
  lastModifiedDate: string | undefined;
}

export interface ObjectSummary {
  object_id: string;
  name: string;
  type: string | null;
  layout: string | null;
  snippet: string | null;
  icon: unknown;
  size_bytes: number;
  cached_at: string;
  last_modified_date: string | null;
  properties_count: number;
  has_body: boolean;
}

export interface CacheStats {
  entry_count: number;
  total_size_bytes: number;
  entries: Array<{
    space_id: string;
    object_id: string;
    name: string;
    size_bytes: number;
    cached_at: string;
    last_modified_date: string | null;
  }>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const CACHE_STATS_TOOL_NAME = "API-cache-stats";
export const GET_CACHED_CONTENT_TOOL_NAME = "API-get-cached-content";

export const CACHE_STATS_TOOL: Tool = {
  name: CACHE_STATS_TOOL_NAME,
  description:
    "Returns statistics about the object cache: entry count, total size, and a list of cached objects with their sizes. " +
    "Use this to understand what objects are cached and their sizes before fetching full content.",
  inputSchema: {
    type: "object",
    properties: {
      space_id: {
        type: "string",
        description: "Optional: filter stats to a specific space",
      },
    },
    required: [],
  },
};

export const GET_CACHED_CONTENT_TOOL: Tool = {
  name: GET_CACHED_CONTENT_TOOL_NAME,
  description:
    "Retrieve the full content of a cached object without making an API call. " +
    "Objects are cached after get-object or batch-get-objects calls. " +
    "Returns the complete object data including markdown body. " +
    "Use API-cache-stats to see what's available.",
  inputSchema: {
    type: "object",
    properties: {
      space_id: {
        type: "string",
        description: "The space ID containing the object",
      },
      object_id: {
        type: "string",
        description: "The object ID to retrieve from cache",
      },
    },
    required: ["space_id", "object_id"],
  },
};

export class ObjectCacheManager {
  private cache = new Map<string, CachedObject>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private key(spaceId: string, objectId: string): string {
    return `${spaceId}:${objectId}`;
  }

  /**
   * Store an object in the cache, extracting last_modified_date for staleness tracking.
   */
  set(spaceId: string, objectId: string, data: Record<string, unknown>): void {
    const serialized = JSON.stringify(data);
    const lastModifiedDate = this.extractLastModifiedDate(data);

    this.cache.set(this.key(spaceId, objectId), {
      spaceId,
      objectId,
      data,
      sizeBytes: Buffer.byteLength(serialized, "utf-8"),
      cachedAt: Date.now(),
      lastModifiedDate,
    });
  }

  /**
   * Get a cached object if it exists and is still fresh.
   * Returns undefined if not cached, expired (TTL), or stale (newer lastModifiedDate known).
   */
  get(spaceId: string, objectId: string, knownLastModified?: string): CachedObject | undefined {
    const entry = this.cache.get(this.key(spaceId, objectId));
    if (!entry) return undefined;

    // TTL check
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(this.key(spaceId, objectId));
      return undefined;
    }

    // Staleness check: if we know a newer timestamp, invalidate
    if (knownLastModified && entry.lastModifiedDate && knownLastModified > entry.lastModifiedDate) {
      this.cache.delete(this.key(spaceId, objectId));
      return undefined;
    }

    return entry;
  }

  /**
   * Invalidate a specific cache entry (e.g. after update/delete).
   */
  invalidate(spaceId: string, objectId: string): void {
    this.cache.delete(this.key(spaceId, objectId));
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Build a summary of a cached object (metadata only, no body content).
   */
  buildSummary(entry: CachedObject): ObjectSummary {
    const obj = entry.data?.object ? (entry.data.object as Record<string, unknown>) : entry.data;
    const properties = (obj?.properties as Array<Record<string, unknown>>) ?? [];

    return {
      object_id: entry.objectId,
      name: (obj?.name as string) ?? "",
      type: this.extractTypeName(obj),
      layout: (obj?.layout as string) ?? null,
      snippet: (obj?.snippet as string) ?? null,
      icon: obj?.icon ?? null,
      size_bytes: entry.sizeBytes,
      cached_at: new Date(entry.cachedAt).toISOString(),
      last_modified_date: entry.lastModifiedDate ?? null,
      properties_count: properties.length,
      has_body: !!(obj?.markdown || obj?.body),
    };
  }

  /**
   * Return cache statistics, optionally filtered by space.
   */
  getStats(spaceId?: string): CacheStats {
    const entries: CacheStats["entries"] = [];
    let totalSize = 0;

    for (const entry of this.cache.values()) {
      if (spaceId && entry.spaceId !== spaceId) continue;
      const obj = entry.data?.object ? (entry.data.object as Record<string, unknown>) : entry.data;
      entries.push({
        space_id: entry.spaceId,
        object_id: entry.objectId,
        name: (obj?.name as string) ?? "",
        size_bytes: entry.sizeBytes,
        cached_at: new Date(entry.cachedAt).toISOString(),
        last_modified_date: entry.lastModifiedDate ?? null,
      });
      totalSize += entry.sizeBytes;
    }

    return {
      entry_count: entries.length,
      total_size_bytes: totalSize,
      entries,
    };
  }

  /**
   * Check search results for objects that have a newer last_modified_date than cached.
   * Invalidates stale entries.
   */
  invalidateStaleFromSearch(spaceId: string, searchResults: Array<Record<string, unknown>>): number {
    let invalidated = 0;
    for (const result of searchResults) {
      const objectId = result.id as string | undefined;
      if (!objectId) continue;

      const lastModified = this.extractLastModifiedDate(result);
      if (!lastModified) continue;

      const entry = this.cache.get(this.key(spaceId, objectId));
      if (entry?.lastModifiedDate && lastModified > entry.lastModifiedDate) {
        this.cache.delete(this.key(spaceId, objectId));
        invalidated++;
      }
    }
    return invalidated;
  }

  private extractLastModifiedDate(data: Record<string, unknown>): string | undefined {
    // Try nested object.properties first (ObjectResponse wraps in { object: ... })
    const obj = data?.object ? (data.object as Record<string, unknown>) : data;
    const properties = (obj?.properties as Array<Record<string, unknown>>) ?? [];

    for (const prop of properties) {
      if (prop.key === "last_modified_date" || prop.key === "lastModifiedDate") {
        return (prop.date as string) ?? (prop.value as string) ?? undefined;
      }
    }

    // Fallback: direct field
    return (obj?.last_modified_date as string) ?? undefined;
  }

  private extractTypeName(obj: Record<string, unknown> | undefined): string | null {
    if (!obj?.type) return null;
    const type = obj.type as Record<string, unknown>;
    return (type.name as string) ?? (type.key as string) ?? null;
  }
}
