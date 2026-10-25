import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import {
  loadPlyPointCloud,
  type PlyPoint,
  type PlyPointCloud,
} from '@/lib/plyPreview';

interface PlyScanPreviewProps {
  uri: string;
  fileName: string;
  fileSize: number;
  onUseScan: () => void;
  onDiscardAndRecapture: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; cloud: PlyPointCloud }
  | { status: 'error' };

function pointPath(points: PlyPoint[], rotation: number): string {
  const ranges = points.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      maxX: Math.max(result.maxX, point.x),
      minY: Math.min(result.minY, point.y),
      maxY: Math.max(result.maxY, point.y),
      minZ: Math.min(result.minZ, point.z),
      maxZ: Math.max(result.maxZ, point.z),
    }),
    {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    },
  );

  const centerX = (ranges.minX + ranges.maxX) / 2;
  const centerY = (ranges.minY + ranges.maxY) / 2;
  const centerZ = (ranges.minZ + ranges.maxZ) / 2;
  const size = Math.max(
    ranges.maxX - ranges.minX,
    ranges.maxY - ranges.minY,
    ranges.maxZ - ranges.minZ,
    0.001,
  );
  const yawCos = Math.cos(rotation);
  const yawSin = Math.sin(rotation);
  const pitchCos = Math.cos(0.58);
  const pitchSin = Math.sin(0.58);

  return points
    .map((point) => {
      const x = ((point.x - centerX) / size) * 2;
      const y = ((point.y - centerY) / size) * 2;
      const z = ((point.z - centerZ) / size) * 2;
      const rotatedX = x * yawCos - z * yawSin;
      const rotatedZ = x * yawSin + z * yawCos;
      const projectedY = y * pitchCos - rotatedZ * pitchSin;
      const screenX = 180 + rotatedX * 145;
      const screenY = 112 - projectedY * 84;
      return `M${screenX.toFixed(1)} ${screenY.toFixed(1)}l0.1 0`;
    })
    .join('');
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function PlyScanPreview({
  uri,
  fileName,
  fileSize,
  onUseScan,
  onDiscardAndRecapture,
}: PlyScanPreviewProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(0);
  const rotationStartRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    setRotation(0);
    rotationRef.current = 0;
    void loadPlyPointCloud(uri, () => cancelled)
      .then((cloud) => {
        if (!cancelled) setPreview({ status: 'ready', cloud });
      })
      .catch(() => {
        if (!cancelled) setPreview({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          rotationStartRef.current = rotationRef.current;
        },
        onPanResponderMove: (_event, gesture) => {
          const nextRotation = rotationStartRef.current + gesture.dx * 0.012;
          rotationRef.current = nextRotation;
          setRotation(nextRotation);
        },
      }),
    [],
  );

  const cloudPath =
    preview.status === 'ready'
      ? pointPath(preview.cloud.points, rotation)
      : '';

  return (
    <View style={styles.card} testID="captured-ply-preview">
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Feather name="box" size={17} color={colors.primary} />
        </View>
        <View style={styles.fileDetails}>
          <Text style={styles.eyebrow}>CAPTURE REVIEW</Text>
          <Text style={styles.fileName} numberOfLines={1}>
            {fileName}
          </Text>
        </View>
        <Text style={styles.fileSize}>{formatSize(fileSize)}</Text>
      </View>

      <View
        style={styles.viewport}
        {...panResponder.panHandlers}
        accessibilityRole="image"
        accessibilityLabel="3D point-cloud preview. Drag to rotate the scan."
      >
        {preview.status === 'loading' ? (
          <View style={styles.previewState}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.stateText}>Preparing scan preview…</Text>
          </View>
        ) : preview.status === 'error' ? (
          <View style={styles.previewState}>
            <Feather name="alert-circle" size={22} color={colors.destructive} />
            <Text style={styles.errorText}>
              This scan could not be previewed. Discard it and capture again.
            </Text>
          </View>
        ) : (
          <Svg
            width="100%"
            height="100%"
            viewBox="0 0 360 224"
            preserveAspectRatio="xMidYMid meet"
          >
            <Path
              d="M36 112H324M180 24V200M74 167H286M74 57H286"
              fill="none"
              stroke={colors.border}
              strokeDasharray="3 7"
              strokeOpacity={0.4}
              strokeWidth={1}
            />
            <Path
              d={cloudPath}
              fill="none"
              stroke={colors.primary}
              strokeLinecap="round"
              strokeWidth={2}
            />
          </Svg>
        )}
      </View>

      {preview.status === 'ready' ? (
        <View style={styles.previewMeta}>
          <Text style={styles.vertexCount}>
            {preview.cloud.vertexCount.toLocaleString()} vertices
          </Text>
          <Text style={styles.pointCount}>
            Showing {preview.cloud.points.length.toLocaleString()} points
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          {preview.status === 'loading'
            ? 'Reading the compressed scan on this device.'
            : 'A preview is required before this scan can be uploaded.'}
        </Text>
      )}

      {preview.status === 'ready' ? (
        <Text style={styles.hint}>Drag the scan to inspect it from different angles.</Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          testID="use-previewed-scan"
          disabled={preview.status !== 'ready'}
          onPress={onUseScan}
          style={({ pressed }) => [
            styles.primaryButton,
            preview.status !== 'ready' && styles.disabledButton,
            pressed && preview.status === 'ready' && styles.pressed,
          ]}
        >
          <Feather name="check" size={16} color={colors.primaryForeground} />
          <Text style={styles.primaryButtonText}>Use this scan</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="discard-preview-recapture"
          onPress={onDiscardAndRecapture}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.pressed,
          ]}
        >
          <Feather name="rotate-ccw" size={15} color={colors.foreground} />
          <Text style={styles.secondaryButtonText}>Discard and recapture</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.card,
      padding: 12,
      gap: 11,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    headerIcon: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      backgroundColor: colors.muted,
    },
    fileDetails: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    eyebrow: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 1.1,
    },
    fileName: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    fileSize: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 10,
    },
    viewport: {
      height: 224,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 11,
      backgroundColor: colors.foreground,
    },
    previewState: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 22,
    },
    stateText: {
      color: colors.background,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
      textAlign: 'center',
    },
    errorText: {
      color: colors.background,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
    },
    previewMeta: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 10,
    },
    vertexCount: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    pointCount: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
    },
    hint: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
    },
    actions: {
      gap: 8,
    },
    primaryButton: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingHorizontal: 12,
    },
    primaryButtonText: {
      color: colors.primaryForeground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    disabledButton: {
      opacity: 0.45,
    },
    secondaryButton: {
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
    },
    secondaryButtonText: {
      color: colors.foreground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
    },
    pressed: {
      opacity: 0.72,
    },
  });
}
