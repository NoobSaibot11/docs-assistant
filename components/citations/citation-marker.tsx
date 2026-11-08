"use client";

import { useCallback, useId, useRef, useState } from "react";

import { SourcePopover } from "@/components/citations/source-popover";
import { useSource } from "@/components/citations/sources-context";

/** A clickable [n] in an answer. Opens the source popover; plain text if the source is unknown. */
export function CitationMarker({ n }: { n: number }) {
  const source = useSource(n);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  if (!source) return <sup>[{n}]</sup>;

  return (
    <sup className="mx-px">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Source ${n}: ${source.title}`}
        data-citation={n}
        onClick={() => setOpen((v) => !v)}
        className="rounded px-0.5 text-[0.7rem] leading-4 font-semibold text-blue-700 tabular-nums hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400 dark:hover:bg-blue-950"
      >
        [{n}]
      </button>
      {open && <SourcePopover id={id} source={source} anchorRef={buttonRef} onClose={close} />}
    </sup>
  );
}
