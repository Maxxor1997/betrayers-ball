import { useEffect, useRef, useState } from "react";

/**
 * Collapse/expand state that starts at `shouldCollapse`'s current value and re-applies
 * collapse exactly once if `shouldCollapse` later flips true (e.g. a deferred
 * mobile-viewport check resolving post-mount on a page with no earlier gate to run it
 * behind) -- never fights a manual toggle after that, from either direction.
 */
export function useDefaultCollapsed(shouldCollapse: boolean): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(shouldCollapse);
  const appliedRef = useRef(shouldCollapse);

  useEffect(() => {
    if (shouldCollapse && !appliedRef.current) {
      setCollapsedState(true);
      appliedRef.current = true;
    }
  }, [shouldCollapse]);

  function setCollapsed(next: boolean) {
    appliedRef.current = true;
    setCollapsedState(next);
  }

  return [collapsed, setCollapsed];
}
