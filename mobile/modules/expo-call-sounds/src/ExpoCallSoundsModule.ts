import { NativeModule, requireNativeModule } from 'expo'

declare class ExpoCallSoundsModule extends NativeModule {
  playSound(soundName: string, volume: number, loop?: boolean): void
  stopSound(): void
}

export default requireNativeModule<ExpoCallSoundsModule>('ExpoCallSounds')
