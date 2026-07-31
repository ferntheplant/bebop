// Reading values back out of Postgres.
//
// Two driver behaviours are load-bearing here and were both pinned down by
// `prototypes/persistence`:
//
// - `bigint` columns come back as JavaScript **strings** (PG5). `node-postgres` refuses to
//   narrow `int8` to a double, which is why no digits are lost. Any schema written as
//   `Schema.Number` against a sequence, cursor, or acknowledgement offset would therefore
//   fail to decode the moment a real value existed.
// - `jsonb` preserves values but not key order (PG4b), so nothing may be re-serialised from
//   a `jsonb` read and compared byte-for-byte with what arrived on the wire.

import type { Timestamp } from "@bebop/contracts";

import { timestampFrom } from "#src/domain/identity.ts";

export class RowDecodeError extends Error {
  readonly _tag = "RowDecodeError";

  constructor(
    readonly column: string,
    readonly received: unknown,
    reason: string,
  ) {
    super(`Could not decode column "${column}": ${reason}.`);
    this.name = "RowDecodeError";
  }
}

export type Row = Readonly<Record<string, unknown>>;

export function requiredColumn(row: Row, column: string): unknown {
  const value = row[column];
  if (value === undefined || value === null) {
    throw new RowDecodeError(column, value, "expected a value");
  }
  return value;
}

export function text(row: Row, column: string): string {
  const value = requiredColumn(row, column);
  if (typeof value !== "string") {
    throw new RowDecodeError(column, value, "expected text");
  }
  return value;
}

export function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RowDecodeError(column, value, "expected text or null");
  }
  return value;
}

/**
 * A `bigint` column as a safe JavaScript integer.
 *
 * The string form is accepted because that is what the driver returns; the number form is
 * accepted because `integer` columns and `count(*)` results come back as numbers. Anything
 * past `Number.MAX_SAFE_INTEGER` is rejected rather than silently rounded — a sequence
 * number that has quietly lost its last digit is worse than a failed read.
 */
export function bigintNumber(row: Row, column: string): number {
  const value = requiredColumn(row, column);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RowDecodeError(column, value, "expected a safe integer");
    }
    return value;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new RowDecodeError(column, value, "expected an integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RowDecodeError(column, value, "expected a value within the safe integer range");
  }
  return parsed;
}

export function integer(row: Row, column: string): number {
  return bigintNumber(row, column);
}

export function timestamp(row: Row, column: string): Timestamp {
  const value = requiredColumn(row, column);
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new RowDecodeError(column, value, "expected a timestamp");
  }
  return timestampFrom(value);
}

export function optionalTimestamp(row: Row, column: string): Timestamp | undefined {
  return row[column] === undefined || row[column] === null ? undefined : timestamp(row, column);
}

export function json(row: Row, column: string): unknown {
  return requiredColumn(row, column);
}

/**
 * A value bound for a `jsonb` column.
 *
 * Every `jsonb` write goes through this and an explicit `::jsonb` cast rather than through
 * the driver's own `sql.json` helper, because that helper mis-handles a JSON **array**: the
 * driver encodes a JavaScript array as a Postgres array literal, and Postgres then rejects
 * it with `invalid input syntax for type json`. Objects happen to survive, which is exactly
 * what makes the bug easy to ship — `primary_context` and the preview list are arrays, and
 * nothing else would have noticed.
 */
export function jsonbParameter(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function boolean(row: Row, column: string): boolean {
  const value = requiredColumn(row, column);
  if (typeof value !== "boolean") {
    throw new RowDecodeError(column, value, "expected a boolean");
  }
  return value;
}

export function oneOf<const Values extends ReadonlyArray<string>>(
  row: Row,
  column: string,
  values: Values,
): Values[number] {
  const value = text(row, column);
  if (!values.includes(value)) {
    throw new RowDecodeError(column, value, `expected one of ${values.join(", ")}`);
  }
  return value;
}
