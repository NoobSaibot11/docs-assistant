import { FRAMEWORK_NAMES, type FrameworkId } from "@/lib/frameworks";

const STYLES: Record<FrameworkId, string> = {
  "react-native": "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  nextjs: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  angular: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  jest: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};

export function FrameworkBadge({ framework }: { framework: FrameworkId }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${STYLES[framework]}`}
    >
      {FRAMEWORK_NAMES[framework]}
    </span>
  );
}
