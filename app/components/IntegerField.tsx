"use client";

import { useEffect, useState } from "react";

/**
 * A controlled numeric input that never forces a literal "0" into the DOM mid-edit.
 * A plain `<input type="number" value={n} onChange={(e) => ... Number(e.target.value)
 * || 0 ...} />` briefly commits 0 as soon as the field is cleared to retype a number,
 * so the very next keystroke appends after that rendered "0" instead of replacing it
 * (e.g. typing "250" ends up as "0250"). This keeps its own local draft string --
 * visually empty mid-edit is fine -- and only clamps/normalizes it back to a valid
 * number on blur.
 */
export function IntegerField({
  id,
  value,
  onChange,
  min,
  max,
  disabled,
  className,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));

  // Resync when `value` changes for a reason other than this field's own typing (e.g.
  // switching strategy resets the whole config object) -- guarded so the normal
  // typing case (value just echoes back what onChange sent up) doesn't stomp on an
  // in-progress edit.
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
      }}
      onBlur={() => {
        const clamped = Math.max(min, Math.min(max, Number(draft) || min));
        setDraft(String(clamped));
        onChange(clamped);
      }}
      className={className}
    />
  );
}
