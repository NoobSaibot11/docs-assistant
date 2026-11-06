import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the pg driver and Prisma adapter out of the bundle; they're loaded from node_modules.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};

export default nextConfig;
