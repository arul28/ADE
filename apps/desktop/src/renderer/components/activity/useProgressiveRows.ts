import { useCallback, useMemo, useState } from "react";

const INITIAL_ROW_BUDGET = 60;
const ROW_BUDGET_STEP = 60;

/** Keep long Activity columns cheap while exposing the next bounded page. */
export function useProgressiveRows<T>(rows: readonly T[]) {
  const [budget, setBudget] = useState(INITIAL_ROW_BUDGET);
  const visibleRows = useMemo(() => rows.slice(0, budget), [budget, rows]);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);
  const nextCount = Math.min(hiddenCount, ROW_BUDGET_STEP);
  const showMore = useCallback(() => {
    setBudget((value) => value + ROW_BUDGET_STEP);
  }, []);
  return { visibleRows, hiddenCount, nextCount, showMore };
}
