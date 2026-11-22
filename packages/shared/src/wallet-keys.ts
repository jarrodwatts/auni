/**
 * The wallet keys in what the owner pasted into the door for an auni.io wallet (the local-key
 * app's private field): auni.io's Get my keys gives an EVM key (0x and 64 hex characters) and a
 * Solana one (base58), and one field takes either or both, on lines of their own or run together,
 * as a one-line field joins them. Only their shape is read here: whether each is really a key is
 * core's to check.
 */
export function splitKeys(pasted: string): {
  readonly evm: readonly string[];
  readonly solana: readonly string[];
} {
  const evm: string[] = [];
  const solana: string[] = [];
  for (const token of pasted.split(/[\s,;"']+/u).filter(Boolean)) {
    // Base58 has no 0, so a 0x in a run is where an EVM key starts.
    const hex = /0x[0-9a-fA-F]{64}/u.exec(token);
    if (hex) {
      evm.push(hex[0]);
      const rest = token.slice(0, hex.index) + token.slice(hex.index + hex[0].length);
      if (rest) solana.push(rest);
    } else if (token.startsWith("0x") || /^[0-9a-fA-F]{64}$/u.test(token)) evm.push(token);
    else solana.push(token);
  }
  return { evm, solana };
}
