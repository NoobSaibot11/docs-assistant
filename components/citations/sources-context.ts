"use client";

import { createContext, useContext } from "react";

import type { Source } from "@/lib/chat/protocol";

/** The numbered sources of the answer being rendered, so [n] markers can look up their chunk. */
export const SourcesContext = createContext<readonly Source[]>([]);

export function useSource(n: number): Source | undefined {
  return useContext(SourcesContext)[n - 1];
}
