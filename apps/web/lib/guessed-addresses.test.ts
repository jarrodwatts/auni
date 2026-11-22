import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GUESSED_ADDRESSES } from "./guessed-addresses";

const APP = join(import.meta.dirname, "..", "app");
const PUBLIC = join(import.meta.dirname, "..", "public");

/** Every page's address, from the app folder: route groups "(name)" drop out, "[name]" is a part. */
function pages(dir = APP, at = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const part = /^\(.*\)$/u.test(entry.name) ? "" : `/${entry.name}`;
    const inner = join(dir, entry.name);
    return [
      ...(existsSync(join(inner, "page.tsx")) ? [at + part || "/"] : []),
      ...pages(inner, at + part),
    ];
  });
}

/** Every file the web app serves as it is, by its address: public/logos/aave.svg is "/logos/aave.svg". */
const served = (dir = PUBLIC, at = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? served(join(dir, entry.name), `${at}/${entry.name}`)
      : [`${at}/${entry.name}`],
  );

/** A redirect's source as the addresses it takes: ":app" is any one part. */
const takes = (source: string) => new RegExp(`^${source.replace(/:\w+/gu, "[^/]+")}$`, "u");

/** An address as a page pattern: "/app/s/:specialist" is "/app/s/[specialist]". */
const asPage = (address: string) => address.split("?")[0]!.replace(/:(\w+)/gu, "[$1]");

describe("guessed addresses", () => {
  const real = pages().map((page) => page.replace(/\[\w+\]/gu, "[]"));
  const shape = (address: string) => asPage(address).replace(/\[\w+\]/gu, "[]");

  it("send /app/portfolio, and the rest, to a page that exists", () => {
    expect(GUESSED_ADDRESSES).toContainEqual({ source: "/app/portfolio", destination: "/app" });
    for (const { destination } of GUESSED_ADDRESSES) expect(real).toContain(shape(destination));
  });

  it("never stand in front of a real page", () => {
    for (const { source } of GUESSED_ADDRESSES) expect(real).not.toContain(shape(source));
  });

  it("never stand in front of a file the web app serves, such as an app's logo", () => {
    const files = served();
    expect(files).toContain("/logos/aave.svg");
    for (const { source } of GUESSED_ADDRESSES)
      expect(files.filter((file) => takes(source).test(file))).toEqual([]);
  });
});
