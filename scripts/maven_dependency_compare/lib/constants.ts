export const SERVER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const ROW_KIND_LABELS = {
  parent: "Parent",
  override: "Override",
  direct: "Direct",
  managed: "Managed",
} as const;

export const ROW_KIND_ORDER = {
  parent: 0,
  override: 1,
  managed: 2,
  direct: 3,
} as const;
