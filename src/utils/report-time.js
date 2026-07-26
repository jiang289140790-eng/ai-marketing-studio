export function getRelativeDate(offset, timeZone = 'Asia/Shanghai', now = new Date()) {
  return dateKey(new Date(now.getTime() + offset * 86400000), timeZone);
}

export function dateKey(value, timeZone = 'Asia/Shanghai') {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
