import { NETWORKS } from "@auni/shared";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  parseAbi,
  sliceHex,
  type Address,
  type Hex,
} from "viem";

import type { Asked, Service } from "../world.ts";
import { chains, Reverted } from "./chain.ts";
import { creditFromCircle } from "./hyperliquid.ts";

// The demo's Circle, for a deposit into Hyperliquid by CCTP (apps/hyperliquid/cctp.ts): its
// TokenMessengerV2 on Arbitrum, which burns the USDC it is approved for, and its API, which
// quotes the fee and says what became of a burn. Its forwarder carries each burn on at once and
// credits the Hyperliquid account the burn names, less the flat fee, as the real one does about a
// minute later.

const TOKEN_MESSENGER: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const FORWARDER: Address = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const USDC = NETWORKS.arbitrum.usdc as Address;
/** The flat forwarding fee Circle quoted on 2026-11-13, in USDC units. */
const FORWARD_FEE = 200_000n;

const messengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

/** What Circle says of each burn it carried on, by the Arbitrum transaction that made it. */
const carried = new Map<string, { readonly feeExecuted: string }>();

const arbitrum = chains.get("arbitrum")!;

arbitrum.deploy(TOKEN_MESSENGER, (call, chain) => {
  const { args } = decodeFunctionData({ abi: messengerAbi, data: call.data });
  const [amount, domain, recipient, token, caller, maxFee, finality, hook] = args;
  if (!isAddressEqual(token, USDC)) throw new Reverted("Burn token not supported");
  if (maxFee < FORWARD_FEE) throw new Reverted("Insufficient max fee");
  chain.spend(USDC, call.from, TOKEN_MESSENGER, amount);
  const burned = chain.move(USDC, call.from, ZERO, amount);
  const said = encodeEventTopics({
    abi: messengerAbi,
    eventName: "DepositForBurn",
    args: { burnToken: USDC, depositor: call.from, minFinalityThreshold: finality },
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes" },
    ],
    [amount, recipient, domain, recipient, caller, maxFee, hook],
  );
  return {
    returned: "0x",
    logs: [burned, { address: TOKEN_MESSENGER, topics: said, data }],
  };
});

// The forwarder carries a burn on once it is mined: to the account named in its hook data
// (after "cctp-forward", a version and a length, 32 bytes in), less the fee.
arbitrum.watch((tx) => {
  for (const log of tx.logs) {
    if (!isAddressEqual(log.address, TOKEN_MESSENGER)) continue;
    const { args } = decodeEventLog({
      abi: messengerAbi,
      eventName: "DepositForBurn",
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    });
    const forwarder = getAddress(sliceHex(args.mintRecipient, 12));
    if (!isAddressEqual(forwarder, FORWARDER)) continue;
    const account = getAddress(sliceHex(args.hookData, 32, 52));
    carried.set(tx.hash.toLowerCase(), { feeExecuted: String(FORWARD_FEE) });
    creditFromCircle(account, Number(args.amount - FORWARD_FEE) / 1e6);
  }
});

export const circle: Service = {
  hosts: ["iris-api.circle.com"],
  answer({ url }: Asked) {
    if (url.pathname.startsWith("/v2/burn/USDC/fees/")) {
      const forwardFee = { low: 200_000, med: 200_000, high: 200_000 };
      return [
        { finalityThreshold: 1000, minimumFee: 0, forwardFee },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee },
      ];
    }
    if (url.pathname !== "/v2/messages/3") return undefined;
    const burn = carried.get(url.searchParams.get("transactionHash")?.toLowerCase() ?? "");
    if (!burn) return undefined;
    return {
      messages: [
        {
          forwardState: "COMPLETE",
          decodedMessage: { decodedMessageBody: { feeExecuted: burn.feeExecuted } },
        },
      ],
    };
  },
};
