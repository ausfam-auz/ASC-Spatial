require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'AscLidarScanner'
  s.version = package['version']
  s.summary = 'Native ARKit LiDAR scanning for ASC Spatial'
  s.description = 'Captures ARKit scene meshes and exports compact PLY scan files.'
  s.license = { :type => 'MIT' }
  s.author = 'ASC Spatial'
  s.homepage = 'https://replit.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/expo/expo.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'AVFoundation'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
