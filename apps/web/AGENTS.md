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
  states: not paired, link used, Tailscale only, starting, no database), each read again by
  itself until the app can open.
- First run is the owner's first take (`components/first-run/first-take.tsx`, at `/app/new`):
  one question with the starting points and a line saying which AI is ready. Only an AI that
  can't think stops it (`pick-your-ai.tsx`). The take's chat finishes it (core's
  `POST /places/chat`, which makes the wallet, else the first move; `finish.ts` mirrors it); one
  the owner already has comes in before that (`bring-wallet.tsx`). Chat fallbacks: `brain-needed.tsx`, `spare-key.tsx`.
- Settings (`components/settings/`): grouped searchable modal over `/me`, `/brains`, `/apps`, and
  `/system/*` (`lib/data/system.ts`) for General, Appearance, Personalization, AI Brains, Wallet,
  Channels, Remote access (Tailscale, service, sessions, handover), Network/RPCs, Diagnostics, About.
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
- The shell (`components/places/`): on a wide screen the sidebar (`sidebar.tsx`,
  `place-list.tsx`): New take, Money, Apps, then each chat in one place (`use-places.ts`): Needs
  you while a card or question waits on the owner, Your takes while core's `GET /takes` lists it, as
  Money does (`use-takes.ts`), and Chats. On a phone a tab bar instead (`tab-bar.tsx`: Chats, Money,
  Needs you, More), with `/app/chats` and `/app/needs-you` as pages. A chat (`/app/chat/<id>`,
  `chat-place.tsx`) shows its take's value in its header and opens its inspector
  (`thread-inspector-pane.tsx`, `pane-sections.tsx`): positions, watches, spending, notes, moves.
- The composer holds one control, the AI and its effort (`components/app/model-picker.tsx`); what
  a chat may spend on its own is set in its inspector (`components/app/autonomy-picker.tsx`).
- Apps (`/app/apps`): `components/apps/`, on core's `GET /apps` (`lib/data/apps.ts`): the list
  (`apps-screen.tsx`) and each app's sheet (`app-sheet.tsx`): what is held there, its keys
  (`app-keys.tsx`, each a `SecretInput` to its private field), its switch, and for one Auni
  itself runs on, the job it does as a scene (`app-jobs.tsx`).
- Settings: `components/settings/settings-dialog.tsx`, on core's `/me`.
- The look is tokens (`app/tokens.css`), each colour `light-dark(light, dark)`: ink is the
  strong action, blue is Auni (links, focus), amber only waits on the owner, green and red
  only gain and loss; no gradients, glows or tinted tiles. Type is Inter and JetBrains Mono
  (`app/fonts.ts`) on one role scale (`text-caption` ... `text-hero-money`); corners are
  `rounded-control`, `-card`, `-sheet` or `-full`; one shadow, `shadow-float`, for what floats.
  `app/tokens.test.ts` fails a colour, a font size or a radius written into a component.
- Primitives (`components/ui/`): `Button`/`buttonVariants`, `Input`/`inputClass`, `Badge`,
  `Card`/`CardSection`, `Row`/`Rows`, `Section`/`Eyebrow`, `AuniSheet`, `ConfirmDialog`. Build
  from them; a logo with no mark is `NoMark`/`AppMark`'s neutral glyph, never initials.
- The look: light, unless the owner picks another in Settings (Dark, or
  one an app brings, its theme, copied by `pnpm gen` into `app/app-themes.generated.css`).
  `lib/look.tsx` keeps the choice on the device and wears it as `data-theme`;
  `lib/look-first.ts` is the script `app/layout.tsx` runs before the first paint.
- Money in and out: Add money (`components/money/portal/`), Withdraw (`components/withdraw/`)
  and the wallet's keys, each a `MoneySheet` (`components/money/money-sheet.tsx`).
