import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writes: { path: string; content: string }[] = []
const fileSystem = new Map<string, string>()

vi.mock('fs', () => ({
  existsSync: (path: string) => fileSystem.has(path),
  mkdirSync: () => undefined,
  readFileSync: (path: string) => fileSystem.get(path) ?? '',
  writeFileSync: (path: string, content: string) => {
    writes.push({ path, content })
    fileSystem.set(path, content)
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/voiceclaw-identity-test',
  },
  net: {
    fetch: () => {
      throw new Error('net.fetch not stubbed in this test')
    },
  },
}))

describe('writeAgentIdentity', () => {
  beforeEach(() => {
    writes.length = 0
    fileSystem.clear()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('renders all four required fields with the user-supplied values', async () => {
    const { writeAgentIdentity } = await import('./identity')
    const result = writeAgentIdentity({
      name: 'Pam',
      description: 'Friendly and calm.',
      voice: 'Aoede',
    })
    expect(result.name).toBe('Pam')
    expect(result.description).toBe('Friendly and calm.')
    expect(result.voice).toBe('Aoede')
    expect(writes[0].content).toContain('**Name:** Pam')
    expect(writes[0].content).toContain('**Vibe:** Friendly and calm.')
    expect(writes[0].content).toContain('**Voice:** Aoede')
    expect(writes[0].content).toContain('**Creature:** Personal voice companion')
  })

  it('falls back to defaults when fields are blank', async () => {
    const { writeAgentIdentity, DEFAULT_IDENTITY } = await import('./identity')
    const result = writeAgentIdentity({})
    expect(result.name).toBe(DEFAULT_IDENTITY.name)
    expect(result.description).toBe(DEFAULT_IDENTITY.description)
    expect(result.voice).toBe(DEFAULT_IDENTITY.voice)
    expect(writes[0].content).toContain(`**Name:** ${DEFAULT_IDENTITY.name}`)
  })

  it('trims whitespace and tolerates partial patches', async () => {
    const { writeAgentIdentity, DEFAULT_IDENTITY } = await import('./identity')
    const result = writeAgentIdentity({ name: '  Beatrix  ', voice: 'Kore' })
    expect(result.name).toBe('Beatrix')
    expect(result.voice).toBe('Kore')
    expect(result.description).toBe(DEFAULT_IDENTITY.description)
  })
})

describe('readAgentIdentity', () => {
  beforeEach(() => {
    writes.length = 0
    fileSystem.clear()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns defaults when no IDENTITY.md exists', async () => {
    const { readAgentIdentity, DEFAULT_IDENTITY } = await import('./identity')
    const id = readAgentIdentity()
    expect(id).toEqual(DEFAULT_IDENTITY)
  })

  it('parses Name / Vibe / Voice fields from a written file', async () => {
    const { writeAgentIdentity, readAgentIdentity } = await import('./identity')
    writeAgentIdentity({ name: 'Sage', description: 'Quiet and dry.', voice: 'Charon' })
    const id = readAgentIdentity()
    expect(id.name).toBe('Sage')
    expect(id.description).toBe('Quiet and dry.')
    expect(id.voice).toBe('Charon')
  })
})
