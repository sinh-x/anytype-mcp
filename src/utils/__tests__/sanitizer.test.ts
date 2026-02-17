import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, registerSecret, registerSecrets, sanitize } from "../sanitizer";

describe("sanitizer", () => {
  afterEach(() => {
    clearSecrets();
  });

  describe("masking strategy", () => {
    it("masks long secrets (>= 8 chars) showing first 4 and last 4", () => {
      registerSecret("abcd1234efgh");
      const [result] = sanitize("token is abcd1234efgh here");
      expect(result).toBe("token is abcd****efgh here");
    });

    it("fully masks short secrets (< 8 chars)", () => {
      registerSecret("short");
      const [result] = sanitize("secret: short");
      expect(result).toBe("secret: ****");
    });

    it("masks exactly 8 char secrets with partial reveal", () => {
      registerSecret("12345678");
      const [result] = sanitize("key=12345678");
      expect(result).toBe("key=1234****5678");
    });

    it("ignores empty strings", () => {
      registerSecret("");
      const [result] = sanitize("nothing to mask");
      expect(result).toBe("nothing to mask");
    });
  });

  describe("registerSecrets", () => {
    it("registers all values from a headers object", () => {
      registerSecrets({
        Authorization: "Bearer mytoken1234",
        "X-Custom": "secretvalue!",
      });
      const [result] = sanitize("Bearer mytoken1234 and secretvalue!");
      expect(result).toBe("Bear****1234 and secr****lue!");
    });
  });

  describe("sanitize", () => {
    it("passes through primitives when no secrets registered", () => {
      const result = sanitize("hello", 42, true, null, undefined);
      expect(result).toEqual(["hello", 42, true, null, undefined]);
    });

    it("passes through primitives unchanged even with secrets", () => {
      registerSecret("something");
      const result = sanitize(42, true, null, undefined);
      expect(result).toEqual([42, true, null, undefined]);
    });

    it("sanitizes multiple arguments", () => {
      registerSecret("supersecret1");
      const result = sanitize("first supersecret1", "second supersecret1");
      expect(result).toEqual(["first supe****ret1", "second supe****ret1"]);
    });

    it("sanitizes nested objects", () => {
      registerSecret("my-api-key-value");
      const obj = {
        config: {
          headers: {
            Authorization: "Bearer my-api-key-value",
          },
          nested: {
            deep: "contains my-api-key-value inside",
          },
        },
      };
      const [result] = sanitize(obj);
      expect(result).toEqual({
        config: {
          headers: {
            Authorization: "Bearer my-a****alue",
          },
          nested: {
            deep: "contains my-a****alue inside",
          },
        },
      });
    });

    it("sanitizes arrays within objects", () => {
      registerSecret("tokentokentoken");
      const obj = { items: ["tokentokentoken", "safe", "also tokentokentoken"] };
      const [result] = sanitize(obj) as [any];
      expect(result.items).toEqual(["toke****oken", "safe", "also toke****oken"]);
    });

    it("sanitizes Error objects", () => {
      registerSecret("leaked-secret!");
      const error = new Error("Request failed with leaked-secret! in body");
      const [result] = sanitize(error) as [any];
      expect(result.name).toBe("Error");
      expect(result.message).toBe("Request failed with leak****ret! in body");
      expect(result.stack).toBeDefined();
      expect(result.stack).not.toContain("leaked-secret!");
    });

    it("preserves extra properties on Error subclasses", () => {
      registerSecret("errortoken1234");
      class CustomError extends Error {
        data: any;
        constructor(msg: string, data: any) {
          super(msg);
          this.name = "CustomError";
          this.data = data;
        }
      }
      const error = new CustomError("fail with errortoken1234", { detail: "has errortoken1234" });
      const [result] = sanitize(error) as [any];
      expect(result.name).toBe("CustomError");
      expect(result.message).not.toContain("errortoken1234");
      expect(result.data.detail).not.toContain("errortoken1234");
    });

    it("does not mutate original objects", () => {
      registerSecret("donottouchme!");
      const original = { key: "donottouchme!" };
      sanitize(original);
      expect(original.key).toBe("donottouchme!");
    });

    it("handles circular references gracefully", () => {
      registerSecret("circular-secret");
      const obj: any = { a: "circular-secret" };
      obj.self = obj;
      const [result] = sanitize(obj);
      expect(result).toBe("[unserializable]");
    });

    it("handles multiple secrets in the same string", () => {
      registerSecret("firstsecret!");
      registerSecret("secondsecret");
      const [result] = sanitize("has firstsecret! and secondsecret in it");
      expect(result).not.toContain("firstsecret!");
      expect(result).not.toContain("secondsecret");
    });

    it("handles JSON-escaped variants of secrets", () => {
      const secretWithQuote = 'secret"with"quotes';
      registerSecret(secretWithQuote);
      const jsonStr = JSON.stringify({ token: secretWithQuote });
      const [result] = sanitize(jsonStr);
      expect(result).not.toContain(secretWithQuote);
      // Also check the JSON-escaped version is masked
      expect(result).not.toContain('secret\\"with\\"quotes');
    });
  });

  describe("clearSecrets", () => {
    it("removes all registered secrets", () => {
      registerSecret("clearthis123");
      clearSecrets();
      const [result] = sanitize("clearthis123 should remain");
      expect(result).toBe("clearthis123 should remain");
    });
  });
});
