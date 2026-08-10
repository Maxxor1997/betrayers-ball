# Card art

Drop one SVG per card in here, named after its **`CardId`** (not its display name,
which changes more often) -- see `CardId` in `lib/engine/types.ts` for the exact
spelling of each:

```
Footman.svg   Giant.svg        Warlord.svg      Exile.svg
Pretender.svg Berserker.svg    Commander.svg    Gloryseeker.svg
Chronicler.svg Earthshaker.svg Skysplitter.svg  Bannerman.svg
PlagueBearer.svg Suppressor.svg Infiltrator.svg Truthseeker.svg
Mercenary.svg DyingGod.svg     Beacon.svg
```

Rendered via `app/components/CardArt.tsx`, which loads `/card-art/<CardId>.svg` as a
CSS `mask-image` on a `background-color: currentColor` box -- so it always renders as
a solid silhouette in whatever color the surrounding text is (light/dark mode, the
"faded" face-down-at-game-end dimming, etc. all just work automatically). A card with
no file here yet renders as an empty box, not a broken image -- add them whenever.

Guidelines for a file that'll actually look good at tiny sizes:
- **Square `viewBox`** (e.g. `viewBox="0 0 100 100"`) -- these render in a square slot.
- **Fill with `currentColor`**, not a hardcoded color -- though for the mask technique
  above it barely matters what the fill color is, only the shape's alpha does.
- **One flat silhouette**, no strokes/gradients/fine detail -- these render as small
  as ~20px on an actual card face.
- **No fixed `width`/`height` on the `<svg>` root** -- just the `viewBox`, so it can be
  freely resized by CSS.

## Attribution

Some files are adapted from third-party sources whose license requires attribution if
this project is ever published. Credit needed:

- `Pretender.svg` (trident): <a href="https://www.vecteezy.com/free-vector/trident">Trident Vectors by Vecteezy</a>
