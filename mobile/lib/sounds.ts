import ExpoCallSoundsModule from '@/modules/expo-call-sounds'
import { useCallback, useRef } from 'react'

export function useCallSounds() {
  const thinkingActive = useRef(false)

  const playJoin = useCallback(() => {
    ExpoCallSoundsModule.playSound('call-join', 0.4)
  }, [])

  const playEnd = useCallback(() => {
    ExpoCallSoundsModule.playSound('call-end', 0.3)
  }, [])

  const startThinking = useCallback(() => {
    if (thinkingActive.current) return
    thinkingActive.current = true
    ExpoCallSoundsModule.playSound('thinking', 0.15, true)
  }, [])

  const stopThinking = useCallback(() => {
    if (!thinkingActive.current) return
    thinkingActive.current = false
    ExpoCallSoundsModule.stopSound()
  }, [])

  return { playJoin, playEnd, startThinking, stopThinking }
}
