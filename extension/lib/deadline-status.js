import { isValidDate } from './dates.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const QUOTED_YEAR = '(?:(?:\\s*,\\s*|\\s+)(\\d{4}|\\d{2})(?![\\d:]|\\s*(?:am|pm)\\b))?';
const yearOf = (value, fallback) => value ? Number(value) + (value.length === 2 ? 2000 : 0) : fallback;

export function dateIsQuoted(quote, date) {
  if (!isValidDate(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const text = String(quote ?? '').toLowerCase();
  const dates = [];
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  for (const match of text.matchAll(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${QUOTED_YEAR}\\b`, 'g'))) {
    dates.push([yearOf(match[3], year), MONTHS.indexOf(match[1].slice(0, 3)) + 1, Number(match[2])]);
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?${QUOTED_YEAR}\\b`, 'g'))) {
    dates.push([yearOf(match[3], year), MONTHS.indexOf(match[2].slice(0, 3)) + 1, Number(match[1])]);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g)) {
    if (text[match.index + match[0].length] === '/') continue;
    dates.push([yearOf(match[3], year), Number(match[1]), Number(match[2])]);
  }
  return dates.some(value => value[0] === year && value[1] === month && value[2] === day);
}

export function deadlineIssue(deadline) {
  if (deadline.weekdayMismatch || !dateIsQuoted(deadline.quote, deadline.date)) return 'The date and the syllabus wording do not agree.';
  if (deadline.dateDiffers) return 'Brightspace and the syllabus list different dates. Your agenda uses Brightspace.';
  return null;
}
