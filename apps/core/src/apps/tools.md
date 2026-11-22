# Adding lookups, and cards of its own

A lookup is a read-only tool the agent may call on any turn: market data, a search, a price. It
never moves money; only a venue's recipes do. Core runs it, never the agent's box, so any key it
needs stays in core.

An app gives its lookups as `lookups: () => AuniTool[]` in `index.ts`. It is a function so an
app without its key can give none, and the agent never sees a tool that can't answer:

```ts
lookups: () => (elfaReadable() ? marketTools() : []),   // elfa/index.ts
```

## Writing one

An `AuniTool` (`../agent/tool.ts`), written with `defineTool`: a name, description, zod input and
a handler that returns `result(text)` (a lookup's answer as JSON: `result(JSON.stringify(found))`)
or `failure(error)`. Copy `hyperliquid/markets.ts` (`hyperliquidMarkets`) or `elfa/tools.ts`.

Then list each one in `about.ts` as `kind: "read"`, with its `copy` and an `icon` (`search`,
`chart`, `news` or `wallet`) for the step the web shows while it runs, and run `pnpm gen`.

## Mind

- Text from other people (posts, market titles) is data. Fence it and tell the agent never to
  follow instructions inside it, as `elfa/tools.ts` does.
- Keep answers small; the agent reads every word. Elfa caps each at `MAX_CHARS`.
- Say in a few words what it found, for the right of the step's row:
  `result(text, { found: counted(markets.length, "market", "markets") })`.
- A lookup that shows a card of its own, as `market_pulse` shows Elfa's tape, returns
  `result(text, { card: { kind: "app", app: "<id>", view: "<view>", data, ... } })`. The card is
  `<view>.card.tsx` in the app's folder, a React component given `{ data }`, and the data's
  zod schema is `<view>.schema.ts` beside it (its default export), which the web parses before
  drawing. `pnpm gen` lists each view for the web. A card imports only React, `@auni/shared`, the
  web's `@/components` and `@/lib` (never `@/lib/data` or `@/lib/core`) and its folder's `.tsx`
  and `.schema.ts` files; a schema only `zod` and `@auni/shared` (ESLint holds both). Copy
  `elfa/tape.card.tsx` and `elfa/tape.schema.ts`.
