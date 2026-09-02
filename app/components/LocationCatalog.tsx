"use client";

import { useState } from "react";
import { FixedTooltip } from "@/app/components/CardCatalog";
import { BOLD_LOCATION_ART_IDS, LocationArt } from "@/app/components/LocationArt";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useAssetExists } from "@/app/hooks/useAssetExists";
import { useHasHover } from "@/app/hooks/useHasHover";
import { CENTER_EFFECTS, centerEffectDescription, isAvailableAtPlayerCount } from "@/lib/content/centerEffects";
import { SELECTABLE_LOBBY_SIZES } from "@/lib/config/players";
import { configForPlayerCount } from "@/lib/engine/game";
import { CenterEffectId } from "@/lib/engine/types";

/** Locations sidebar order, simplest rule to understand first -- not alphabetical or insertion order. Exported so other location listings (e.g. the playtest heatmap's "by location" columns, MyStatsModal's own breakdown) can match it. */
export const LOCATION_COMPLEXITY_ORDER: CenterEffectId[] = [
  "none",
  "twoTowers",
  "threeHeadedDragon",
  "freeCities",
  "borderlands",
  "reckoning",
  "shadowlands",
  "frontier",
  "noMansLand",
  "mirrorPool",
  "championOfTheWeak",
  "summit",
  "kingslayer",
];

const LOCATIONS_DESCRIPTION =
  "A location is a game-wide rule this match is being played with -- it changes what the center tile does or bends a normal rule for everyone. Exactly one is active per game.";

/**
 * A location's own icon in the catalog row, if it has one -- a real component (not a
 * bare hook call) since useAssetExists can't be called directly inside the
 * LOCATION_COMPLEXITY_ORDER.map() below; each row needs its own hook instance, which
 * only works if each row is its own component. Renders nothing (not a placeholder) for
 * the many locations that don't have art yet, same as CardArt's own convention.
 */
function LocationIcon({ id, className }: { id: CenterEffectId; className: string }) {
  const exists = useAssetExists(`/location-art/${id}.svg`);
  if (!exists) return null;
  return <LocationArt id={id} className={className} />;
}

/**
 * Reference sidebar listing every location in the game -- split out from CardCatalog
 * (which used to fold this in as its own collapsible "Locations" sub-section) into its
 * own standalone panel with a matching "▶ Locations" header button, so a player can
 * browse locations without the card list taking up the same space, and vice versa. The
 * two are mutually exclusive (see each page's own onClick wiring, e.g. play/page.tsx's
 * "Locations"/"Cards" buttons) -- opening one collapses the other, since they occupy
 * the same sidebar slot and showing both at once would just be two competing sidebars.
 *
 * Same "caller fully controls collapsed state" shape as CardCatalog -- see its own doc
 * comment for why the toggle button lives in each page's header instead of here.
 */
export function LocationCatalog({
  playerCount,
  currentCenterEffect = "none",
  collapsed,
  onCollapsedChange,
  onPlayerCountChange,
}: {
  playerCount: number;
  currentCenterEffect?: CenterEffectId;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** When set, the "(Np)" header becomes an interactive player-count select instead of static text -- only the standalone home-screen catalog (no real game to pin the count to) passes this. */
  onPlayerCountChange?: (playerCount: number) => void;
}) {
  const hasHover = useHasHover();
  const activeTooltipId = useActiveTooltipId();
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);

  if (collapsed) return null;

  return (
    <aside className="w-full shrink-0 overflow-x-hidden lg:sticky lg:top-8 lg:w-48 lg:self-start lg:border-r-2 lg:border-zinc-400 lg:pr-4 dark:lg:border-zinc-600">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1 text-sm font-semibold">
          Locations{" "}
          {onPlayerCountChange ? (
            <select
              value={playerCount}
              onChange={(e) => onPlayerCountChange(Number(e.target.value))}
              aria-label="Catalog player count"
              className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs font-normal text-zinc-500 dark:border-zinc-700"
            >
              {SELECTABLE_LOBBY_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}p
                </option>
              ))}
            </select>
          ) : (
            <span className="font-normal text-zinc-500">({playerCount}p)</span>
          )}
        </h2>
        <button
          onClick={() => onCollapsedChange(true)}
          title="Collapse"
          className="shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ◀
        </button>
      </div>
      <div className="relative mb-3">
        <p
          className="text-[9px] text-zinc-500 dark:text-zinc-400"
          onMouseEnter={
            hasHover
              ? (e) => {
                  setActiveRect(e.currentTarget.getBoundingClientRect());
                  setActiveTooltip("catalog:locations");
                }
              : undefined
          }
          onMouseLeave={hasHover ? () => clearActiveTooltip("catalog:locations") : undefined}
          onClick={
            hasHover
              ? undefined
              : (e) => {
                  setActiveRect(e.currentTarget.getBoundingClientRect());
                  toggleActiveTooltip("catalog:locations");
                }
          }
        >
          What&apos;s a location? <span className="underline decoration-dotted">ⓘ</span>
        </p>
        {activeTooltipId === "catalog:locations" && activeRect && <FixedTooltip rect={activeRect}>{LOCATIONS_DESCRIPTION}</FixedTooltip>}
      </div>
      <div className="flex flex-col gap-2 overflow-x-hidden lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        {LOCATION_COMPLEXITY_ORDER
          // A location `disabled` outright isn't currently in the game at all (as
          // opposed to merely restricted to some player counts, which still shows
          // grayed out with its "Np+ only" restriction below), so it's hidden
          // rather than sorted to the bottom.
          .filter((id) => !CENTER_EFFECTS[id].disabled)
          .map((id) => {
            const def = CENTER_EFFECTS[id];
            const available = isAvailableAtPlayerCount(id, playerCount);
            const isCurrent = id === currentCenterEffect;
            const config = configForPlayerCount(playerCount, id);
            const restriction =
              def.minPlayerCount && def.maxPlayerCount
                ? `${def.minPlayerCount}-${def.maxPlayerCount}p only`
                : def.minPlayerCount
                  ? `${def.minPlayerCount}p+ only`
                  : def.maxPlayerCount
                    ? `up to ${def.maxPlayerCount}p only`
                    : null;
            const description = centerEffectDescription(id, config);
            // Same swatch-box + text-block row shape CardCatalog's own card rows use --
            // "Current"/availability read the same way a card's own owned/on-opponent-
            // board tone does, via the box's border/background.
            const boxToneClass = isCurrent
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
              : available
                ? "border-zinc-300 dark:border-zinc-700"
                : "border-zinc-200 opacity-50 dark:border-zinc-800";
            return (
              <div key={id} className="relative flex min-w-0 items-center gap-2">
                <div className={`relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${boxToneClass}`}>
                  <span className="text-[8px] font-semibold leading-tight break-words">{def.label}</span>
                  <LocationIcon id={id} className={`${BOLD_LOCATION_ART_IDS.has(id) ? "h-7 w-7" : "h-5 w-5"} shrink-0 ${def.themeColorClass}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{def.label}</div>
                  <div className="line-clamp-2 text-[10px] text-zinc-500 dark:text-zinc-400">{description}</div>
                  {restriction && <div className="mt-0.5 text-[9px] text-zinc-400 dark:text-zinc-500">{restriction}</div>}
                </div>
              </div>
            );
          })}
      </div>
    </aside>
  );
}
