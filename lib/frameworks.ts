/** Framework ids shared by ingestion, retrieval, the UI filter and the eval set. */
export const FRAMEWORK_IDS = ["react-native", "nextjs", "angular", "jest"] as const;

export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const RETRIEVAL_MODES = ["vector", "keyword", "hybrid"] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
