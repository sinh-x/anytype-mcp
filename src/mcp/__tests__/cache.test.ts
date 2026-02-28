import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectCacheManager } from "../cache";

describe("ObjectCacheManager", () => {
  let cache: ObjectCacheManager;

  const makeObjectResponse = (overrides?: Record<string, unknown>) => ({
    object: {
      id: "obj-1",
      name: "Test Object",
      type: { key: "page", name: "Page" },
      layout: "basic",
      snippet: "A short preview...",
      markdown: "# Full content\n\nLots of text here...",
      icon: { format: "emoji", emoji: "📄" },
      properties: [
        { key: "last_modified_date", name: "Last modified date", format: "date", date: "2025-06-01T12:00:00Z" },
        { key: "description", name: "Description", format: "text", text: "Some description" },
      ],
      ...overrides,
    },
  });

  beforeEach(() => {
    cache = new ObjectCacheManager(5 * 60 * 1000); // 5 min TTL
  });

  describe("set and get", () => {
    it("should store and retrieve an object", () => {
      const data = makeObjectResponse();
      cache.set("space-1", "obj-1", data);

      const entry = cache.get("space-1", "obj-1");
      expect(entry).toBeDefined();
      expect(entry!.data).toEqual(data);
      expect(entry!.spaceId).toBe("space-1");
      expect(entry!.objectId).toBe("obj-1");
      expect(entry!.sizeBytes).toBeGreaterThan(0);
      expect(entry!.lastModifiedDate).toBe("2025-06-01T12:00:00Z");
    });

    it("should return undefined for non-existent entry", () => {
      expect(cache.get("space-1", "no-exist")).toBeUndefined();
    });

    it("should overwrite existing entry", () => {
      cache.set("space-1", "obj-1", makeObjectResponse({ name: "First" }));
      cache.set("space-1", "obj-1", makeObjectResponse({ name: "Second" }));

      const entry = cache.get("space-1", "obj-1");
      expect((entry!.data.object as Record<string, unknown>).name).toBe("Second");
    });
  });

  describe("TTL expiration", () => {
    it("should return undefined for expired entries", () => {
      cache = new ObjectCacheManager(100); // 100ms TTL
      cache.set("space-1", "obj-1", makeObjectResponse());

      vi.useFakeTimers();
      vi.advanceTimersByTime(150);

      expect(cache.get("space-1", "obj-1")).toBeUndefined();
      vi.useRealTimers();
    });

    it("should return entry within TTL", () => {
      cache = new ObjectCacheManager(1000);
      cache.set("space-1", "obj-1", makeObjectResponse());

      vi.useFakeTimers();
      vi.advanceTimersByTime(500);

      expect(cache.get("space-1", "obj-1")).toBeDefined();
      vi.useRealTimers();
    });
  });

  describe("staleness check via knownLastModified", () => {
    it("should invalidate entry when knownLastModified is newer", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());

      // Cached last_modified_date is 2025-06-01
      const entry = cache.get("space-1", "obj-1", "2025-06-02T00:00:00Z");
      expect(entry).toBeUndefined();

      // Entry should be removed
      expect(cache.get("space-1", "obj-1")).toBeUndefined();
    });

    it("should return entry when knownLastModified is same or older", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());

      expect(cache.get("space-1", "obj-1", "2025-06-01T12:00:00Z")).toBeDefined();
      expect(cache.get("space-1", "obj-1", "2025-05-01T00:00:00Z")).toBeDefined();
    });
  });

  describe("invalidate", () => {
    it("should remove a specific entry", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());
      cache.set("space-1", "obj-2", makeObjectResponse({ name: "Other" }));

      cache.invalidate("space-1", "obj-1");

      expect(cache.get("space-1", "obj-1")).toBeUndefined();
      expect(cache.get("space-1", "obj-2")).toBeDefined();
    });

    it("should be a no-op for non-existent entries", () => {
      expect(() => cache.invalidate("space-1", "no-exist")).not.toThrow();
    });
  });

  describe("clear", () => {
    it("should remove all entries", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());
      cache.set("space-2", "obj-2", makeObjectResponse());

      cache.clear();

      expect(cache.get("space-1", "obj-1")).toBeUndefined();
      expect(cache.get("space-2", "obj-2")).toBeUndefined();
    });
  });

  describe("buildSummary", () => {
    it("should return a summary with metadata and no body", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());
      const entry = cache.get("space-1", "obj-1")!;
      const summary = cache.buildSummary(entry);

      expect(summary.object_id).toBe("obj-1");
      expect(summary.name).toBe("Test Object");
      expect(summary.type).toBe("Page");
      expect(summary.layout).toBe("basic");
      expect(summary.snippet).toBe("A short preview...");
      expect(summary.icon).toEqual({ format: "emoji", emoji: "📄" });
      expect(summary.size_bytes).toBeGreaterThan(0);
      expect(summary.last_modified_date).toBe("2025-06-01T12:00:00Z");
      expect(summary.properties_count).toBe(2);
      expect(summary.has_body).toBe(true);
      expect(summary).not.toHaveProperty("markdown");
      expect(summary).not.toHaveProperty("body");
    });

    it("should handle objects without a body", () => {
      cache.set("space-1", "obj-1", makeObjectResponse({ markdown: undefined }));
      const entry = cache.get("space-1", "obj-1")!;
      const summary = cache.buildSummary(entry);

      expect(summary.has_body).toBe(false);
    });
  });

  describe("getStats", () => {
    it("should return stats for all entries", () => {
      cache.set("space-1", "obj-1", makeObjectResponse({ name: "First" }));
      cache.set("space-2", "obj-2", makeObjectResponse({ name: "Second" }));

      const stats = cache.getStats();

      expect(stats.entry_count).toBe(2);
      expect(stats.total_size_bytes).toBeGreaterThan(0);
      expect(stats.entries).toHaveLength(2);
    });

    it("should filter by space_id", () => {
      cache.set("space-1", "obj-1", makeObjectResponse({ name: "First" }));
      cache.set("space-2", "obj-2", makeObjectResponse({ name: "Second" }));

      const stats = cache.getStats("space-1");

      expect(stats.entry_count).toBe(1);
      expect(stats.entries[0].space_id).toBe("space-1");
    });

    it("should return empty stats for empty cache", () => {
      const stats = cache.getStats();

      expect(stats.entry_count).toBe(0);
      expect(stats.total_size_bytes).toBe(0);
      expect(stats.entries).toHaveLength(0);
    });
  });

  describe("invalidateStaleFromSearch", () => {
    it("should invalidate entries with older last_modified_date", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());

      const searchResults = [
        {
          id: "obj-1",
          properties: [{ key: "last_modified_date", date: "2025-07-01T00:00:00Z" }],
        },
      ];

      const count = cache.invalidateStaleFromSearch("space-1", searchResults);

      expect(count).toBe(1);
      expect(cache.get("space-1", "obj-1")).toBeUndefined();
    });

    it("should not invalidate entries with same or older search timestamp", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());

      const searchResults = [
        {
          id: "obj-1",
          properties: [{ key: "last_modified_date", date: "2025-05-01T00:00:00Z" }],
        },
      ];

      const count = cache.invalidateStaleFromSearch("space-1", searchResults);

      expect(count).toBe(0);
      expect(cache.get("space-1", "obj-1")).toBeDefined();
    });

    it("should skip results without id", () => {
      cache.set("space-1", "obj-1", makeObjectResponse());

      const count = cache.invalidateStaleFromSearch("space-1", [{ name: "no-id" }]);
      expect(count).toBe(0);
    });
  });
});
