import {
  requireNativeModule,
  requireNativeViewManager,
} from 'expo-modules-core';
import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';

let NativeLidarPreview: ComponentType<ViewProps> | null = null;

if (Platform.OS === 'ios') {
  try {
    requireNativeModule('AscLidar');
    NativeLidarPreview = requireNativeViewManager<ViewProps>(
      'AscLidar',
      'Preview',
    );
  } catch {
    // Expo Go and web previews do not include the custom ARKit view.
  }
}

export function LidarPreview(props: ViewProps) {
  if (!NativeLidarPreview) return null;
  const NativeView = NativeLidarPreview;
  return <NativeView {...props} />;
}
