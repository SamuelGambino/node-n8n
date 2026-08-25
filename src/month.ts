import type { Month } from "./types.js";

/**
 * Возвращает календарную дату запуска в часовом поясе UTC+02:00.
 * Исторический срез старого report.csv не должен зависеть от этой даты;
 * она нужна только для отметки о формировании нового выходного отчёта.
 */
export function currentReportDate(now: Date = new Date()): Month {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Etc/GMT-2",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  const year = valueByType.get("year");
  const month = valueByType.get("month");
  const day = valueByType.get("day");

  if (!year || !month || !day) {
    throw new Error("Не удалось определить текущую дату для отчёта.");
  }
  return `${year}-${month}-${day}` as Month;
}

/** Сдвигает нормализованный месяц YYYY-MM-01 на заданное число календарных месяцев. */
export function addMonths(month: Month, offset: number): Month {
  const [yearValue, monthValue] = month.split("-");
  const year = Number(yearValue);
  const monthIndex = Number(monthValue) - 1;
  const date = new Date(Date.UTC(year, monthIndex + offset, 1));

  const resolvedYear = date.getUTCFullYear();
  const resolvedMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${resolvedYear}-${resolvedMonth}-01` as Month;
}

/** Проверяет календарную непрерывность двух месяцев без привязки к суммам отгрузки. */
export function isNextMonth(previous: Month, current: Month): boolean {
  return addMonths(previous, 1) === current;
}

/** Включительная проверка принадлежности месяца границам периода или флайта. */
export function isMonthInRange(month: Month, start: Month, end: Month): boolean {
  return month >= start && month <= end;
}
