import { CenterEffectDef, splitTitle } from "@/lib/content/centerEffects";

/**
 * The gameplay screen's big stylized location title -- same font/size treatment as
 * the home screen's own "Betrayer's Ball", but per-location: a themed color
 * (CenterEffectDef.themeColorClass) picked out around whichever part of the name is
 * most evocative (CenterEffectDef.titleHighlight), the rest in the default
 * foreground color. `def` is null only for multiplayer's brief window before the
 * lobby's chosen location is known yet, where `fallback` (the room code) stands in
 * with no color split.
 */
export function LocationTitle({ def, fallback }: { def: CenterEffectDef | null; fallback?: string }) {
  if (!def) {
    return <h1 className="font-serif text-3xl leading-none font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">{fallback}</h1>;
  }
  const { prefix, highlight, suffix } = splitTitle(def);
  return (
    <h1 className="font-serif text-3xl leading-none font-bold tracking-tight sm:text-4xl">
      <span className="text-zinc-900 dark:text-zinc-50">{prefix}</span>
      <span className={def.themeColorClass}>{highlight}</span>
      <span className="text-zinc-900 dark:text-zinc-50">{suffix}</span>
    </h1>
  );
}
