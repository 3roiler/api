export const tryParseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const toUrlOrNull = (value: string | undefined): URL | null => {
  if (!value) {
    return null;
  }

  const direct = tryParseUrl(value);

  if (direct) {
    return direct;
  }

  if (/^[a-z]+:\/\//i.test(value)) {
    return null;
  }

  return tryParseUrl(`https://${value}`);
};

export const toOriginOrUndefined = (value: string | undefined): string | undefined => {
  const parsed = toUrlOrNull(value);
  return parsed?.origin;
};

export const parseOriginList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  const entries = value
    .split(/[ ,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => toOriginOrUndefined(entry))
    .filter((origin): origin is string => typeof origin === 'string');

  return Array.from(new Set(entries));
};
