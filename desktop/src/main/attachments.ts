import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export type AttachmentKind = 'image'
export type AttachmentStorage = 'inline' | 'file'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const INLINE_STORAGE_THRESHOLD_BYTES = 5 * 1024 * 1024
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number]

export type AttachmentInput = {
  kind: AttachmentKind
  mime: string
  base64: string
  byteSize: number
  width?: number | null
  height?: number | null
  originalName?: string | null
}

export type AttachmentRecord = {
  id: number
  message_id: number
  kind: AttachmentKind
  mime: string
  storage: AttachmentStorage
  data: string | null
  path: string | null
  width: number | null
  height: number | null
  byte_size: number
  original_name: string | null
  created_at: number
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export function validateAttachmentInput(input: AttachmentInput): ValidationResult {
  if (input.kind !== 'image') {
    return { ok: false, error: 'Only image attachments are supported.' }
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(input.mime as AllowedImageMime)) {
    return {
      ok: false,
      error: `Unsupported image type "${input.mime}". Allowed: PNG, JPEG, WEBP.`,
    }
  }
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    return { ok: false, error: 'Attachment is empty.' }
  }
  if (input.byteSize > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `Attachment is too large (${formatBytes(input.byteSize)}). Maximum is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
    }
  }
  if (typeof input.base64 !== 'string' || input.base64.length === 0) {
    return { ok: false, error: 'Attachment payload is missing.' }
  }
  return { ok: true }
}

export function shouldStoreInline(byteSize: number): boolean {
  return byteSize <= INLINE_STORAGE_THRESHOLD_BYTES
}

export function attachmentsDir(userDataPath: string): string {
  return join(userDataPath, 'attachments')
}

export function ensureAttachmentsDir(userDataPath: string): string {
  const dir = attachmentsDir(userDataPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function writeAttachmentToDisk(
  userDataPath: string,
  base64: string,
  mime: string,
): string {
  const dir = ensureAttachmentsDir(userDataPath)
  const ext = extensionForMime(mime)
  const filename = `${randomUUID()}${ext}`
  const fullPath = join(dir, filename)
  writeFileSync(fullPath, Buffer.from(base64, 'base64'))
  return fullPath
}

export function deleteAttachmentFile(path: string | null): void {
  if (!path) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // best-effort — orphan files are not fatal
  }
}

// --- Helpers ---

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    default:
      return '.bin'
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
