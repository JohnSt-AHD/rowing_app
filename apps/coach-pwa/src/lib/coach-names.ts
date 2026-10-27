/** Split a stored coach field (`Mike` or `Mike, Tom`) into display names. */
export function normalizeCoachName(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function parseCoachNames(value?: string | null): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(/[,;|]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = normalizeCoachName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function coachNamesInclude(
  haystack?: string | null,
  coach?: string | null,
): boolean {
  const want = normalizeCoachName(coach);
  if (!want) return false;
  return parseCoachNames(haystack).some((name) => normalizeCoachName(name) === want);
}
