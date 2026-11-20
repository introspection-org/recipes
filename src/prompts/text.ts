/** The first `units` UTF-16 units of `value`, never splitting a surrogate pair. */
export function prefix(value: string, units: number): string {
  const end =
    units > 0 && /[\uD800-\uDBFF]/.test(value[units - 1] ?? "")
      ? units - 1
      : units;
  return value.slice(0, end);
}

/** The last `units` UTF-16 units of `value`, never splitting a surrogate pair. */
export function suffix(value: string, units: number): string {
  const start = value.length - units;
  return value.slice(
    /[\uDC00-\uDFFF]/.test(value[start] ?? "") ? start + 1 : start,
  );
}
