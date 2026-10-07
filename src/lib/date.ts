/**
 * Shared business-date helpers.
 *
 * The shop runs on Beirut time, so every "today" / "last N days" calculation
 * must be anchored to midnight in Asia/Beirut — never to the Node process
 * timezone (`new Date().setHours(0,0,0,0)`), which is UTC on most hosts and
 * would shift the business day by 3 hours (making early-morning orders fall
 * out of "today").
 *
 * Used by both the dashboard and reports endpoints so the two never drift
 * apart again.
 */

export const BUSINESS_TIMEZONE = "Asia/Beirut";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Offset (in ms) between the given timezone and UTC at the given instant. */
export function timeZoneOffsetMs(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, number> = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );

  /*
   * Round the instant down to the second so the returned offset is a whole
   * number of minutes — otherwise the sub-second part of `date` would leak
   * into the boundary and "midnight" would land a few hundred ms late.
   */
  const instant = Math.floor(date.getTime() / 1000) * 1000;

  return asUtc - instant;
}

/**
 * The real UTC instant that corresponds to 00:00 in the given timezone on the
 * day containing `date`. Safe across DST changes because the offset is
 * evaluated at the requested instant.
 */
export function startOfDayInTimeZone(date: Date, timeZone: string) {
  const offset = timeZoneOffsetMs(date, timeZone);
  const shifted = new Date(date.getTime() + offset);

  const midnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );

  return new Date(midnightUtc - offset);
}

/** Start of the business day (Beirut midnight) containing `date`. */
export function startOfBusinessDay(date: Date): Date {
  return startOfDayInTimeZone(date, BUSINESS_TIMEZONE);
}

const dayLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  weekday: "short",
});

/** Weekday label for the business day containing `date`, e.g. "Mon". */
export function businessDayLabel(date: Date): string {
  return dayLabelFormatter.format(date);
}

/** ISO day key (`YYYY-MM-DD`) for the business day containing `date`. */
export const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
});
