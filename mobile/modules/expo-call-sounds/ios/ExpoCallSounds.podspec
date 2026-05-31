Pod::Spec.new do |s|
  s.name           = 'ExpoCallSounds'
  s.version        = '1.0.0'
  s.summary        = 'Bundled call sound effects (join, end, thinking) played via AVAudioPlayer'
  s.description    = 'Tiny Expo module that plays the bundled wav files used during voice calls'
  s.author         = 'VoiceClaw'
  s.homepage       = 'https://github.com/yagudaev/voiceclaw'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '*.swift'
  s.resources = '*.wav'
end
