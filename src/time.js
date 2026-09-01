/**
 * Local-day arithmetic for an arbitrary IANA timezone, using only Intl.
 * Everything in the DB is stored as UTC unix-ms; these helpers convert a
 * "local day" into the UTC range to query, so changing TZ is the only change
 * needed when travelling.
 */

/** Milliseconds that `timeZone` is ahead of UTC at the given instant. */
export function tzOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const f = {};
  for (const { type, value } of parts) f[type] = value;

  // Some ICU builds render midnight as hour "24" under hour12:false.
  const asIfUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    Number(f.hour) % 24,
    Number(f.minute),
    Number(f.second),
  );
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The calendar Y/M/D showing on a wall clock in `timeZone` at `date`. */
export function localYmd(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const f = {};
  for (const { type, value } of parts) f[type] = value;
  return { year: Number(f.year), month: Number(f.month), day: Number(f.day) };
}

/**
 * Resolve a local wall-clock midnight to a UTC timestamp. The offset depends on
 * the instant we are resolving, so we apply it twice: the first pass lands us
 * within an hour of the target, the second uses the offset actually in force
 * there. That converges correctly across DST transitions.
 */
function localMidnightToUtc(timeZone, year, month, day) {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let ts = naive - tzOffsetMs(timeZone, new Date(naive));
  ts = naive - tzOffsetMs(timeZone, new Date(ts));
  return ts;
}

/** UTC [start, end) covering the local calendar day containing `date`. */
export function localDayRange(timeZone, date = new Date()) {
  const { year, month, day } = localYmd(timeZone, date);
  return {
    start: localMidnightToUtc(timeZone, year, month, day),
    // Date.UTC normalises day+1 across month and year boundaries.
    end: localMidnightToUtc(timeZone, year, month, day + 1),
  };
}

/** e.g. "Mon, Sep 1" — for the daily summary header. */
export function formatLocalDate(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** e.g. "7:42 PM" — for per-entry timestamps in /undo confirmations. */
export function formatLocalTime(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
