// Clients cap how many search results they show (VidHub asks for 24), and the
// merged list puts every movie before any series, so an exact title match could
// fall off the end behind two dozen looser movie matches. Rank by how well the
// title matches, keeping the existing order within each rank.

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Any Unicode letter or digit is kept, not just a-z0-9, so a Thai or
    // Cyrillic or CJK title does not shrink to the one Latin word it happens
    // to contain and become a false exact match against that word alone.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
}

// 0 the title is the term, 1 the title starts with it as a word, 2 the term is
// one of the title's words, 3 anything looser.
function matchRank(title: string, term: string): number {
  if (!term) return 3
  if (title === term) return 0
  if (title.startsWith(`${term} `)) return 1
  if (` ${title} `.includes(` ${term} `)) return 2
  return 3
}

// A title found by its original name, as a French or Romanian term finds it,
// ranks by that name when it matches better than the English one.
export function rankSearchResults<T extends Record<string, unknown>>(items: T[], searchTerm: string): T[] {
  const term = normalizeTitle(searchTerm)
  const rankOf = (item: T) => Math.min(
    matchRank(normalizeTitle(String(item.Name ?? '')), term),
    item.OriginalTitle ? matchRank(normalizeTitle(String(item.OriginalTitle)), term) : 3,
  )
  return items
    .map((item, position) => ({ item, position, rank: rankOf(item) }))
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .map(entry => entry.item)
}
