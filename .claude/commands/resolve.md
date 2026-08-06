---
description: Sync the codebase after manual edits to cards.ts / centerEffects.ts / types.ts — fix type unions, tests, docs, and UI so everything agrees again
---

The user hand-edits `lib/content/cards.ts` and `lib/content/centerEffects.ts` directly in
the IDE while iterating on game balance (renaming a card, disabling one, changing a
`count`/`base`, adding or removing a `CenterEffectId`). Those edits are always
intentional — never revert them. Your job is to make the rest of the codebase agree
with whatever state those two files are now in.

## 1. Figure out what changed

Run `git diff -- lib/content/cards.ts lib/content/centerEffects.ts lib/engine/types.ts`
to see the actual edits since the last commit. Pay attention to:
- Renamed/added/removed keys in `CARD_DEFS` (cards.ts) or `CENTER_EFFECTS`
  (centerEffects.ts).
- `disabled: true` added or removed on a card or center effect.
- Changed `base`, `count`, or the shared `PSEUDO_CARD_BASE_VALUE`
  (centerEffects.ts) that Champion of the Weak / Kingslayer key off.

## 2. Fix type-level consistency first

`CardId` and `CenterEffectId` (both in `lib/engine/types.ts`) are the union types that
must exactly match the keys of `CARD_DEFS` / `CENTER_EFFECTS`. A rename, add, or
removal in either registry needs the matching union updated, or `npx tsc --noEmit`
will point at every call site that still uses the old name — work through that list
methodically rather than guessing.

## 3. Sync every reference to a renamed/removed id in code

Grep for the old name across the repo — `disabled: true` doesn't remove a name from
the type, but a full rename or deletion does, and every string literal needs to
follow:
- `lib/**/__tests__/*.test.ts` — string literals like `"championOfTheWeak"`,
  `place(board, x, y, "OldName", ...)`, `handCard("OldName", ...)`, describe/it block
  titles that name the old id.
- `app/play/page.tsx` — direct `centerEffect === "..."` comparisons, hardcoded UI
  strings for a removed effect (e.g. a status-panel branch that only existed for the
  removed effect's special rule).

`game_spec.md` does not need to be updated.

## 4. Run the tests and fix forward from actual failures

Don't hand-derive what test numbers *should* be from reading cards.ts — run the
suite and let the failures tell you exactly what's stale:
1. `npx tsc --noEmit` — fixes every stale identifier first.
2. `npm run test -- --run` — fix forward from actual failures, one at a time. Established
   convention: a card's `base` is referenced live via `CARD_DEFS.CardName.base`, and the
   shared pseudo-card value via `PSEUDO_CARD_BASE_VALUE` from `lib/content/centerEffects.ts`
   — never duplicated as a bare number, so those don't go stale. A test's *own* effect
   delta (e.g. "+2 per neighbor") stays a literal, since that delta is the actual thing
   under test. When a failure is a hardcoded deck-total snapshot
   (`lib/engine/__tests__/deck.test.ts`), recompute it from the current `CARD_DEFS`
   rather than nudging the old number and hoping.
3. `npm run build`

## 6. Report back

Summarize: what changed in the two source files, and what you touched to keep code
consistent (grouped by file). Flag anything you *didn't* touch because it's a
judgment call, not a mechanical sync.
