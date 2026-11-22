## What this changes

<!-- One or two sentences, for the person who will run it. -->

## How I checked it

<!-- What you ran, and what you saw. `pnpm demo` shows any screen with no login and no money. -->

## If it adds or changes an app

An app answers for these four (CONTRIBUTING.md, "What an app answers for"). Tick what this pull request answers, and say why for any it leaves out.

- [ ] **Money in and out.** Its account says how money gets there and how it comes back, as moves or in plain words.
- [ ] **Things going wrong.** Each money tool has its held-to-card drill, and each refusal the service is known to give has a row in `problems.ts` with a recorded answer.
- [ ] **How it reads.** I looked at its cards in the demo at phone and desktop width.
- [ ] **Teaching Claude.** Its `SKILL.md` says when to load it, the steps that work, and what Auni can't do there.

## Before you ask for review

- [ ] The checks in the root `AGENTS.md` ("Before every commit") pass.
- [ ] No test calls a live AI or spends real money.
- [ ] I have read every line of this change and can explain it.
