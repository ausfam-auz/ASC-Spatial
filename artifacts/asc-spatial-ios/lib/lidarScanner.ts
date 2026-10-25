import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type CameraPermissionStatus =
  | 'authorized'
  | 'notDetermined'
  | 'denied'
  | 'restricted'
  | 'unavailable';

export interface LidarDeviceStatus {
  supported: boolean;
  cameraPermission: CameraPermissionStatus;
  canAskAgain: boolean;
  reason: string;
}

export interface CaptureProgressEvent {
  progress: number;
  meshCount: number;
  elapsedSeconds: number;
}

export interface CompressionProgressEvent {
  progress: number;
  stage: string;
}

export interface CapturedScan {
  uri: string;
  name: string;
  size: number;
  vertexCount: number;
  faceCount: number;
  decimationFactor: number;
}

interface LidarNativeModule {
  getDeviceStatus(): LidarDeviceStatus;
  requestCameraPermission(): Promise<LidarDeviceStatus>;
  startCapture(): Promise<{ started: boolean }>;
  finishCapture(): Promise<CapturedScan>;
  cancelCapture(): void;
  removeCapturedFile(uri: string): void;
  addListener(
    eventName: 'onCaptureProgress',
    listener: (event: CaptureProgressEvent) => void,
  ): { remove(): void };
  addListener(
    eventName: 'onCompressionProgress',
    listener: (event: CompressionProgressEvent) => void,
  ): { remove(): void };
}

let nativeModule: LidarNativeModule | null = null;
if (Platform.OS === 'ios') {
  try {
    nativeModule = requireNativeModule<LidarNativeModule>('AscLidar');
  } catch {
    // The app can also run in a preview or Expo Go build without custom native code.
  }
}

const unavailableStatus: LidarDeviceStatus = {
  supported: false,
  cameraPermission: 'unavailable',
  canAskAgain: false,
  reason:
    Platform.OS === 'ios'
      ? 'LiDAR capture is not included in this iOS app build.'
      : 'LiDAR capture is available only in the iOS app.',
};

export const lidarScanner = {
  getDeviceStatus(): LidarDeviceStatus {
    return nativeModule?.getDeviceStatus() ?? unavailableStatus;
  },

  requestCameraPermission(): Promise<LidarDeviceStatus> {
    return nativeModule?.requestCameraPermission() ?? Promise.resolve(unavailableStatus);
  },

  startCapture(): Promise<{ started: boolean }> {
    return nativeModule?.startCapture()
      ?? Promise.reject(new Error(unavailableStatus.reason));
  },

  finishCapture(): Promise<CapturedScan> {
    return nativeModule?.finishCapture()
      ?? Promise.reject(new Error(unavailableStatus.reason));
  },

  cancelCapture(): void {
    nativeModule?.cancelCapture();
  },

  removeCapturedFile(uri: string): void {
    nativeModule?.removeCapturedFile(uri);
  },

  onCaptureProgress(listener: (event: CaptureProgressEvent) => void) {
    return nativeModule?.addListener('onCaptureProgress', listener) ?? null;
  },

  onCompressionProgress(listener: (event: CompressionProgressEvent) => void) {
    return nativeModule?.addListener('onCompressionProgress', listener) ?? null;
  },
};
