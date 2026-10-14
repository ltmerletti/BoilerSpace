// Purdue course names look like "Fall 2026 CS 25200-LE1 LEC" with codes like "wl.202620.CS.25200.LE1".

export function shortCourseLabel(course) {
  const fromCode = /\.([A-Z]{2,5})\.(\d{5})\./.exec(course.code ?? '');
  if (fromCode) return `${fromCode[1]} ${fromCode[2]}`;
  const fromName = /\b([A-Z]{2,5})\s?(\d{5})\b/.exec(course.name ?? '');
  if (fromName) return `${fromName[1]} ${fromName[2]}`;
  return course.name;
}

export function courseTitle(course) {
  return (course.name ?? '')
    .replace(/^(Fall|Spring|Summer|Winter)\s+\d{4}\s+/i, '')
    .replace(/\s*-\s*Merge$/i, '')
    .trim();
}
