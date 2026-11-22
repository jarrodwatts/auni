<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# The web app

`next dev` writes the block above; leave it as it is. Below, paths are under `apps/web/`. The app
reads and writes only through core: the browser calls `/core` on this origin, which `proxy.ts`
passes on to core, so the owner's session cookie stays the web app's own
(`lib/core.ts`). `pnpm --filter @auni/web dev -H 0.0.0.0` opens `pnpm dev`'s web app to the
network on purpose, as a later `-H` wins.

- Pages: `app/`. Whose browser this is: `components/auth/owner-provider.tsx`, which spends the
  pairing link's code (`/app#pair=<code>`) as the app loads, and `owner-gate.tsx` (the honest
  states: link used, still starting, no database).
- First run is the owner's first take: until they send it, the app is the landing
  (`components/landing/`), Auni among takes people hold and one question, over `/app/new`;
  sending it makes the wallet and dives into the chat it starts (`landing-dive.ts`, handed the
  chat's first frame by `lib/first-message.ts`). The rest is `components/first-run/`. What it still needs is core's `GET /setup`, never this tab's memory:
  no AI asks in the chat (`brain-needed.tsx`, on an answer core marked `noBrain`), money is the
  card's own Add money, the spare key comes once a first trade is through (`spare-key.tsx`), and an auni.io
  wallet comes in at its quiet door (`bring-wallet.tsx`).
- The owner's AI, made ready from any device: `components/brains/brain-row.tsx`, one row a brain
  on core's `GET /brains` (`lib/data/brains.ts`): installing its CLI, or its own sign-in (a page
  and code, or its prompt as a terminal, typed into by its private field). First run's ask for a
  brain and a brain's sheet both show it.
- A new chat (`/app/new`): `components/app/conversation-welcome.tsx`, with the starting points
  core wrote from what it sees of the owner (`starting-points.tsx`, `GET /starting-points`).
- A secret the owner types goes only in a `PrivateInput` (`components/private-input/`), to core's
  `/private/:id` (`lib/data/private.ts`): never a form, a query cache, storage or a thread.
- Live updates: `lib/data/live.ts`, one stream from core's `GET /live` for the whole tab; after a
  drop the browser comes back by itself and reads again in whole whatever it may have missed.
- Reading and writing core's data: `lib/data/` (one file per area: threads, actions, portfolio...).
- Cards: `components/cards/`; a money card's parts in `components/cards/money/`, an ask's in
  `components/cards/ask-card.tsx` (its shape is `packages/shared/src/ask-card.ts`), an app
  Auni turns back on in `connect-card.tsx`, a secret it asks for in `secret-card.tsx`. What the owner can post to Auni's GitHub themselves:
  `components/feedback/` (`feedback-body.tsx`, shared by `feedback-card.tsx` and the report a
  failed card or an app's sheet opens, `report-dialog.tsx`).
- Tool names the web knows: `packages/shared/src/tools.ts` (an app's from `apps.generated.ts`).
- The Team list (Auni, specialists, History): `components/places/place-list.tsx`, `team.ts`
  (`teamOf`, `teamLine`); Auni's row is the latest open chat, as core's `mainChat` picks.
- A specialist's page (`/app/s/<id>`): `components/places/specialist-place.tsx` (its chat),
  `specialist-pane.tsx` and `pane-sections.tsx` (pot, positions, watches, notes, record).
- Apps (`/app/apps`): `components/apps/`, on core's `GET /apps` (`lib/data/apps.ts`): the list
  (`apps-screen.tsx`) and each app's sheet (`app-sheet.tsx`): what is held there, its keys
  (`app-keys.tsx`, each a `SecretInput` to its private field), its switch, and for one Auni
  itself runs on, the job it does as a scene (`app-jobs.tsx`).
- Settings: `components/settings/settings-dialog.tsx`, on core's `/me`.
- Colours: every one a person sees is a token in `app/tokens.css`, which holds each as
  `light-dark(light, dark)`; `app/tokens.test.ts` fails a hex value, a palette class
  (`bg-white`) or a `dark:` class in a component. Add a token that says what it is for; never
  write a colour in. A subject's own colour is its hue (`--hue`, the `hue-*` tokens).
- The look: light, unless the owner picks another in Settings (Dark, or
  one an app brings, its theme, copied by `pnpm gen` into `app/app-themes.generated.css`).
  `lib/look.tsx` keeps the choice on the device and wears it as `data-theme`;
  `lib/look-first.ts` is the script `app/layout.tsx` runs before the first paint.
- Add money: `components/money/portal/`.
