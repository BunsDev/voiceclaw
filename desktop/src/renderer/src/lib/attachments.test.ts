import { describe, expect, it } from 'vitest'
import { ALLOWED_IMAGE_MIMES, MAX_ATTACHMENT_BYTES, isAllowedImageMime } from './attachments'

describe('isAllowedImageMime', () => {
  it('accepts the whitelisted image mimes', () => {
    for (const mime of ALLOWED_IMAGE_MIMES) {
      expect(isAllowedImageMime(mime)).toBe(true)
    }
  })

  it('rejects unrelated mimes', () => {
    for (const mime of ['image/gif', 'application/pdf', 'text/plain', '']) {
      expect(isAllowedImageMime(mime)).toBe(false)
    }
  })
})

describe('attachment limits', () => {
  it('exposes a 10MB ceiling', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024)
  })
})
