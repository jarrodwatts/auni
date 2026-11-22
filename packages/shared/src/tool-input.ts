import { z } from "zod";

type Schema = z.core.$ZodType;

/**
 * A tool's input, with each value the agent sent as text where the schema wants something else
 * read as what the text unmistakably means, before the schema checks it. A model sends
 * `"retired": "true"`, `"amountUsd": "1.5"` or a list as a JSON string often enough that refusing
 * those leaves real work undone. Only these readings are made:
 *
 *   "true" / "false"     where a boolean, or that very literal, is wanted
 *   "1.5", "-2", "40"    where a number, or that very literal, is wanted: a number as JSON
 *                        writes one, with no exponent, read exactly as JSON reads it
 *   '[...]' / '{...}'    where an array, an object or a record is wanted: JSON text of one
 *
 * Anything else is left as it was sent, so the schema refuses it and says why. The schema's own
 * checks (range, decimals, sign, length) then run on the value read, exactly as on a value sent as
 * meant, and the schema the agent is shown is unchanged: JSON Schema doesn't show a preprocess step.
 */
export function textAsMeant<T extends Schema>(schema: T) {
  return z.preprocess((value) => readAsMeant(schema, value), schema);
}

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/** The parts of a zod schema's definition this reads; which are set depends on `type`. */
interface Definition {
  readonly type: string;
  readonly innerType?: Schema;
  readonly getter?: () => Schema;
  readonly in?: Schema;
  readonly out?: Schema;
  readonly values?: readonly unknown[];
  readonly element?: Schema;
  readonly shape?: Readonly<Record<string, Schema>>;
  readonly valueType?: Schema;
  readonly options?: readonly Schema[];
}

function readAsMeant(schema: Schema, value: unknown): unknown {
  const def = schema._zod.def as Definition;
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return readAsMeant(def.innerType!, value);
    case "lazy":
      return readAsMeant(def.getter!(), value);
    case "pipe":
      // A preprocess step takes what the schema after it takes; any other pipe, its first part's.
      return readAsMeant(def.in!._zod.def.type === "transform" ? def.out! : def.in!, value);
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "number":
      return typeof value === "string" && PLAIN_NUMBER.test(value) ? Number(value) : value;
    case "literal": {
      const meant = def.values!.find(
        (literal) =>
          (typeof literal === "boolean" || typeof literal === "number") &&
          JSON.stringify(literal) === value,
      );
      return meant === undefined ? value : meant;
    }
    case "array": {
      const list = jsonText(value, Array.isArray);
      return Array.isArray(list) ? list.map((item) => readAsMeant(def.element!, item)) : list;
    }
    case "object": {
      const object = jsonText(value, isObject);
      if (!isObject(object)) return object;
      const shape = def.shape!;
      return Object.fromEntries(
        Object.entries(object).map(([key, field]) => [
          key,
          Object.hasOwn(shape, key) ? readAsMeant(shape[key]!, field) : field,
        ]),
      );
    }
    case "record": {
      const record = jsonText(value, isObject);
      if (!isObject(record)) return record;
      return Object.fromEntries(
        Object.entries(record).map(([key, field]) => [key, readAsMeant(def.valueType!, field)]),
      );
    }
    case "union":
      return readByUnion(schema, def.options!, value);
    default:
      return value;
  }
}

/**
 * A value one of a union's options takes as it was sent is left alone. Otherwise each option reads
 * it its own way, and a reading is used only when every option that takes a reading agrees on it.
 */
function readByUnion(union: Schema, options: readonly Schema[], value: unknown): unknown {
  if (z.safeParse(union, value).success) return value;
  const taken = options
    .map((option) => ({ option, read: readAsMeant(option, value) }))
    .filter(({ option, read }) => read !== value && z.safeParse(option, read).success)
    .map(({ read }) => read);
  return new Set(taken.map((read) => JSON.stringify(read))).size === 1 ? taken[0] : value;
}

/** What JSON text means when it is JSON text of the kind wanted; anything else as it came. */
function jsonText(value: unknown, wanted: (parsed: unknown) => boolean): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return wanted(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
