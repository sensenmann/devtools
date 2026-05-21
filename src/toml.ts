type TomlValue = string | number | boolean | string[] | number[] | boolean[] | Record<string, unknown>;

export function parseSimpleToml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const sectionName = line.slice(1, -1).trim();
      const parts = sectionName.split(".");
      current = root;
      for (const part of parts) {
        const next = (current[part] as Record<string, unknown> | undefined) ?? {};
        current[part] = next;
        current = next;
      }
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const rawValue = line.slice(index + 1).trim();
    current[key] = parseValue(rawValue);
  }

  return root;
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitArray(inner).map((item) => parseValue(item)) as string[] | number[] | boolean[];
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  const numberValue = Number(raw);
  if (!Number.isNaN(numberValue)) {
    return numberValue;
  }
  return raw;
}

function splitArray(input: string): string[] {
  const values: string[] = [];
  let buffer = "";
  let inString = false;
  let quote = "";
  for (const char of input) {
    if ((char === '"' || char === "'") && (!inString || quote === char)) {
      if (!inString) {
        inString = true;
        quote = char;
      } else {
        inString = false;
        quote = "";
      }
      buffer += char;
      continue;
    }
    if (char === "," && !inString) {
      values.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) {
    values.push(buffer.trim());
  }
  return values;
}
