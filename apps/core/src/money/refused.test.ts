import { BaseError, ContractFunctionRevertedError, RpcRequestError, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import type { Problems } from "../apps/contract.ts";
import { MayHaveSent } from "./recipe.ts";
import { Refused, refused, revertOf, revertWords } from "./refused.ts";

const problems: Problems = {
  said: (answer) => String(answer),
  known: [{ example: "x.json", when: /full/u, kind: "rule", say: "The market is full." }],
};

describe("refused", () => {
  it("is the app's own sentence and kind for a refusal it knows, and the service's words else", () => {
    const known = refused("Aave", problems, "SupplyCapExceeded: full");
    expect(known).toBeInstanceOf(Refused);
    expect([(known as Refused).kind, known.message]).toEqual(["rule", "The market is full."]);
    expect(refused("Aave", problems, "something else").message).toBe(
      "Aave refused: something else",
    );
  });
});

describe("revertOf", () => {
  it("finds what a node said a call reverts with, under an estimate's error", () => {
    // As viem throws an estimate the node refused: the bytes are on the request's error.
    const node = new RpcRequestError({
      body: {},
      url: "http://node",
      error: { code: 3, message: "execution reverted", data: "0x47bc4b2c" },
    });
    expect(revertOf(new BaseError("Execution reverted.", { cause: node }))).toBe("0x47bc4b2c");
  });

  it("finds what a simulation saw, kept as the cause of core's own sentence", () => {
    const abi = parseAbi(["error SupplyCapExceeded()"]);
    const reverted = new ContractFunctionRevertedError({
      abi,
      data: "0xf58f733a",
      functionName: "supply",
    });
    const said = new Error("Call 2 of 2 reverts in a simulation.", { cause: reverted });
    expect(revertOf(said)).toBe("0xf58f733a");
  });

  it("finds nothing in an error that holds no revert, such as a send that may have gone", () => {
    expect(revertOf(new Error("The transaction reverted on Base (0xabc)."))).toBeUndefined();
    const unanswered = new RpcRequestError({
      body: {},
      url: "http://node",
      error: { code: -32000, message: "lost", data: "0x47bc4b2c" },
    });
    expect(
      revertOf(new MayHaveSent({ chain: "base", hash: "0x01" }, "Base", unanswered)),
    ).toBeUndefined();
    expect(revertOf({ data: "0x" })).toBeUndefined();
    expect(revertOf("0x47bc4b2c")).toBeUndefined();
  });
});

describe("revertWords", () => {
  const errors = parseAbi(["error SupplyCapExceeded()"]);

  it("names a contract's own error, a plain revert's words, and a panic's code", () => {
    expect(revertWords("0xf58f733a", errors)).toBe("SupplyCapExceeded");
    expect(
      revertWords(
        "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002645524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e63650000000000000000000000000000000000000000000000000000",
        errors,
      ),
    ).toBe("ERC20: transfer amount exceeds balance");
    expect(
      revertWords(
        "0x4e487b710000000000000000000000000000000000000000000000000000000000000011",
        errors,
      ),
    ).toBe("panic 0x11");
    expect(revertWords("0xdeadbeef", errors)).toBe("an error Auni can't read (0xdeadbeef)");
  });
});
