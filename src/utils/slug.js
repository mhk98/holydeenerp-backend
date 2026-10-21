/** "Store Keeper (Dhaka)" → "store-keeper-dhaka". Falls back to a timestamp for non-Latin names. */
export function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || `item-${Date.now()}`;
}

/** Soft-deleted rows keep unique columns; free them by suffixing with the id. */
export const retiredValue = (value, id, max = 191) => `${id}.deleted.${value}`.slice(0, max);
