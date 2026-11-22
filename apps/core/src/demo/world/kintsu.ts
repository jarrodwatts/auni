import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import { addressOf, chains, Reverted, transferLog, type Contract } from "./chain.ts";
import { STAKED_MON } from "./tokens.ts";

// The demo's Kintsu: liquid staking on Monad, which Auni ships no app for. It is here so a scene
// can show what Auni does with a service nobody has written an app for: the brain builds the
// transaction itself, and core reads its card from the simulation. Staking takes MON and gives
// sMON one for one at once. Unstaking takes sMON and gives nothing back yet, as the real one
// pays MON out days later, so its card is one a tap can't vouch for.

/** The demo's staking contract, at an address of its own. */
const STAKING = addressOf("Kintsu staking");
const ABI = parseAbi(["function stake() payable", "function requestUnstake(uint256 shares)"]);
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const staking: Contract = (call, chain) => {
  const { functionName, args } = decodeFunctionData({ abi: ABI, data: call.data });
  if (functionName === "stake") {
    if (call.value === 0n) throw new Reverted("Nothing was sent to stake.");
    chain.credit(STAKED_MON.address, call.from, call.value);
    return {
      returned: "0x",
      logs: [transferLog(STAKED_MON.address, ZERO, call.from, call.value)],
    };
  }
  const [shares] = args;
  return { returned: "0x", logs: [chain.move(STAKED_MON.address, call.from, STAKING, shares)] };
};
chains.get("monad")!.deploy(STAKING, staking);

type BuiltCall = { readonly to: Address; readonly data: Hex; readonly value?: string };

/** The call that stakes `wei` of MON, as the brain builds it by hand. */
export function stakeMon(wei: bigint): BuiltCall {
  return {
    to: STAKING,
    data: encodeFunctionData({ abi: ABI, functionName: "stake" }),
    value: wei.toString(),
  };
}

/** The call that hands `shares` of sMON back to be paid out as MON later. */
export function unstakeMon(shares: bigint): BuiltCall {
  return {
    to: STAKING,
    data: encodeFunctionData({ abi: ABI, functionName: "requestUnstake", args: [shares] }),
  };
}
