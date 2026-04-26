const ENGLISH_AUDIO_MARKER_RE = /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\beng\b|\baudio[: ._-]*eng(?:lish)?\b|\u{1F1EC}\u{1F1E7}/u

const NON_ENGLISH_AUDIO_MARKERS: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\bdubbing\s*pl\b|\bpolish\b|\bpolski\b|\blektor\b|\u{1F1F5}\u{1F1F1}/u, penalty: 4 },
  { pattern: /\btruefrench\b|\bfrench\b|\u{1F1EB}\u{1F1F7}/u, penalty: 4 },
  { pattern: /\brus\b|\brussian\b|\u{1F1F7}\u{1F1FA}/u, penalty: 2 },
  { pattern: /\bukr\b|\bukrainian\b|\u{1F1FA}\u{1F1E6}/u, penalty: 2 },
  { pattern: /\bita\b|\bitalian\b|\u{1F1EE}\u{1F1F9}/u, penalty: 2 },
  { pattern: /\besp\b|\bspanish\b|\u{1F1EA}\u{1F1F8}/u, penalty: 2 },
  { pattern: /\bhindi\b|\bhin\b|\btamil\b|\btelugu\b|\bkannada\b|\bmalayalam\b|\u{1F1EE}\u{1F1F3}/u, penalty: 2 },
  { pattern: /\bslosinh\b|\bslovenian\b|\bslo\b|\bczech\b|\bcze\b|\bhungarian\b|\bhun\b|\bturkish\b|\btur\b|\bgreek\b|\bgerman\b|\bger\b|\bdutch\b|\bnld\b|\bswedish\b|\bswe\b|\bnorwegian\b|\bnor\b|\bserbian\b|\bcroatian\b|\bbulgarian\b|\bromanian\b|\bslovak\b|\bportuguese\b|\bpor\b/, penalty: 2 },
]

export function hasEnglishAudioMarker(text: string): boolean {
  return ENGLISH_AUDIO_MARKER_RE.test(text)
}

export function hasNonEnglishAudioMarker(text: string): boolean {
  return NON_ENGLISH_AUDIO_MARKERS.some(marker => marker.pattern.test(text))
}

export function nonEnglishAudioPenalty(text: string): number {
  return NON_ENGLISH_AUDIO_MARKERS.reduce(
    (penalty, marker) => penalty + (marker.pattern.test(text) ? marker.penalty : 0),
    0,
  )
}
