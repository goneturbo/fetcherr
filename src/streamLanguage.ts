const ENGLISH_AUDIO_MARKER_RE = /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\beng\b|\baudio[: ._-]*eng(?:lish)?\b|\u{1F1EC}\u{1F1E7}/u

const NON_ENGLISH_AUDIO_MARKERS: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\bdubbing\s*pl\b|\bpolish\b|\bpolski\b|\blektor\b|\u{1F1F5}\u{1F1F1}/u, penalty: 4 },
  { pattern: /\btruefrench\b|\bfrench\b|\bvff\b|\bvfq\b|\bmulti[ ._-]?vf\b|\u{1F1EB}\u{1F1F7}/u, penalty: 4 },
  { pattern: /\brus\b|\brussian\b|\u{1F1F7}\u{1F1FA}/u, penalty: 2 },
  { pattern: /\bukr\b|\bukrainian\b|\u{1F1FA}\u{1F1E6}/u, penalty: 2 },
  { pattern: /\bita\b|\bitalian\b|\u{1F1EE}\u{1F1F9}/u, penalty: 2 },
  { pattern: /\besp\b|\bspa\b|\bspanish\b|\bespanol\b|\bespañol\b|\bcastellano\b|\blatino\b|\blatam\b|\u{1F1EA}\u{1F1F8}/u, penalty: 2 },
  { pattern: /\bhindi\b|\bhin\b|\btamil\b|\btelugu\b|\bkannada\b|\bmalayalam\b|\u{1F1EE}\u{1F1F3}/u, penalty: 2 },
  { pattern: /\bslosinh\b|\bslovenian\b|\bslo\b|\bslv\b|\bczech\b|\bcze\b|\bces\b|\bhungarian\b|\bhun\b|\bslovak\b|\bslk\b|\bsvk\b|\bpol\b|\bserbian\b|\bsrp\b|\bcroatian\b|\bcro\b|\bhrv\b|\bbulgarian\b|\bbul\b|\bromanian\b|\bron\b|\brou\b|\u{1F1F8}\u{1F1EE}|\u{1F1E8}\u{1F1FF}|\u{1F1ED}\u{1F1FA}|\u{1F1F8}\u{1F1F0}|\u{1F1F7}\u{1F1F8}|\u{1F1ED}\u{1F1F7}|\u{1F1E7}\u{1F1EC}|\u{1F1F7}\u{1F1F4}/u, penalty: 2 },
  { pattern: /\bturkish\b|\btur\b|\bgreek\b|\bgre\b|\bgerman\b|\bger\b|\bdeutsch\b|\bdeu\b|\bdutch\b|\bnld\b|\u{1F1F9}\u{1F1F7}|\u{1F1EC}\u{1F1F7}|\u{1F1E9}\u{1F1EA}|\u{1F1F3}\u{1F1F1}/u, penalty: 2 },
  { pattern: /\bdanish\b|\bfinnish\b|\bicelandic\b|\bisl\b|\bswedish\b|\bswe\b|\bnorwegian\b|\bnor\b|\u{1F1E9}\u{1F1F0}|\u{1F1EB}\u{1F1EE}|\u{1F1F8}\u{1F1EA}|\u{1F1F3}\u{1F1F4}/u, penalty: 2 },
  { pattern: /\bjapanese\b|\bjpn\b|\bkorean\b|\bkor\b|\bmandarin\b|\bcantonese\b|\bchinese\b|\bchs\b|\bcht\b|\bzhs\b|\bzht\b|\bzho\b|\bthai\b|\btha\b|\bindonesian\b|\bindo\b|\bvietnamese\b|\bvie\b|\btagalog\b|\bfilipino\b|\u{1F1E8}\u{1F1F3}|\u{1F1F9}\u{1F1FC}|\u{1F1EF}\u{1F1F5}|\u{1F1F0}\u{1F1F7}|\u{1F1F9}\u{1F1ED}|\u{1F1FB}\u{1F1F3}|\u{1F1EE}\u{1F1E9}/u, penalty: 2 },
  { pattern: /\barabic\b|\bara\b|\bhebrew\b|\bheb\b|\bfarsi\b|\bpersian\b|\u{1F1F8}\u{1F1E6}|\u{1F1E6}\u{1F1EA}|\u{1F1EE}\u{1F1F1}|\u{1F1EE}\u{1F1F7}/u, penalty: 2 },
  { pattern: /\bportuguese\b|\bportugues\b|\bpor\b|\bpt[ ._-]?br\b|\bdublado\b|\bdublagem\b|\u{1F1F5}\u{1F1F9}|\u{1F1E7}\u{1F1F7}/u, penalty: 2 },
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
