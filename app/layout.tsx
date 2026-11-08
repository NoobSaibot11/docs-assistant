import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AttributionFooter } from "@/components/attribution-footer";

import "./globals.css";

export const metadata: Metadata = {
  title: "Docs Assistant",
  description: "Cited answers from the React Native, Next.js, Angular and Jest docs.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <div className="flex flex-1 flex-col">{children}</div>
        <AttributionFooter />
      </body>
    </html>
  );
}
