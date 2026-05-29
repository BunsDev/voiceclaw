// Typed wrapper around the Electron IPC bridge for database operations.
// Mirrors the mobile app's DB API (mobile/db/index.ts) so the same
// patterns work in both clients.

export type Conversation = {
  id: number
  title: string
  created_at: number
  updated_at: number
}

export type ConversationWithPreview = Conversation & {
  preview: string | null
  message_count: number
}

export type Message = {
  id: number
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: number
  stt_latency_ms: number | null
  llm_latency_ms: number | null
  tts_latency_ms: number | null
  stt_provider: string | null
  llm_provider: string | null
  tts_provider: string | null
}

export type AttachmentKind = 'image'
export type AttachmentStorage = 'inline' | 'file'

export type AttachmentInput = {
  kind: AttachmentKind
  mime: string
  base64: string
  byteSize: number
  width?: number | null
  height?: number | null
  originalName?: string | null
}

export type Attachment = {
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

export type PickImageResult =
  | {
      ok: true
      file: { base64: string; byteSize: number; mime: string; originalName: string | null }
    }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

export type LatencyData = {
  sttLatencyMs?: number
  llmLatencyMs?: number
  ttsLatencyMs?: number
}

export type ProviderInfo = {
  sttProvider?: string
  llmProvider?: string
  ttsProvider?: string
}

export type UpdateState = {
  currentVersion: string
  stagedVersion: string | null
  lastChecked: number | null
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'up-to-date' | 'error'
  releaseNotes: string | null
  error: string | null
}

declare global {
  interface Window {
    electronAPI: {
      platform: string
      diagnostics?: {
        export: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>
      }
      db: {
        createConversation: (title?: string) => Promise<Conversation>
        getLatestConversation: () => Promise<Conversation | null>
        getConversations: () => Promise<Conversation[]>
        getConversationsWithPreview: () => Promise<ConversationWithPreview[]>
        getConversation: (id: number) => Promise<Conversation | null>
        deleteConversation: (id: number) => Promise<void>
        updateConversationTitle: (id: number, title: string) => Promise<void>
        deleteAllConversations: () => Promise<void>
        addMessage: (
          conversationId: number,
          role: string,
          content: string,
          latency?: LatencyData,
          providers?: ProviderInfo,
        ) => Promise<Message>
        getMessages: (conversationId: number) => Promise<Message[]>
        deleteMessage: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>
        attachToMessage: (
          messageId: number,
          input: AttachmentInput,
        ) => Promise<
          { ok: true; attachment: Attachment } | { ok: false; error: string }
        >
        getAttachmentsForMessage: (messageId: number) => Promise<Attachment[]>
        getAttachmentsForConversation: (conversationId: number) => Promise<Attachment[]>
        getSetting: (key: string) => Promise<string | null>
        setSetting: (key: string, value: string) => Promise<void>
        getAllSettings: () => Promise<Record<string, string>>
      }
      logs: {
        reveal: () => Promise<{ ok: boolean, path: string }>
      }
      net: {
        healthCheck: (url: string) => Promise<{ ok: boolean, error?: string }>
      }
      attachments?: {
        pickImage: () => Promise<PickImageResult>
      }
      updates: {
        getState: () => Promise<UpdateState>
        checkNow: () => Promise<UpdateState>
        installNow: (source: 'banner' | 'settings' | 'tray') => Promise<void>
        onStateChanged: (handler: (state: UpdateState) => void) => () => void
        onStaged: (handler: (payload: { version: string; releaseNotes: string | null }) => void) => () => void
      }
      devices?: {
        create: (label: string) => Promise<DeviceCreateResult>
        list: () => Promise<DeviceListRow[]>
        revoke: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
        rename: (
          id: string,
          label: string,
        ) => Promise<{ ok: true } | { ok: false; error: string }>
        remove: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
      }
    }
  }
}

export type DevicePairPayload = {
  v: 1
  url: string
  token: string
  label: string
}

export type DeviceCreateResult =
  | {
      ok: true
      id: string
      label: string
      payload: DevicePairPayload
      plaintext: string
      hasNetwork: boolean
    }
  | { ok: false; error: string }

export type DeviceListRow = {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  revoked: boolean
}

const api = () => window.electronAPI.db

export async function createConversation(title?: string): Promise<Conversation> {
  return api().createConversation(title)
}

export async function getLatestConversation(): Promise<Conversation | null> {
  return api().getLatestConversation()
}

export async function getConversations(): Promise<Conversation[]> {
  return api().getConversations()
}

export async function getConversationsWithPreview(): Promise<ConversationWithPreview[]> {
  return api().getConversationsWithPreview()
}

export async function getConversation(id: number): Promise<Conversation | null> {
  return api().getConversation(id)
}

export async function deleteConversation(id: number): Promise<void> {
  return api().deleteConversation(id)
}

export async function updateConversationTitle(id: number, title: string): Promise<void> {
  return api().updateConversationTitle(id, title)
}

export async function deleteAllConversations(): Promise<void> {
  return api().deleteAllConversations()
}

export async function addMessage(
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  latency?: LatencyData,
  providers?: ProviderInfo,
): Promise<Message> {
  return api().addMessage(conversationId, role, content, latency, providers)
}

export async function getMessages(conversationId: number): Promise<Message[]> {
  return api().getMessages(conversationId)
}

export async function deleteMessage(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return api().deleteMessage(id)
}

export async function attachToMessage(
  messageId: number,
  input: AttachmentInput,
): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }> {
  return api().attachToMessage(messageId, input)
}

export async function getAttachmentsForMessage(messageId: number): Promise<Attachment[]> {
  return api().getAttachmentsForMessage(messageId)
}

export async function getAttachmentsForConversation(
  conversationId: number,
): Promise<Attachment[]> {
  return api().getAttachmentsForConversation(conversationId)
}

export async function pickImageAttachment(): Promise<PickImageResult> {
  const api = window.electronAPI.attachments
  if (!api) return { ok: false, error: 'Attachment picker unavailable' }
  return api.pickImage()
}

export function attachmentDataUrl(attachment: Attachment): string | null {
  if (attachment.data) return `data:${attachment.mime};base64,${attachment.data}`
  return null
}

export async function getSetting(key: string): Promise<string | null> {
  return api().getSetting(key)
}

export async function setSetting(key: string, value: string): Promise<void> {
  return api().setSetting(key, value)
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return api().getAllSettings()
}
