/**
 * Whether the first take made the owner's wallet: the app's foot says so as its vault drops in.
 * A wallet brought home through the auni.io door was welcomed on the landing already.
 */
let walletMade = false;

export function noteWalletMade(made: boolean): void {
  walletMade = made;
}

export function takeMadeWallet(): boolean {
  return walletMade;
}
