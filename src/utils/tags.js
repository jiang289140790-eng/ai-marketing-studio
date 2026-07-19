export function parseTags(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function formatTags(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}
