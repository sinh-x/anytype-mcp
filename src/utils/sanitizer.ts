/**
 * Log sanitizer that auto-masks registered secrets in log output.
 */

const secrets = new Map<string, string>();

function maskValue(value: string): string {
  if (value.length >= 8) {
    return value.slice(0, 4) + "****" + value.slice(-4);
  }
  return "****";
}

export function registerSecret(value: string): void {
  if (!value) return;
  const masked = maskValue(value);
  secrets.set(value, masked);
  // Also register JSON-escaped variant for secrets inside JSON.stringify output
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    secrets.set(jsonEscaped, masked);
  }
}

export function registerSecrets(headers: Record<string, string>): void {
  for (const value of Object.values(headers)) {
    if (typeof value === "string") {
      registerSecret(value);
    }
  }
}

export function clearSecrets(): void {
  secrets.clear();
}

function sanitizeString(str: string): string {
  let result = str;
  for (const [raw, masked] of secrets) {
    if (result.includes(raw)) {
      result = result.split(raw).join(masked);
    }
  }
  return result;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Error) {
    const sanitized: Record<string, unknown> = {
      name: value.name,
      message: sanitizeString(value.message),
    };
    if (value.stack) {
      sanitized.stack = sanitizeString(value.stack);
    }
    // Preserve extra properties (e.g. HttpClientError.data)
    for (const key of Object.keys(value)) {
      if (!(key in sanitized)) {
        sanitized[key] = sanitizeValue((value as any)[key]);
      }
    }
    return sanitized;
  }

  // Objects and arrays: JSON round-trip for safe deep copy + sanitization
  try {
    const json = JSON.stringify(value);
    const sanitizedJson = sanitizeString(json);
    return JSON.parse(sanitizedJson);
  } catch {
    // Circular refs or other serialization failures — return placeholder
    return "[unserializable]";
  }
}

export function sanitize(...args: unknown[]): unknown[] {
  if (secrets.size === 0) return args;
  return args.map(sanitizeValue);
}
