import type { AttachmentInput } from './db'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number]

export type PendingAttachment = {
  id: string
  base64: string
  mime: string
  byteSize: number
  originalName: string | null
  previewUrl: string
}

export function isAllowedImageMime(mime: string): mime is AllowedImageMime {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)
}

export function describeAttachmentRejection(reason: string, fileName?: string): string {
  const target = fileName ? `"${fileName}"` : 'this file'
  return `${target}: ${reason}`
}

export async function fileToPendingAttachment(file: File): Promise<
  { ok: true; pending: PendingAttachment } | { ok: false; error: string }
> {
  if (!isAllowedImageMime(file.type)) {
    return {
      ok: false,
      error: `Unsupported type "${file.type || 'unknown'}". Allowed: PNG, JPG, WEBP.`,
    }
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `File too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
    }
  }
  if (file.size <= 0) {
    return { ok: false, error: 'File is empty.' }
  }
  const buf = await file.arrayBuffer()
  const base64 = arrayBufferToBase64(buf)
  return {
    ok: true,
    pending: {
      id: cryptoRandomId(),
      base64,
      mime: file.type,
      byteSize: file.size,
      originalName: file.name || null,
      previewUrl: `data:${file.type};base64,${base64}`,
    },
  }
}

export function pendingToAttachmentInput(pending: PendingAttachment): AttachmentInput {
  return {
    kind: 'image',
    mime: pending.mime,
    base64: pending.base64,
    byteSize: pending.byteSize,
    originalName: pending.originalName,
  }
}

// --- Helpers ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

function cryptoRandomId(): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
