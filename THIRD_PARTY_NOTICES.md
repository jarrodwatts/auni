# Third-party notices

Auni's own code is MIT (`LICENSE`). This file lists what the repository ships that others made:
the marks of the services, networks and tokens Auni names, and the code dependencies whose
licences ask to be credited. Each owner's terms were read on 2026-11-12 or 2026-11-13, at the address given.

## Marks

Auni wears a service's, network's or token's own mark only to name that service, network or
token where Auni connects to it or holds it, as a wallet or an exchange does. Each mark is drawn
as its owner supplies it, never altered, and never to suggest its owner endorses Auni. Each name
and mark belongs to its owner, and nothing here claims a permission its owner has not given: the
last column says what each owner's terms say, including where they ask to approve a use first. If
an owner objects, take its file out: the app then wears Auni's tinted initials
(`apps/web/components/apps/app-mark.tsx`), which is also what an app with no logo file wears.

| File                                                                                  | Whose                                            | Where the file came from, and the owner's terms                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/core/src/apps/aave/logo.svg`                                                    | Aave                                             | https://aave.com/brand: "You can use the Aave logo on your website or promotional materials provided your usage doesn't misrepresent the Aave brand", unaltered.                                                                                                                        |
| `apps/core/src/apps/across/logo.svg`                                                  | Across                                           | https://docs.across.to/user-docs/additional-info/across-brand-assets: logos offered for download, the round logomark for apps and token icons, and "Powered by Across" marks for integrations.                                                                                          |
| `apps/core/src/apps/backed/logo.png`                                                  | Backed                                           | Backed's round mark, as https://backed.fi wears it for its icon. No brand kit or terms were found.                                                                                                                                                                                      |
| `apps/core/src/apps/claude-code/logo.svg`                                             | Claude Code (Anthropic)                          | The Claude spark on Claude's cream. Anthropic's terms (https://assets.claude.com/f7874b435aabdaee5f836e888b4439b9b56a934b.pdf): "You may only use our trademarks as specifically permitted by us and only in materials we approve beforehand." No approval has been asked for or given. |
| `apps/core/src/apps/codex/logo.svg`                                                   | Codex (OpenAI)                                   | OpenAI's blossom, the mark https://developers.openai.com/codex wears for its icon. OpenAI's brand page (https://openai.com/brand/) could not be read from here, so its terms are not known.                                                                                             |
| `apps/core/src/apps/coingecko/logo.png`                                               | CoinGecko                                        | https://brand.coingecko.com/resources/attribution-guide: its logo is used to credit CoinGecko as a data source, unaltered, without implying endorsement.                                                                                                                                |
| `apps/core/src/apps/defillama/logo.png`                                               | DefiLlama                                        | https://defillama.com/press: branding assets offered for download, with the llama icon beside the name.                                                                                                                                                                                 |
| `apps/core/src/apps/dexscreener/logo.png`                                             | DexScreener                                      | DexScreener's mark. No brand kit or terms were found, and where the file came from was not recorded.                                                                                                                                                                                    |
| `apps/core/src/apps/elfa/logo.png`, `apps/web/public/brand/protocols/elfa-lockup.svg` | Elfa                                             | The icon and the lockup https://www.elfa.ai serves (`/apple-icon.png`, `/logos/elfa-lockup.svg`), the same bytes, compared on 2026-11-13. No brand kit or terms were found.                                                                                                             |
| `apps/core/src/apps/hyperliquid/logo.svg`                                             | Hyperliquid                                      | Its documentation (https://hyperliquid.gitbook.io/hyperliquid-docs) offers its logo for download as SVG and PNG; no further terms were found.                                                                                                                                           |
| `apps/core/src/apps/jupiter/logo.svg`                                                 | Jupiter                                          | https://developers.jup.ag/docs/resources/brand-kit: "Logos, labelling guidelines, and brand assets for Jupiter integrations".                                                                                                                                                           |
| `apps/core/src/apps/kuru/logo.svg`                                                    | Kuru                                             | Kuru's mark, as https://www.kuru.io wears it for its icon. No brand kit or terms were found.                                                                                                                                                                                            |
| `apps/core/src/apps/kyberswap/logo.svg`                                               | KyberSwap                                        | https://kyber.network/media-kit: logos offered for download, print and web.                                                                                                                                                                                                             |
| `apps/core/src/apps/lifi/logo.svg`                                                    | LI.FI                                            | https://li.fi/brand-guidelines: a brand asset pack for partners; the icon may stand alone where space is tight.                                                                                                                                                                         |
| `apps/core/src/apps/polymarket/logo.svg`                                              | Polymarket                                       | https://polymarket.com/brand: "The Polymarket wordmark and logo should be used in all references to Polymarket as space allows", with a logo pack to download.                                                                                                                          |
| `apps/core/src/apps/privy/logo.svg`                                                   | Privy                                            | Privy's mark, as https://privy.io wears it for its icon. No brand kit or terms were found.                                                                                                                                                                                              |
| `apps/core/src/apps/relay/logo.svg`                                                   | Relay                                            | https://docs.relay.link/resources/brand-assets: brand assets and guidelines offered for download.                                                                                                                                                                                       |
| `apps/core/src/apps/telegram/logo.svg`                                                | Telegram                                         | Telegram's paper plane. Its bot terms (https://telegram.org/tos/bot-developers, section 8.1) say a bot's service may not incorporate Telegram's logos "into its branding". Auni wears it only to name the channel it connects to, never as a brand of its own.                          |
| `apps/web/public/brand/chains/arbitrum.svg`                                           | Arbitrum                                         | https://arbitrum.io/brand-kit: logos offered under its guidelines; using them accepts the guidelines.                                                                                                                                                                                   |
| `apps/web/public/brand/chains/base.svg`                                               | Base                                             | https://www.base.org/brand/core-identifiers: the Base square in Base Blue, white or black.                                                                                                                                                                                              |
| `apps/web/public/brand/chains/bnb.svg`                                                | BNB Chain                                        | BNB Chain's mark. https://www.bnbchain.org/en/brand-guidelines asks for approval before a project uses its logo; no approval has been asked for or given.                                                                                                                               |
| `apps/web/public/brand/chains/ethereum.svg` (also Ether's mark)                       | Ethereum                                         | https://ethereum.org/en/assets/ offers the Ethereum glyph for download; https://ethereum.org/en/terms-of-use/ licenses the site's non-code content under CC BY 4.0, and reserves only the Ethereum Foundation's own marks.                                                              |
| `apps/web/public/brand/chains/ink.svg`                                                | Ink                                              | https://docs.inkonchain.com/work-with-ink/brand-kit: logos, the chain mark and best practices.                                                                                                                                                                                          |
| `apps/web/public/brand/chains/monad.svg`, `apps/web/public/brand/tokens/mon.png`      | Monad                                            | https://monad.xyz/brand-and-media-kit: the logo mark may stand alone where the name is already shown.                                                                                                                                                                                   |
| `apps/web/public/brand/chains/robinhood.png`                                          | Robinhood Chain                                  | https://docs.robinhood.com/chain/brand-guidelines/: the chain logo and feather symbol offered for download; the feather alone for small places such as icons.                                                                                                                           |
| `apps/web/public/brand/chains/solana.svg`, `apps/web/public/brand/tokens/sol.png`     | Solana                                           | https://solana.org/branding: the logomark offered for download, unaltered, never stretched or outlined.                                                                                                                                                                                 |
| `apps/web/public/brand/chains/unichain.svg`                                           | Unichain                                         | https://www.unichain.org/brand-kit: the icon as shorthand for the network, in its own colours.                                                                                                                                                                                          |
| `apps/web/public/landing/*.svg`                                                       | The companies and coins the landing's takes name | Each one's public mark, as TradingView's symbol logos draw it.                                                                                                                                                                                                                          |
| `apps/web/public/brand/tokens/pol.png`                                                | Polygon                                          | https://polygon.technology/brand-guidelines: a logo kit for partners, press and developers.                                                                                                                                                                                             |
| `apps/web/public/brand/tokens/usdc.svg`                                               | USDC (Circle)                                    | https://brand.circle.com/d/M9z54TaEwsWL/stablecoins: the USDC token logo is the one for transaction and app screens, in blue, at 32px or more.                                                                                                                                          |
| `apps/web/public/brand/tokens/btc.svg`                                                | Bitcoin                                          | https://commons.wikimedia.org/wiki/File:Bitcoin.svg, in the public domain (https://en.bitcoin.it/wiki/Promotional_graphics: "They are in the public domain").                                                                                                                           |

Where most files came from was not recorded when they were added, and only Elfa's were compared
byte for byte with their owner's download. A file that differs from what its owner supplies should
be replaced with theirs.

### Not shipped, and why

| Whose   | Why                                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uniswap | Every EVM swap wore Uniswap's logo whichever route filled it, which named the wrong service as well as borrowing a mark; it now wears Auni's own swap glyph (`apps/web/public/brand/marks/swap.svg`). |

Auni's own marks (the mascot, the lockup, the app icons, `marks/stocks.svg`, `marks/swap.svg`,
and the key and price glyphs of `local-key` and `prices`) are Auni's, under its MIT licence.

## Code

Auni's dependencies are installed by pnpm, not copied into this repository; a build or the Docker
image then carries them. All but a few are MIT, ISC, BSD or similar, whose notices travel in each
package's own `LICENSE` file. These ask for more, or are not open source:

- **PostgreSQL**, run by `@embedded-postgres/linux-x64` (and its macOS siblings) as Auni's own
  database: the PostgreSQL Licence, https://www.postgresql.org/about/licence/. Portions Copyright
  © 1996-2026, The PostgreSQL Global Development Group; Portions Copyright © 1994, The Regents of
  the University of California.
- **libvips**, the prebuilt `@img/sharp-libvips-*` library that the web app's image resizing
  (`sharp`) loads: LGPL-3.0-or-later. It is a separate shared library, unmodified; its source is
  at https://github.com/libvips/libvips.
- **Apache-2.0 packages**: `ai` and `@ai-sdk/*`, `@privy-io/node`, `@solana-program/system`,
  `@solana-program/token`, `drizzle-orm`, `sharp`, `streamdown` and `@streamdown/*`, `remend`,
  `@swc/helpers`, `@vercel/oidc`, `@workflow/serde`, `@chevrotain/types`,
  `baseline-browser-mapping`, `canonicalize`, `class-variance-authority`, `detect-libc`,
  `reflect-metadata` and `typescript`. None ships a NOTICE file; each carries its licence.
- **DOMPurify**: MPL-2.0 or Apache-2.0, at the user's choice; used unmodified.
- **caniuse-lite**: data under CC BY 4.0, from https://caniuse.com.
- **es-toolkit**: MIT, with a NOTICE that parts derive from Lodash, Copyright OpenJS Foundation
  and other contributors.
- **lru-cache**: the Blue Oak Model License 1.0.0.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): not open source. "© Anthropic PBC. All
  rights reserved. Use is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance."

`pnpm licenses list --prod` lists every dependency with its licence.
