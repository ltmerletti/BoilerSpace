// Dates are computed here, never by the model. West Lafayette uses Eastern time.

export const TIME_ZONE = 'America/Indiana/Indianapolis';
const DAY_MS = 86_400_000;

const formatters = new Map();

function partsFormatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return formatters.get(timeZone);
}

function wallParts(instant, timeZone = TIME_ZONE) {
  const formatter = partsFormatter(timeZone);
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

export function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '');
}

// Converts a wall-clock date and time in a time zone to a UTC instant, handling DST.
// Times inside a spring-forward gap move forward by the gap; repeated fall-back times use the first occurrence.
export function zonedToUtc(date, time = '00:00', timeZone = TIME_ZONE) {
  if (!isValidDate(date) || !isValidTime(time)) throw new Error(`Invalid date or time: ${date} ${time}`);
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (instant) => {
    const p = wallParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  const first = target - offsetAt(target);
  const second = target - offsetAt(first);
  const candidates = [first, second].filter((instant) => {
    const p = wallParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === target;
  });
  return new Date(candidates.length ? Math.min(...candidates) : Math.max(first, second)).toISOString();
}

export function dayKey(instant) {
  const p = wallParts(new Date(instant));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function daysBetweenKeys(fromKey, toKey) {
  const toUtc = (key) => Date.UTC(...key.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / DAY_MS);
}

export function daysFromToday(instantOrKey, now = new Date()) {
  const key = isValidDate(instantOrKey) ? instantOrKey : dayKey(instantOrKey);
  return daysBetweenKeys(dayKey(now), key);
}

export function relativeDay(instantOrKey, now = new Date()) {
  const days = daysFromToday(instantOrKey, now);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function formatDateTime(instant, { allDay = false, year = false } = {}) {
  if (!instant) return '';
  return new Date(instant).toLocaleString('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
  });
}

export function formatTime(instant) {
  return new Date(instant).toLocaleString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
}

export function formatDayKey(key, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', ...options });
}

export function addDaysToKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

// A label the model can copy verbatim, with the weekday already computed.
export function dueDisplay(instant, { allDay = false } = {}) {
  if (!instant) return null;
  return allDay ? formatDayKey(isValidDate(instant) ? instant : dayKey(instant), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' (all day)'
    : `${formatDateTime(instant, { year: true })} ET`;
}
