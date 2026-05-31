import ExpoModulesCore
import AVFoundation

public class ExpoCallSoundsModule: Module {
  private var audioPlayer: AVAudioPlayer?

  public func definition() -> ModuleDefinition {
    Name("ExpoCallSounds")

    Function("playSound") { (soundName: String, volume: Float, loop: Bool?) in
      self.playSoundFile(soundName, volume: volume, loop: loop ?? false)
    }

    Function("stopSound") { () in
      self.audioPlayer?.stop()
      self.audioPlayer = nil
    }
  }

  private func playSoundFile(_ name: String, volume: Float, loop: Bool = false) {
    let bundle = Bundle(for: type(of: self))
    let url = bundle.url(forResource: name, withExtension: "wav")
      ?? Bundle.main.url(forResource: name, withExtension: "wav")
    guard let soundUrl = url else {
      print("[ExpoCallSounds] Sound file not found: \(name).wav")
      return
    }
    do {
      audioPlayer = try AVAudioPlayer(contentsOf: soundUrl)
      audioPlayer?.volume = volume
      audioPlayer?.numberOfLoops = loop ? -1 : 0
      audioPlayer?.play()
    } catch {
      print("[ExpoCallSounds] Failed to play sound: \(error)")
    }
  }
}
