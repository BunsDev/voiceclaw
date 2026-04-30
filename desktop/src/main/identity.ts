import { app, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type AgentIdentity = {
  name: string
  description: string
  voice: string
}

export const DEFAULT_IDENTITY: AgentIdentity = {
  name: 'Pam',
  description: 'Friendly, calm, helps me stay on top of things.',
  voice: 'Aoede',
}

export function getWorkspaceDir(): string {
  return join(app.getPath('userData'), 'openclaw', 'workspace')
}

export function getIdentityPath(): string {
  return join(getWorkspaceDir(), 'IDENTITY.md')
}

export function readAgentIdentity(): AgentIdentity {
  const path = getIdentityPath()
  if (!existsSync(path)) return { ...DEFAULT_IDENTITY }
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return { ...DEFAULT_IDENTITY }
  }
  return {
    name: readField(content, 'Name') || DEFAULT_IDENTITY.name,
    description: readField(content, 'Vibe') || DEFAULT_IDENTITY.description,
    voice: readField(content, 'Voice') || DEFAULT_IDENTITY.voice,
  }
}

export function writeAgentIdentity(identity: Partial<AgentIdentity>): AgentIdentity {
  const merged: AgentIdentity = {
    name: identity.name?.trim() || DEFAULT_IDENTITY.name,
    description: identity.description?.trim() || DEFAULT_IDENTITY.description,
    voice: identity.voice?.trim() || DEFAULT_IDENTITY.voice,
  }
  const dir = getWorkspaceDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(getIdentityPath(), renderIdentityMarkdown(merged), { mode: 0o600 })
  return merged
}

export async function speakGreetingPreview(params: {
  apiKey: string
  voice: string
  text: string
}): Promise<{ ok: true; audioBase64: string; mimeType: string } | { ok: false; error: string }> {
  if (!params.apiKey) return { ok: false, error: 'No Gemini key configured.' }
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent'
  try {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: params.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: params.voice },
            },
          },
        },
      }),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      return { ok: false, error: `TTS ${response.status}: ${errText.slice(0, 200)}` }
    }
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]
    }
    const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
    if (!inline?.data) return { ok: false, error: 'TTS response missing audio data.' }
    return {
      ok: true,
      audioBase64: inline.data,
      mimeType: inline.mimeType ?? 'audio/L16;rate=24000',
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'TTS request failed.' }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderIdentityMarkdown(identity: AgentIdentity): string {
  return [
    '# IDENTITY.md - Who Am I?',
    '',
    `- **Name:** ${identity.name}`,
    `- **Creature:** Personal voice companion`,
    `- **Vibe:** ${identity.description}`,
    `- **Voice:** ${identity.voice}`,
    '',
  ].join('\n')
}

function readField(content: string, field: string): string | null {
  const re = new RegExp(`^[-*]\\s*\\*\\*${field}:?\\*\\*\\s*(.+?)\\s*$`, 'mi')
  const match = content.match(re)
  return match ? match[1].trim() : null
}
