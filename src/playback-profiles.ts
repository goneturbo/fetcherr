// These are lightweight list markers. Infuse uses them to discover that an
// item has multiple playable sources, then requests the item detail where the
// real Stremio-backed versions are returned.
export type PlaybackProfileKey =
  | 'probe-a'
  | 'probe-b'

export type PlaybackProfile = {
  key: PlaybackProfileKey
  name: string
  targetHeight?: number
  targetBitrateMbps?: number
}

export const PLAYBACK_PROFILES: readonly PlaybackProfile[] = [
  { key: 'probe-a', name: 'Fetcherr Version Discovery A' },
  { key: 'probe-b', name: 'Fetcherr Version Discovery B' },
]

export function playbackProfileForKey(value: string | undefined): PlaybackProfile | null {
  if (!value) return null
  return PLAYBACK_PROFILES.find(profile => profile.key === value) ?? null
}
