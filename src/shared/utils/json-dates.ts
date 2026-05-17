/**
 * Date-preserving JSON (de)serialization.
 *
 * A `JSON.stringify`/`JSON.parse` pair that round-trips `Date` objects at
 * arbitrary nesting depth via `{ __date__: <ISO string> }` markers. Pure and
 * DOM-free on purpose: it is the single source of truth for both the web
 * build (`config-store.ts` re-exports it for the Schedule blob and the
 * data-transfer envelopes) and the pure-`src/` Node coverage tests, neither of
 * which should carry a second hand-maintained copy that can silently drift.
 *
 * NOTE: this pair is used only for blobs whose shape has Dates at arbitrary
 * depth (the Schedule blob, export envelopes). The flat, well-known state blob
 * (`saveToStorage`) uses manual `.toISOString()` + plain `JSON.parse`; the two
 * persistence paths are intentionally separate — do not unify without updating
 * both the save and load sides.
 */

/**
 * Deep-serialize dates to ISO strings in a JSON-compatible way.
 * Uses a replacer function so Date objects in nested structures are handled.
 *
 * Strict: an Invalid Date reaches `raw.toISOString()` and throws a RangeError
 * rather than emitting an unparseable marker. This is the symmetric half of
 * `jsonDeserialize`'s rejection contract — the serializer never produces a
 * `{ __date__ }` value the reviver would refuse.
 */
export function jsonSerialize(obj: unknown): string {
  // Must use a regular function (not arrow) so `this` is the holder object.
  // JSON.stringify calls Date.toJSON() *before* the replacer sees the value,
  // so `value` is already a string for Dates.  `this[key]` gives the raw Date.
  return JSON.stringify(obj, function (this: Record<string, unknown>, key, value) {
    const raw = this[key];
    if (raw instanceof Date) {
      return { __date__: raw.toISOString() };
    }
    return value;
  });
}

/**
 * Deep-deserialize ISO date strings back to Date objects.
 * Uses a reviver function that matches the serialization format.
 *
 * The reviver is strict, symmetrically with `jsonSerialize`: that side only
 * ever emits `Date.toISOString()` (always re-parseable) and throws a
 * RangeError if asked to serialize an Invalid Date. So an `{ __date__ }`
 * marker that does NOT parse back to a valid Date cannot have come from this
 * serializer — it is corrupt, hand-edited, or foreign input. Reviving it as
 * an Invalid Date would propagate `getTime() === NaN` straight into engine
 * fields (`Schedule.periodStart`, `Task.timeBlock`), poisoning every day-window
 * / rest / cross-boundary calculation. Worse, an Invalid Date still satisfies
 * `instanceof Date`, so the `hasFrozenFields()` "drop a malformed schedule and
 * regenerate" safety net in app.ts would NOT catch it. We therefore reject the
 * whole blob here: every caller already handles a throw gracefully
 * (`loadSchedule` → null, `_initSnapshots` → [], import paths → plain
 * `JSON.parse` fallback), yielding the same clean "regenerate" UX as a
 * pre-schema schedule rather than a silently corrupt one.
 */
export function jsonDeserialize<T>(json: string): T {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && '__date__' in value) {
      const d = new Date(value.__date__);
      if (Number.isNaN(d.getTime())) {
        throw new RangeError(`jsonDeserialize: unparseable __date__ value ${JSON.stringify(value.__date__)}`);
      }
      return d;
    }
    return value;
  }) as T;
}
