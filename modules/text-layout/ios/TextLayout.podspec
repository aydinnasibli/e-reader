Pod::Spec.new do |s|
  s.name           = 'TextLayout'
  s.version        = '1.0.0'
  s.summary        = 'Where a text view draws its characters'
  s.description    = 'Reads the line and caret positions of a React Native paragraph as TextKit draws it.'
  s.license        = 'UNLICENSED'
  s.author         = 'Nec e-book reader'
  s.homepage       = 'https://github.com/aydinnasibli/e-reader'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/aydinnasibli/e-reader.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
