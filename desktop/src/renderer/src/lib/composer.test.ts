import { describe, expect, it } from 'vitest'
import {
  COMPOSER_LIMITS,
  computeTextareaHeight,
  isSubmittable,
  normalizeComposerText,
} from './composer'

describe('normalizeComposerText', () => {
  it('strips trailing spaces', () => {
    expect(normalizeComposerText('hello   ')).toBe('hello')
  })

  it('strips trailing newlines and tabs', () => {
    expect(normalizeComposerText('hello\n\t\n')).toBe('hello')
  })

  it('preserves leading whitespace', () => {
    expect(normalizeComposerText('   indented')).toBe('   indented')
  })

  it('preserves internal whitespace and indentation', () => {
    const code = 'function f() {\n    return 1\n}'
    expect(normalizeComposerText(code + '\n\n')).toBe(code)
  })

  it('preserves URLs verbatim including query strings', () => {
    const url = 'https://example.com/path?foo=bar&baz=1'
    expect(normalizeComposerText(url + ' \n')).toBe(url)
  })

  it('preserves file paths with spaces', () => {
    const path = '/Users/me/Library/Application Support/file.txt'
    expect(normalizeComposerText(path + '   ')).toBe(path)
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeComposerText('   \n\t  ')).toBe('')
  })
})

describe('isSubmittable', () => {
  it('rejects empty input', () => {
    expect(isSubmittable('')).toBe(false)
  })

  it('rejects whitespace-only input', () => {
    expect(isSubmittable('   \n  ')).toBe(false)
  })

  it('accepts a single character', () => {
    expect(isSubmittable('a')).toBe(true)
  })

  it('accepts text with leading whitespace', () => {
    expect(isSubmittable('   hello')).toBe(true)
  })
})

describe('computeTextareaHeight', () => {
  it('uses min rows for empty input', () => {
    const h = computeTextareaHeight('')
    expect(h).toBe(COMPOSER_LIMITS.minRows * COMPOSER_LIMITS.lineHeightPx + COMPOSER_LIMITS.verticalPaddingPx)
  })

  it('grows with newlines up to max rows', () => {
    const six = computeTextareaHeight('a\nb\nc\nd\ne\nf')
    const ten = computeTextareaHeight('a\nb\nc\nd\ne\nf\ng\nh\ni\nj')
    expect(six).toBe(ten)
    expect(six).toBe(COMPOSER_LIMITS.maxRows * COMPOSER_LIMITS.lineHeightPx + COMPOSER_LIMITS.verticalPaddingPx)
  })
})
