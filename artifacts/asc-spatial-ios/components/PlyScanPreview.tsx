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
  type PlyTriangle,
} from '@/lib/plyPreview';
import type { ScanProcessingMode } from '@/lib/lidarScanner';

interface PlyScanPreviewProps {
  uri: string;
  fileName: string;
  fileSize: number;
  fullScreen?: boolean;
  processingMode?: ScanProcessingMode;
  processingWarnings?: string[];
  onUseScan: () => void;
  onDiscardAndRecapture: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; cloud: PlyPointCloud }
  | { status: 'error' };

type PreviewMode = 'solid' | 'points';

interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
}

function createProjector(
  points: PlyPoint[],
  triangles: PlyTriangle[],
  rotation: number,
  pitch: number,
): (point: PlyPoint) => ProjectedPoint {
  const boundsPoints = [
    ...points,
    ...triangles.flatMap(({ a, b, c }) => [a, b, c]),
  ];
  const ranges = boundsPoints.reduce(
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
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);

  return (point) => {
    const x = ((point.x - centerX) / size) * 2;
    const y = ((point.y - centerY) / size) * 2;
    const z = ((point.z - centerZ) / size) * 2;
    const rotatedX = x * yawCos - z * yawSin;
    const rotatedZ = x * yawSin + z * yawCos;
    const projectedY = y * pitchCos - rotatedZ * pitchSin;
    return {
      x: 180 + rotatedX * 145,
      y: 112 - projectedY * 84,
      depth: rotatedZ,
    };
  };
}

function pointPath(
  points: PlyPoint[],
  project: (point: PlyPoint) => ProjectedPoint,
): string {
  return points
    .map((point) => {
      const projected = project(point);
      return `M${projected.x.toFixed(1)} ${projected.y.toFixed(1)}l0.1 0`;
    })
    .join('');
}

function solidFacePaths(
  triangles: PlyTriangle[],
  project: (point: PlyPoint) => ProjectedPoint,
): Array<{ d: string; depth: number; opacity: number }> {
  return triangles
    .map(({ a, b, c }) => {
      const projectedA = project(a);
      const projectedB = project(b);
      const projectedC = project(c);
      const area =
        (projectedB.x - projectedA.x) * (projectedC.y - projectedA.y) -
        (projectedB.y - projectedA.y) * (projectedC.x - projectedA.x);
      return {
        d: `M${projectedA.x.toFixed(1)} ${projectedA.y.toFixed(1)}L${projectedB.x.toFixed(1)} ${projectedB.y.toFixed(1)}L${projectedC.x.toFixed(1)} ${projectedC.y.toFixed(1)}Z`,
        depth: (projectedA.depth + projectedB.depth + projectedC.depth) / 3,
        opacity: Math.max(0.26, Math.min(0.62, 0.28 + Math.abs(area) / 900)),
      };
    })
    .sort((left, right) => left.depth - right.depth);
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function PlyScanPreview({
  uri,
  fileName,
  fileSize,
  fullScreen = false,
  processingMode,
  processingWarnings = [],
  onUseScan,
  onDiscardAndRecapture,
}: PlyScanPreviewProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [viewMode, setViewMode] = useState<PreviewMode>('solid');
  const [rotation, setRotation] = useState(0);
  const [pitch, setPitch] = useState(0.58);
  const rotationRef = useRef(0);
  const pitchRef = useRef(0.58);
  const rotationStartRef = useRef(0);
  const pitchStartRef = useRef(0.58);

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    setRotation(0);
    setPitch(0.58);
    rotationRef.current = 0;
    pitchRef.current = 0.58;
    void loadPlyPointCloud(uri, () => cancelled)
      .then((cloud) => {
        if (!cancelled) {
          setViewMode(cloud.triangles.length > 0 ? 'solid' : 'points');
          setPreview({ status: 'ready', cloud });
        }
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
          pitchStartRef.current = pitchRef.current;
        },
        onPanResponderMove: (_event, gesture) => {
          const nextRotation = rotationStartRef.current + gesture.dx * 0.012;
          const nextPitch = Math.max(
            -0.65,
            Math.min(1.25, pitchStartRef.current + gesture.dy * 0.009),
          );
          rotationRef.current = nextRotation;
          pitchRef.current = nextPitch;
          setRotation(nextRotation);
          setPitch(nextPitch);
        },
      }),
    [],
  );

  const project =
    preview.status === 'ready'
      ? createProjector(
          preview.cloud.points,
          preview.cloud.triangles,
          rotation,
          pitch,
        )
      : null;
  const cloudPath =
    preview.status === 'ready' && project
      ? pointPath(preview.cloud.points, project)
      : '';
  const facePaths =
    preview.status === 'ready' && project
      ? solidFacePaths(preview.cloud.triangles, project)
      : [];
  const hasSolidSurface = facePaths.length > 0;

  return (
    <View
      style={[styles.card, fullScreen && styles.fullScreenCard]}
      testID="captured-ply-preview"
    >
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Feather name="box" size={17} color={colors.primary} />
        </View>
        <View style={styles.fileDetails}>
          <Text style={styles.eyebrow}>
            {processingMode
              ? `${processingMode.toUpperCase()} · CAPTURE REVIEW`
              : 'CAPTURE REVIEW'}
          </Text>
          <Text style={styles.fileName} numberOfLines={1}>
            {fileName}
          </Text>
        </View>
        <Text style={styles.fileSize}>{formatSize(fileSize)}</Text>
      </View>

      {preview.status === 'ready' ? (
        <View
          style={styles.viewChoice}
          accessibilityRole="radiogroup"
          accessibilityLabel="Choose scan preview"
        >
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{
              selected: viewMode === 'solid',
              disabled: !hasSolidSurface,
            }}
            testID="preview-mode-solid"
            disabled={!hasSolidSurface}
            onPress={() => setViewMode('solid')}
            style={({ pressed }) => [
              styles.viewChoiceButton,
              viewMode === 'solid' && hasSolidSurface && styles.viewChoiceActive,
              !hasSolidSurface && styles.viewChoiceDisabled,
              pressed && hasSolidSurface && styles.pressed,
            ]}
          >
            <Feather
              name="box"
              size={15}
              color={
                viewMode === 'solid' && hasSolidSurface
                  ? colors.primary
                  : colors.mutedForeground
              }
            />
            <Text
              style={[
                styles.viewChoiceText,
                viewMode === 'solid' && hasSolidSurface &&
                  styles.viewChoiceTextActive,
              ]}
            >
              Solid object
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: viewMode === 'points' }}
            testID="preview-mode-points"
            onPress={() => setViewMode('points')}
            style={({ pressed }) => [
              styles.viewChoiceButton,
              viewMode === 'points' && styles.viewChoiceActive,
              pressed && styles.pressed,
            ]}
          >
            <Feather
              name="grid"
              size={15}
              color={
                viewMode === 'points' ? colors.primary : colors.mutedForeground
              }
            />
            <Text
              style={[
                styles.viewChoiceText,
                viewMode === 'points' && styles.viewChoiceTextActive,
              ]}
            >
              Point cloud
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={[styles.viewport, fullScreen && styles.fullScreenViewport]}
        {...panResponder.panHandlers}
        accessibilityRole="image"
        accessibilityLabel={`3D ${viewMode === 'solid' && hasSolidSurface ? 'solid object' : 'point-cloud'} preview. Drag to rotate the scan.`}
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
            {viewMode === 'solid' && hasSolidSurface ? (
              facePaths.map((face, index) => (
                <Path
                  key={`face-${index}`}
                  d={face.d}
                  fill={colors.primary}
                  fillOpacity={face.opacity}
                  stroke={colors.primary}
                  strokeOpacity={0.62}
                  strokeWidth={0.45}
                  strokeLinejoin="round"
                />
              ))
            ) : (
              <Path
                d={cloudPath}
                fill="none"
                stroke={colors.primary}
                strokeLinecap="round"
                strokeWidth={2}
              />
            )}
          </Svg>
        )}
      </View>

      {preview.status === 'ready' ? (
        <View style={styles.previewMeta}>
          <Text style={styles.vertexCount}>
            {preview.cloud.vertexCount.toLocaleString()} vertices
          </Text>
          <Text style={styles.pointCount}>
            {viewMode === 'solid' && hasSolidSurface
              ? `Showing ${facePaths.length.toLocaleString()} of ${preview.cloud.faceCount.toLocaleString()} faces`
              : `Showing ${preview.cloud.points.length.toLocaleString()} points`}
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          {preview.status === 'loading'
            ? 'Reading the compressed scan on this device.'
            : 'A preview is required before this scan can be uploaded.'}
        </Text>
      )}

      {processingWarnings.map((warning, index) => (
        <Text key={`processing-warning-${index}`} style={styles.processingWarning}>
          {warning}
        </Text>
      ))}

      {preview.status === 'ready' ? (
        <Text style={styles.hint}>
          {hasSolidSurface
            ? 'Choose a view, then drag the scan to inspect it from different angles.'
            : 'This scan contains points only, so a solid surface view is unavailable. Drag to rotate the point cloud.'}
        </Text>
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
    fullScreenCard: {
      flex: 1,
      borderWidth: 0,
      borderRadius: 0,
      backgroundColor: 'transparent',
      padding: 0,
      gap: 12,
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
    fullScreenViewport: {
      flex: 1,
      minHeight: 280,
      height: 224,
      borderRadius: 14,
    },
    viewChoice: {
      minHeight: 44,
      flexDirection: 'row',
      gap: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 11,
      backgroundColor: colors.muted,
      padding: 3,
    },
    viewChoiceButton: {
      flex: 1,
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      borderRadius: 8,
      paddingHorizontal: 8,
    },
    viewChoiceActive: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    viewChoiceDisabled: {
      opacity: 0.5,
    },
    viewChoiceText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 11,
    },
    viewChoiceTextActive: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
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
    processingWarning: {
      color: colors.primary,
      fontFamily: 'DMSans_500Medium',
      fontSize: 10,
      lineHeight: 15,
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
