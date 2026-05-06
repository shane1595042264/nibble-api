export const MAX_LIST_ROWS = 5000;

interface CapWarnContext {
  entity: string;
  userId?: string;
  scope?: Record<string, unknown>;
}

export function warnIfCapped<T>(rows: T[], context: CapWarnContext): T[] {
  if (rows.length >= MAX_LIST_ROWS) {
    console.warn(
      '[query-cap] result truncated at MAX_LIST_ROWS ' +
        JSON.stringify({
          entity: context.entity,
          userId: context.userId,
          scope: context.scope,
          cap: MAX_LIST_ROWS,
          returned: rows.length,
        }),
    );
  }
  return rows;
}
