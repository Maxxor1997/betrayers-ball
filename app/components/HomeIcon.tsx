/** Small stroke icon, 16x16, currentColor -- distinguishes the Home link from the (icon-less) action buttons next to it, e.g. the "Cards" toggle. Shared by every page with a game header (single-player, multiplayer join, multiplayer host display). */
export function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0">
      <path d="M2 7.5L8 2.5L14 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 6.5V13.5H12.5V6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
