"use client";

import type { FrameworkFilter as Filter } from "@/components/chat/use-chat";
import { FRAMEWORK_IDS, FRAMEWORK_NAMES } from "@/lib/frameworks";

const OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  ...FRAMEWORK_IDS.map((id) => ({ value: id, label: FRAMEWORK_NAMES[id] })),
];

/** Segmented control. "All" lets the server detect frameworks from each question. */
export function FrameworkFilter({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (value: Filter) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Search in"
      className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900"
    >
      {OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
              selected
                ? "bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
