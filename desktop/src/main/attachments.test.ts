import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_MIME_TYPES,
  INLINE_STORAGE_THRESHOLD_BYTES,
  MAX_ATTACHMENT_BYTES,
  shouldStoreInline,
  validateAttachmentInput,
  type AttachmentInput,
} from './attachments'

const validBase = (): AttachmentInput => ({
  kind: 'image',
  mime: 'image/png',
  base64: 'aGVsbG8=',
  byteSize: 5,
  originalName: 'tiny.png',
})

describe('validateAttachmentInput', () => {
  it('accepts a small PNG with allowed mime', () => {
    expect(validateAttachmentInput(validBase())).toEqual({ ok: true })
  })

  it('accepts every allowed mime type', () => {
    for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
      const result = validateAttachmentInput({ ...validBase(), mime })
      expect(result, `should accept ${mime}`).toEqual({ ok: true })
    }
  })

  it('rejects non-image kinds', () => {
    const result = validateAttachmentInput({
      ...validBase(),
      kind: 'video' as unknown as 'image',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/image/i)
  })

  it('rejects disallowed mime types (gif, pdf, plain text)', () => {
    for (const mime of ['image/gif', 'application/pdf', 'text/plain']) {
      const result = validateAttachmentInput({ ...validBase(), mime })
      expect(result.ok, `should reject ${mime}`).toBe(false)
    }
  })

  it('rejects empty payloads', () => {
    const result = validateAttachmentInput({ ...validBase(), base64: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects zero or negative byte sizes', () => {
    expect(validateAttachmentInput({ ...validBase(), byteSize: 0 }).ok).toBe(false)
    expect(validateAttachmentInput({ ...validBase(), byteSize: -1 }).ok).toBe(false)
  })

  it('rejects files exceeding the 10MB cap', () => {
    const over = MAX_ATTACHMENT_BYTES + 1
    const result = validateAttachmentInput({ ...validBase(), byteSize: over })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too large/i)
  })

  it('accepts files at exactly the 10MB cap', () => {
    const result = validateAttachmentInput({ ...validBase(), byteSize: MAX_ATTACHMENT_BYTES })
    expect(result.ok).toBe(true)
  })
})

describe('shouldStoreInline', () => {
  it('keeps tiny payloads inline', () => {
    expect(shouldStoreInline(1024)).toBe(true)
  })

  it('keeps payloads at the threshold inline', () => {
    expect(shouldStoreInline(INLINE_STORAGE_THRESHOLD_BYTES)).toBe(true)
  })

  it('spills payloads over the threshold to disk', () => {
    expect(shouldStoreInline(INLINE_STORAGE_THRESHOLD_BYTES + 1)).toBe(false)
  })
})
