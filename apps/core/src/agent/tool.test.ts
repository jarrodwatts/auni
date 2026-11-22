import { AUNI_TOOL_NAMES, textAsMeant } from "@auni/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { sources } from "../apps/registry.ts";
import type { ThreadRow } from "../db/schema.ts";
import { sayInputErrorsPlainly } from "./input-errors.ts";
import { toolsFor } from "./mcp.ts";
import { toolInput } from "./tool.ts";

type Schema = z.core.$ZodType;
type Path = readonly (string | number)[];
type Kind = "boolean" | "number" | "literal" | "array" | "object" | "record";

/** A field of a tool's input whose value the agent might send as text. */
interface Field {
  readonly path: Path;
  readonly kind: Kind;
  readonly schema: Schema;
}

/**
 * Every boolean, number, literal true or number, array, object and record field, at any depth.
 * A union's forms each fit only a whole value, so each form is its own input (`forms`).
 */
function fieldsOf(schema: Schema, forms: Schema[], path: Path = []): Field[] {
  const def = schema._zod.def as unknown as Record<string, Schema> & { type: string };
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return fieldsOf(def.innerType!, forms, path);
    case "pipe":
      return fieldsOf(def.in!._zod.def.type === "transform" ? def.out! : def.in!, forms, path);
    case "union":
      forms.push(...(def.options as unknown as Schema[]));
      return [];
    case "boolean":
    case "number":
      return [{ path, kind: def.type, schema }];
    case "literal":
      return (def.values as unknown as unknown[]).some((value) => typeof value !== "string")
        ? [{ path, kind: "literal", schema }]
        : [];
    case "array":
      return [{ path, kind: "array", schema }, ...fieldsOf(def.element!, forms, [...path, 0])];
    case "object": {
      const shape = def.shape as unknown as Record<string, Schema>;
      const inner = Object.entries(shape).flatMap(([key, field]) =>
        fieldsOf(field, forms, [...path, key]),
      );
      return path.length === 0 ? inner : [{ path, kind: "object", schema }, ...inner];
    }
    case "record":
      return [
        { path, kind: "record", schema },
        ...fieldsOf(def.valueType!, forms, [...path, "key"]),
      ];
    default:
      return [];
  }
}

/** Each field of an input and of every form of a union in it, with the schema that reads it. */
function rowsOf(
  name: string,
  schema: Schema,
): { name: string; at: string; field: Field; schema: Schema }[] {
  const forms: Schema[] = [];
  const fields = fieldsOf(schema, forms).map((field) => ({
    name,
    at: named(field.path),
    field,
    schema,
  }));
  return [
    ...fields,
    ...forms.flatMap((form, index) => rowsOf(`${name}, form ${index + 1}`, textAsMeant(form))),
  ];
}

/** Each value as text and as the value it means; the schema must treat the two alike. */
function readings(field: Field): [string, unknown][] {
  switch (field.kind) {
    case "boolean":
      return [
        ["true", true],
        ["false", false],
      ];
    case "number":
      return [
        ["1", 1],
        ["0.5", 0.5],
        ["-2", -2],
        ["40", 40],
        ["0.000001", 0.000001],
      ];
    case "literal": {
      const values = (field.schema._zod.def as unknown as { values: unknown[] }).values;
      return values
        .filter((value) => typeof value !== "string")
        .map((value) => [JSON.stringify(value), value]);
    }
    case "array":
      return [
        ["[]", []],
        ["[{}]", [{}]],
      ];
    case "object":
    case "record":
      return [["{}", {}]];
  }
}

/** Text that means nothing a field of this kind takes. */
const NONSENSE: Record<Kind, readonly string[]> = {
  boolean: ["yes", "True"],
  literal: ["yes", "True"],
  number: ["about 5", "1,5", "$2"],
  array: ["not a list", "[1, 2"],
  object: ["nope", "{"],
  record: ["nope", "{"],
};

/** A whole input with `value` at `path` and nothing else. */
function inputWith(path: Path, value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const inner = inputWith(rest, value);
  return typeof head === "number" ? [inner] : { [head]: inner };
}

/** "legs[0].amountUsd", as the refusal names it. */
function named(path: Path): string {
  return path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : `${index > 0 ? "." : ""}${key}`))
    .join("");
}

/** What the schema says about the field and everything under it. */
function issuesAt(schema: Schema, path: Path, input: unknown) {
  const parsed = z.safeParse(schema, input);
  return (parsed.error?.issues ?? [])
    .filter((issue) => path.every((key, index) => issue.path[index] === key))
    .map(({ path: at, code, message }) => ({ at, code, message }));
}

// Every tool core and the shipped apps register (with the one key some need), as the MCP server
// checks it, and every watch source's condition, as the watch tool reads it.
process.env.ELFA_AUTO_API_KEY = "elfa-test";
const tools = toolsFor({ thread: { id: "t", specialistId: null } as ThreadRow });
const inputs: { readonly name: string; readonly schema: Schema }[] = [
  ...tools.map((tool) => ({ name: tool.name, schema: toolInput(tool.inputSchema) })),
  ...sources().map(({ about, source }) => ({
    name: `watch condition (${about.id})`,
    schema: textAsMeant(source.condition),
  })),
];
delete process.env.ELFA_AUTO_API_KEY;
const rows = inputs.flatMap(({ name, schema }) => rowsOf(name, schema));

beforeAll(() => sayInputErrorsPlainly());

describe("a tool's input sent as text", () => {
  it("covers every tool, and every kind of field a model sends as text", () => {
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([...AUNI_TOOL_NAMES].toSorted());
    expect(new Set(rows.map(({ field }) => field.kind))).toEqual(
      new Set(["boolean", "number", "literal", "array", "object", "record"]),
    );
    expect(rows.map(({ name, at }) => `${name} ${at}`)).toEqual(
      expect.arrayContaining([
        "update_specialist retired",
        "polymarket_order amountUsd",
        "propose_actions legs",
        "send_evm_transaction calls",
        "suggest_replies multiple",
      ]),
    );
  });

  it.each(rows)("$name $at: text is read as what it means", ({ schema, field }) => {
    for (const [text, meant] of readings(field)) {
      expect(issuesAt(schema, field.path, inputWith(field.path, text))).toEqual(
        issuesAt(schema, field.path, inputWith(field.path, meant)),
      );
    }
  });

  it.each(rows)("$name $at: nonsense is refused, saying what was sent", ({ schema, field }) => {
    for (const text of NONSENSE[field.kind]) {
      const [refusal] = issuesAt(schema, field.path, inputWith(field.path, text));
      expect(refusal?.message.startsWith(`${named(field.path)} must be `)).toBe(true);
      expect(refusal?.message).toContain(`, and it was sent as text (${JSON.stringify(text)})`);
    }
  });

  it("shows the agent each tool's schema exactly as it was written", () => {
    for (const tool of tools)
      expect(z.toJSONSchema(toolInput(tool.inputSchema), { io: "input" })).toEqual(
        z.toJSONSchema(z.object(tool.inputSchema), { io: "input" }),
      );
  });

  it("holds an amount read from text to the same range, sign and decimals", () => {
    const amount = toolInput({ amountUsd: z.number().positive().max(100).multipleOf(0.01) });
    expect(amount.parse({ amountUsd: "1.5" })).toEqual({ amountUsd: 1.5 });
    for (const text of ["-1", "0", "100.01", "1.234"])
      expect(amount.safeParse({ amountUsd: text }).error?.issues).toEqual(
        amount.safeParse({ amountUsd: Number(text) }).error?.issues,
      );
    expect(amount.safeParse({ amountUsd: "-1" }).success).toBe(false);
  });

  it("reads a watch's condition as the one form it fits, and says what is wrong with the closest", () => {
    const prices = sources().find(({ about }) => about.id === "prices")!.source.condition;
    const condition = textAsMeant(prices);
    expect(condition.parse({ market: "BTC", crosses: "below", price: "60000" })).toEqual({
      market: "BTC",
      crosses: "below",
      price: 60000,
    });
    expect(
      condition.parse('{"market":"BTC","moves":"up","percent":"5","within":"1h"}'),
    ).toMatchObject({ percent: 5 });
    const refused = condition.safeParse({ market: "BTC", crosses: "below", price: "lots" });
    expect(refused.error?.issues[0]?.message).toBe(
      'price must be a number, and it was sent as text ("lots")',
    );
  });

  it("leaves text where text is wanted, and reads a union only where one reading fits", () => {
    const input = toolInput({
      chain: z.union([z.string(), z.number()]),
      size: z.union([z.number(), z.boolean()]),
    });
    expect(input.parse({ chain: "10", size: "4" })).toEqual({ chain: "10", size: 4 });
    expect(input.parse({ chain: "base", size: "true" })).toEqual({ chain: "base", size: true });
  });

  it("reads through a field's own preprocess step, as an app may write one", () => {
    const own = z.preprocess((value) => value, z.array(z.number()));
    expect(toolInput({ sizes: own }).parse({ sizes: '["1", 2]' })).toEqual({ sizes: [1, 2] });
  });
});

// A wallet brought with its EVM key alone was told a stock under $10 moves to Solana.
describe("the tools a wallet with no Solana key is offered", () => {
  it("leaves out what moves only on Solana, and gives stock_trade no Solana route", () => {
    const offered = toolsFor(
      { thread: { id: "t", specialistId: null } as ThreadRow },
      {
        solana: false,
      },
    );
    const names = offered.map(({ name }) => name);
    expect(names).not.toContain("solana_swap");
    expect(names).not.toContain("send_solana_transaction");
    const stocks = offered.find(({ name }) => name === "stock_trade")!.description;
    expect(stocks).toContain(
      "A trade no Monad venue takes has no other route for this wallet: This wallet has no Solana address yet",
    );
    expect(stocks).not.toMatch(/moves to Solana|off a bridge|Solana only if/u);
    // With a Solana key, both are offered and stock_trade says its Solana route.
    const all = tools.map(({ name }) => name);
    expect(all).toEqual(expect.arrayContaining(["solana_swap", "send_solana_transaction"]));
    expect(tools.find(({ name }) => name === "stock_trade")!.description).toContain(
      "Only a stock no Monad venue can trade moves to Solana",
    );
  });
});
