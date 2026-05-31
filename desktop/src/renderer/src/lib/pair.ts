// Build the QR-encoded deeplink the desktop hands to a phone. The
// scheme must match the mobile build variant: voiceclaw-dev,
// voiceclaw-staging, or voiceclaw. iOS Camera recognises the URL,
// shows an "Open in VoiceClaw" prompt, and routes to /pair?…
export function buildPairDeeplink(
  scheme: string,
  payload: { url: string; token: string; label: string },
): string {
  const qs = new URLSearchParams({
    url: payload.url,
    token: payload.token,
    label: payload.label,
    v: '1',
  })
  return `${scheme}://pair?${qs.toString()}`
}

export function buildDefaultLabel(now: Date = new Date()): string {
  const stamp = now.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `New device · ${stamp}`
}

export const DEFAULT_MOBILE_SCHEME = 'voiceclaw-staging'

// Wraps the IPC create + revoke flow so the cancel path is testable.
// Returns the created id (caller is responsible for revoke on cancel).
export type DevicesApiLike = {
  create: (label: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  revoke: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

export async function mintAndMaybeRevoke(
  api: DevicesApiLike,
  label: string,
  isStillCurrent: () => boolean,
): Promise<{ ok: true; id: string } | { ok: false; error: string } | { ok: false; cancelled: true }> {
  const result = await api.create(label)
  if (!result.ok) return result
  if (!isStillCurrent()) {
    // Cancelled mid-mint — auto-revoke so we don't leak an orphan row.
    await api.revoke(result.id).catch(() => undefined)
    return { ok: false, cancelled: true }
  }
  return result
}
