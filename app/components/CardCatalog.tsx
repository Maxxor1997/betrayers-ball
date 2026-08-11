"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CardArt } from "@/app/components/CardArt";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription, isAvailableAtPlayerCount } from "@/lib/content/centerEffects";
import { SELECTABLE_LOBBY_SIZES } from "@/lib/config/players";
import { configForPlayerCount } from "@/lib/engine/game";
import { CardBucket, CardId, CenterEffectId } from "@/lib/engine/types";

/**
 * A tooltip rendered into document.body via a portal, positioned with `fixed` from
 * the anchor's real screen coordinates -- unlike a plain `absolute` tooltip nested
 * inside a scrollable ancestor, this can't get clipped by that ancestor's overflow
 * (CSS forces overflow-x to clip too whenever overflow-y is scrollable, so any
 * tooltip meant to extend sideways out of a vertically-scrolling sidebar needs this).
 */
/** Minimum gap kept between a FixedTooltip and the viewport edges. */
const TOOLTIP_VIEWPORT_MARGIN = 8;

export function FixedTooltip({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Starts aligned to the hovered element's top-right; clamped once the tooltip's
  // actual rendered size is known (a hovered element near the bottom of the viewport
  // -- e.g. a scrolled sidebar entry -- would otherwise position the tooltip's *top*
  // on screen while its body extends off the bottom edge, invisible). Same idea
  // horizontally, capped against the right edge -- the anchor is always the small
  // swatch box (see anchorRect below), never the full-width row, so simple clamping
  // is enough; it doesn't need to flip to the anchor's other side.
  const [top, setTop] = useState(rect.top);
  const [left, setLeft] = useState(rect.right + 4);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const maxTop = window.innerHeight - height - TOOLTIP_VIEWPORT_MARGIN;
    setTop(Math.min(Math.max(rect.top, TOOLTIP_VIEWPORT_MARGIN), Math.max(maxTop, TOOLTIP_VIEWPORT_MARGIN)));

    const width = ref.current?.offsetWidth ?? 0;
    setLeft(Math.min(rect.right + 4, window.innerWidth - width - TOOLTIP_VIEWPORT_MARGIN));
  }, [rect]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-50 w-max max-w-[14rem] rounded bg-zinc-900 px-2 py-1 text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black"
      style={{ top, left }}
    >
      {children}
    </div>,
    document.body
  );
}

const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

/** Locations sidebar order, simplest rule to understand first -- not alphabetical or insertion order. Exported so other location listings (e.g. the playtest heatmap's "by location" columns) can match it. */
export const LOCATION_COMPLEXITY_ORDER: CenterEffectId[] = [
  "none",
  "twoTowers",
  "threeHeadedDragon",
  "freeCities",
  "reckoning",
  "shadowlands",
  "frontier",
  "mirrorPool",
  "championOfTheWeak",
  "summit",
  "kingslayer",
];

const BUCKET_DESCRIPTIONS: Record<CardBucket, string> = {
  Slam: "High base value with a built-in downside or condition that can cut it back down -- big numbers, but risky.",
  Engine: "Low base value that grows from board state or synergy with other cards -- value comes from setup, not the printed number.",
  Control: "Doesn't boost itself -- manipulates neighbors' values or bends the normal rules (negation, forced flips, zeroing).",
};

const LOCATIONS_DESCRIPTION =
  "A location is a game-wide rule this match is being played with -- it changes what the center tile does, adds a special win condition, or bends a normal rule (adjacency, flipping, ...) for everyone. Exactly one is active per game, picked at New Game.";

/**
 * Reference sidebar listing every card in the game, grouped by bucket, with its copy
 * count at the current game's player count -- lets a new player see the whole card
 * pool up front instead of only discovering cards as they're drawn. Shows every card
 * regardless of count (a card disabled or absent at this player count still appears,
 * just annotated "x0 in deck"). Also used standalone (no active game) on the home
 * screen, via the myCardIds/opponentVisibleBoardCardIds/currentCenterEffect defaults.
 *
 * Collapse state is fully controlled by the caller (`collapsed`/`onCollapsedChange`,
 * typically backed by useDefaultCollapsed) rather than owned internally -- the actual
 * "▶ Cards" toggle lives in each page's own header instead of here, so it can sit
 * inline with the rest of the header's buttons instead of rendering as its own
 * full-width block above them (which is exactly what it did back when this component
 * rendered its own collapsed placeholder as a sibling `<aside>` ahead of the header:
 * on a narrow mobile layout, that's a separate flex item, so it stacked onto its own
 * line no matter how small the button itself was). Collapsed now just renders nothing.
 */
export function CardCatalog({
  playerCount,
  myCardIds = new Set(),
  opponentVisibleBoardCardIds = new Set(),
  currentCenterEffect = "none",
  // Defaults match single-player's fixed HUMAN-is-always-index-0 board color -- the
  // standalone home-screen catalog (no active game, myCardIds always empty) never
  // actually renders anything in this color, so the default only matters for callers
  // that don't bother overriding it.
  myAccentClass = "border-blue-500 bg-blue-50 dark:bg-blue-950",
  myDotColorClass = "bg-blue-500",
  collapsed,
  onCollapsedChange,
  onPlayerCountChange,
}: {
  playerCount: number;
  myCardIds?: Set<CardId>;
  opponentVisibleBoardCardIds?: Set<CardId>;
  currentCenterEffect?: CenterEffectId;
  /** The viewer's own board accent (see lib/config/players.ts's playerAccentClass) -- "My Cards" is highlighted in this color instead of a hardcoded blue, so it matches whatever color that same player's cards actually show as on the board (which depends on seat order, not fixed to any one player in multiplayer). */
  myAccentClass?: string;
  myDotColorClass?: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** When set, the "(Np)" header becomes an interactive player-count select instead of static text -- only the standalone home-screen catalog (no real game to pin the count to) passes this. */
  onPlayerCountChange?: (playerCount: number) => void;
}) {
  const [hoveredCard, setHoveredCard] = useState<{ id: CardId; rect: DOMRect } | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<{ bucket: CardBucket; rect: DOMRect } | null>(null);
  const [hoveredLocationsHeader, setHoveredLocationsHeader] = useState<DOMRect | null>(null);
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<CardBucket>>(new Set());
  // Collapsed by default, unlike the card buckets -- center effects are secondary
  // reference info, not something a new player needs open by default.
  const [locationsCollapsed, setLocationsCollapsed] = useState(true);

  function toggleBucket(bucket: CardBucket) {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }

  if (collapsed) return null;

  return (
    <aside className="w-full shrink-0 overflow-x-hidden lg:sticky lg:top-8 lg:w-48 lg:self-start lg:border-r-2 lg:border-zinc-400 lg:pr-4 dark:lg:border-zinc-600">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1 text-sm font-semibold">
          Card catalog{" "}
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
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1">
          <span className={`h-2 w-2 shrink-0 rounded-full ${myDotColorClass}`} /> My Cards
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" /> Cards on Board
        </span>
      </div>
      <div className="flex flex-col gap-4 overflow-x-hidden lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        {BUCKET_ORDER.map((bucket) => {
          // "Unknown" is a synthetic placeholder for AI evaluation, not a real playable
          // card -- see the CardId union in types.ts -- so it never belongs in a
          // player-facing card reference. A card `disabled` at every player count
          // (as opposed to merely 0 copies at *this* player count, which still shows
          // as "x0 in deck" below) isn't currently in the game at all, so it's hidden
          // outright rather than just grayed out.
          // Sorted by deck copy count at this player count, descending -- ties (including
          // every card if none has a valueModifier-driven count spread) fall back to
          // Array.prototype.sort's guaranteed stability, which preserves ALL_CARD_IDS'
          // order, i.e. CARD_DEFS' own declaration order in cards.ts. So reordering two
          // same-count cards in the catalog is just reordering their entries there.
          const ids = ALL_CARD_IDS.filter((id) => id !== "Unknown" && !CARD_DEFS[id].disabled && CARD_DEFS[id].bucket === bucket).sort(
            (a, b) => copiesForPlayerCount(CARD_DEFS[b], playerCount) - copiesForPlayerCount(CARD_DEFS[a], playerCount)
          );
          const bucketCollapsed = collapsedBuckets.has(bucket);
          return (
            <div key={bucket}>
              <div className="relative mb-1.5">
                <button
                  onClick={() => toggleBucket(bucket)}
                  onMouseEnter={(e) => setHoveredBucket({ bucket, rect: e.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setHoveredBucket((prev) => (prev?.bucket === bucket ? null : prev))}
                  className="flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <span className="inline-block w-3 shrink-0">{bucketCollapsed ? "▶" : "▼"}</span>
                  {bucket}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[9px] normal-case text-zinc-400 dark:border-zinc-500 dark:text-zinc-500">
                    i
                  </span>
                </button>
                {hoveredBucket?.bucket === bucket && (
                  <FixedTooltip rect={hoveredBucket.rect}>{BUCKET_DESCRIPTIONS[bucket]}</FixedTooltip>
                )}
              </div>
              {!bucketCollapsed && (
                <div className="flex flex-col gap-1.5">
                  {ids.map((id) => {
                    const def = CARD_DEFS[id];
                    const copies = copiesForPlayerCount(def, playerCount);
                    const mine = myCardIds.has(id);
                    const onOpponentBoard = opponentVisibleBoardCardIds.has(id);
                    const boxToneClass =
                      copies === 0
                        ? "border-zinc-200 opacity-50 dark:border-zinc-800"
                        : mine
                          ? myAccentClass
                          : onOpponentBoard
                            ? "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                            : "border-zinc-300 dark:border-zinc-700";
                    // Tooltip position anchors to the small 64px swatch box (this
                    // row's first child), not the whole row -- the row itself
                    // stretches to the sidebar's full width (nearly the whole phone
                    // screen on mobile), which was pushing the tooltip's computed
                    // position way off to one side instead of sitting predictably
                    // next to the actual card art.
                    function anchorRect(row: HTMLElement): DOMRect {
                      return (row.firstElementChild as HTMLElement | null)?.getBoundingClientRect() ?? row.getBoundingClientRect();
                    }
                    return (
                      <div
                        key={id}
                        className="relative flex min-w-0 items-center gap-2"
                        onMouseEnter={(e) => setHoveredCard({ id, rect: anchorRect(e.currentTarget) })}
                        onMouseLeave={() => setHoveredCard((prev) => (prev?.id === id ? null : prev))}
                        // Touch devices have no hover -- tap toggles the same tooltip
                        // a mouse would get from hovering, so mobile can still read a
                        // card's full description, not just the (now 2-line) summary.
                        // The rect is read synchronously here, not inside the setState
                        // updater below -- a native event's `currentTarget` is only
                        // valid during the event's own dispatch, so reading it lazily
                        // inside a deferred updater callback can hit a null target.
                        onClick={(e) => {
                          const rect = anchorRect(e.currentTarget);
                          setHoveredCard((prev) => (prev?.id === id ? null : { id, rect }));
                        }}
                      >
                        <div
                          className={`relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${boxToneClass}`}
                        >
                          <span className="text-[8px] font-semibold leading-tight break-words">{def.name}</span>
                          <CardArt cardId={id} className="h-5 w-5 shrink-0" />
                          <span className="text-base font-bold leading-none">{def.base}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {def.name} <span className="text-zinc-500 dark:text-zinc-400">×{copies}</span>
                          </div>
                          <div className="line-clamp-2 text-[10px] text-zinc-500 dark:text-zinc-400">{def.text}</div>
                        </div>
                        {hoveredCard?.id === id && <FixedTooltip rect={hoveredCard.rect}>{def.fullText}</FixedTooltip>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div className="relative">
          <button
            onClick={() => setLocationsCollapsed((prev) => !prev)}
            onMouseEnter={(e) => setHoveredLocationsHeader(e.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setHoveredLocationsHeader(null)}
            className="flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <span className="inline-block w-3 shrink-0">{locationsCollapsed ? "▶" : "▼"}</span>
            Locations
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[9px] normal-case text-zinc-400 dark:border-zinc-500 dark:text-zinc-500">
              i
            </span>
          </button>
          {hoveredLocationsHeader && <FixedTooltip rect={hoveredLocationsHeader}>{LOCATIONS_DESCRIPTION}</FixedTooltip>}
          {!locationsCollapsed && (
            <div className="mt-1.5 flex flex-col gap-2">
              {LOCATION_COMPLEXITY_ORDER
                // A location `disabled` outright isn't currently in the game at all
                // (as opposed to merely restricted to some player counts, which still
                // shows grayed out with its "Np+ only" restriction below), so it's
                // hidden rather than sorted to the bottom.
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
                  return (
                    <div
                      key={id}
                      className={`rounded-md border p-1.5 ${
                        isCurrent
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                          : available
                            ? "border-zinc-300 dark:border-zinc-700"
                            : "border-zinc-200 opacity-50 dark:border-zinc-800"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-medium">{def.label}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{description}</div>
                      {restriction && <div className="mt-0.5 text-[9px] text-zinc-400 dark:text-zinc-500">{restriction}</div>}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
