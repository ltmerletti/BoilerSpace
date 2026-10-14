// iCalendar (RFC 5545) export. Timed events are written in UTC, so no VTIMEZONE block is needed.

const MAX_LINE_OCTETS = 75;

export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Folds a content line at 75 octets without splitting a UTF-8 character.
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;
  const pieces = [];
  let current = '';
  let currentOctets = 0;
  for (const char of line) {
    const octets = encoder.encode(char).length;
    const limit = pieces.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (currentOctets + octets > limit) {
      pieces.push(current);
      current = '';
      currentOctets = 0;
    }
    current += char;
    currentOctets += octets;
  }
  pieces.push(current);
  return pieces.join('\r\n ');
}

const utcStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (key) => key.replace(/-/g, '');

function nextDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// events: { uid, title, start (ISO) | allDayDate ('YYYY-MM-DD'), end?, description?, url?, location? }
export function buildCalendar(events, { name = 'BoilerSpace', now = new Date() } = {}) {
  const seen = new Set();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BoilerSpace//Course calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const event of events) {
    if (!event.uid || seen.has(event.uid)) continue;
    if (!event.start && !event.allDayDate) continue;
    seen.add(event.uid);
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${utcStamp(now.toISOString())}`);
    if (event.allDayDate) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(event.allDayDate)}`, `DTEND;VALUE=DATE:${dateStamp(nextDayKey(event.allDayDate))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(event.start)}`, `DTEND:${utcStamp(event.end ?? event.start)}`);
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
