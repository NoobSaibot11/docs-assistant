"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { FrameworkBadge } from "@/components/citations/framework-badge";
import type { Source } from "@/lib/chat/protocol";

const MARGIN = 8;
const WIDTH = 320;

interface Position {
  top: number;
  left: number;
  width: number;
}

/** Below the anchor if it fits, otherwise above; always inside the viewport. */
function place(anchor: DOMRect, panelHeight: number): Position {
  const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
  const left = Math.min(
    Math.max(MARGIN, anchor.left + anchor.width / 2 - width / 2),
    window.innerWidth - width - MARGIN,
  );
  const below = anchor.bottom + 6;
  const fitsBelow = below + panelHeight <= window.innerHeight - MARGIN;
  const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - 6 - panelHeight);
  return { top, left, width };
}

/**
 * The citation popover: framework, title, heading path, excerpt and a link to the exact section.
 * Rendered in a portal with fixed positioning, so it isn't clipped by the message layout.
 */
export function SourcePopover({
  id,
  source,
  anchorRef,
  onClose,
}: {
  id: string;
  source: Source;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: (returnFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (anchor && panel) setPosition(place(anchor.getBoundingClientRect(), panel.offsetHeight));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={`Source ${source.n}: ${source.title}`}
      className="fixed z-50 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      style={
        position
          ? { top: position.top, left: position.left, width: position.width }
          : { top: 0, left: 0, width: WIDTH, visibility: "hidden" }
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zinc-500 tabular-nums">[{source.n}]</span>
        <FrameworkBadge framework={source.framework} />
        <span className="truncate font-medium">{source.title}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{source.headingPath}</p>
      <p className="mt-2 line-clamp-5 text-xs leading-relaxed whitespace-pre-line text-zinc-700 dark:text-zinc-300">
        {source.excerpt}
      </p>
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-xs font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
      >
        Open in the docs ↗
      </a>
    </div>,
    document.body,
  );
}
