import type { Month } from "./types.js";

export function addMonths(month: Month, offset: number): Month {
  const [yearValue, monthValue] = month.split("-");
  const year = Number(yearValue);
  const monthIndex = Number(monthValue) - 1;
  const date = new Date(Date.UTC(year, monthIndex + offset, 1));

  const resolvedYear = date.getUTCFullYear();
  const resolvedMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${resolvedYear}-${resolvedMonth}-01` as Month;
}

export function isNextMonth(previous: Month, current: Month): boolean {
  return addMonths(previous, 1) === current;
}

export function isMonthInRange(month: Month, start: Month, end: Month): boolean {
  return month >= start && month <= end;
}
