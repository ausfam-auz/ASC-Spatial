import { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Switch,
  Text,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { useColors } from '@/hooks/useColors';

export interface ScanProcessingOptions {
  depthRangeMeters: number;
  voxelSizeMillimeters: number;
  simplificationPercent: number;
  automaticCrop: boolean;
  fillHoles: boolean;
}

interface ScanProcessingControlsProps {
  value: ScanProcessingOptions;
  onChange: (value: ScanProcessingOptions) => void;
}

interface RangeControlProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  onChange: (value: number) => void;
}

function RangeControl({
  label,
  description,
  value,
  min,
  max,
  step,
  formatValue,
  onChange,
}: RangeControlProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [trackWidth, setTrackWidth] = useState(1);
  const trackWidthRef = useRef(1);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const startValueRef = useRef(value);

  valueRef.current = value;
  onChangeRef.current = onChange;

  const normalize = (nextValue: number) => {
    const bounded = Math.min(max, Math.max(min, nextValue));
    const stepped = Math.round((bounded - min) / step) * step + min;
    return Number(Math.min(max, Math.max(min, stepped)).toFixed(2));
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          const ratio = Math.min(
            1,
            Math.max(
              0,
              (event.nativeEvent.locationX - 8) / trackWidthRef.current,
            ),
          );
          const nextValue = normalize(min + ratio * (max - min));
          startValueRef.current = nextValue;
          onChangeRef.current(nextValue);
        },
        onPanResponderMove: (
          _event: GestureResponderEvent,
          gesture: PanResponderGestureState,
        ) => {
          const nextValue = normalize(
            startValueRef.current +
              (gesture.dx / trackWidthRef.current) * (max - min),
          );
          onChangeRef.current(nextValue);
        },
      }),
    [max, min, step],
  );

  const onTrackLayout = (width: number) => {
    const usableWidth = Math.max(1, width - 16);
    trackWidthRef.current = usableWidth;
    setTrackWidth(usableWidth);
  };
  const progress = Math.min(1, Math.max(0, (value - min) / (max - min)));

  return (
    <View style={styles.rangeControl}>
      <View style={styles.rangeHeading}>
        <View style={styles.rangeCopy}>
          <Text style={styles.rangeLabel}>{label}</Text>
          <Text style={styles.rangeDescription}>{description}</Text>
        </View>
        <Text style={styles.rangeValue}>{formatValue(value)}</Text>
      </View>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityActions={[
          { name: 'increment', label: `Increase ${label.toLowerCase()}` },
          { name: 'decrement', label: `Decrease ${label.toLowerCase()}` },
        ]}
        accessibilityValue={{
          min,
          max,
          now: value,
          text: formatValue(value),
        }}
        onAccessibilityAction={(event) => {
          const amount =
            event.nativeEvent.actionName === 'increment' ? step : -step;
          onChange(normalize(valueRef.current + amount));
        }}
        onLayout={(event) => onTrackLayout(event.nativeEvent.layout.width)}
        style={styles.sliderHitArea}
        {...responder.panHandlers}
      >
        <View style={styles.sliderTrack}>
          <View
            style={[
              styles.sliderFill,
              { width: `${progress * 100}%` },
            ]}
          />
          <View
            style={[
              styles.sliderThumb,
              {
                left: progress * trackWidth,
                transform: [{ translateX: -8 }],
              },
            ]}
          />
        </View>
      </View>
    </View>
  );
}

export function ScanProcessingControls({
  value,
  onChange,
}: ScanProcessingControlsProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const update = <K extends keyof ScanProcessingOptions>(
    key: K,
    nextValue: ScanProcessingOptions[K],
  ) => onChange({ ...value, [key]: nextValue });

  return (
    <View style={styles.controls}>
      <RangeControl
        label="Depth range"
        description="Maximum distance from where the scan began."
        value={value.depthRangeMeters}
        min={1}
        max={10}
        step={0.1}
        formatValue={(amount) => `${amount.toFixed(1)} m`}
        onChange={(amount) => update('depthRangeMeters', amount)}
      />
      <RangeControl
        label="Voxel size"
        description="Larger cells merge nearby points and reduce detail."
        value={value.voxelSizeMillimeters}
        min={2}
        max={30}
        step={1}
        formatValue={(amount) => `${Math.round(amount)} mm`}
        onChange={(amount) => update('voxelSizeMillimeters', amount)}
      />
      <RangeControl
        label="Simplification"
        description="Higher values keep fewer mesh triangles."
        value={value.simplificationPercent}
        min={0}
        max={90}
        step={1}
        formatValue={(amount) => `${Math.round(amount)}%`}
        onChange={(amount) => update('simplificationPercent', amount)}
      />

      <SwitchRow
        title="Automatic crop"
        description="Trims extreme outlier geometry; it may clip narrow edges."
        value={value.automaticCrop}
        onChange={(enabled) => update('automaticCrop', enabled)}
      />
      <View style={styles.switchDivider} />
      <View style={styles.switchRow}>
        <View style={styles.switchCopy}>
          <Text style={styles.switchTitle}>Loop closure</Text>
          <Text style={styles.switchDescription}>
            ARKit aligns scan frames automatically; there is no separate
            on/off setting.
          </Text>
        </View>
        <View style={styles.automaticBadge}>
          <Text style={styles.automaticBadgeText}>AUTO</Text>
        </View>
      </View>
      <View style={styles.switchDivider} />
      <SwitchRow
        title="Fill small holes"
        description="Closes small openings; large or very dense scans may skip filling."
        value={value.fillHoles}
        onChange={(enabled) => update('fillHoles', enabled)}
      />
    </View>
  );
}

function SwitchRow({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.switchRow}>
      <View style={styles.switchCopy}>
        <Text style={styles.switchTitle}>{title}</Text>
        <Text style={styles.switchDescription}>{description}</Text>
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onChange}
        trackColor={{
          false: colors.border,
          true: colors.primary,
        }}
        thumbColor={colors.card}
        ios_backgroundColor={colors.border}
      />
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) {
  return {
    controls: {
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.card,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    rangeControl: {
      gap: 7,
    },
    rangeHeading: {
      minHeight: 36,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 10,
    },
    rangeCopy: {
      flex: 1,
      gap: 2,
    },
    rangeLabel: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    rangeDescription: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 10,
      lineHeight: 14,
    },
    rangeValue: {
      minWidth: 50,
      color: colors.foreground,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 11,
      textAlign: 'right' as const,
    },
    sliderHitArea: {
      height: 32,
      justifyContent: 'center' as const,
      paddingHorizontal: 8,
    },
    sliderTrack: {
      height: 3,
      borderRadius: 2,
      backgroundColor: colors.border,
    },
    sliderFill: {
      height: 3,
      borderRadius: 2,
      backgroundColor: colors.primary,
    },
    sliderThumb: {
      position: 'absolute' as const,
      top: -6,
      width: 15,
      height: 15,
      borderWidth: 1.5,
      borderColor: colors.primary,
      borderRadius: 8,
      backgroundColor: colors.card,
    },
    switchRow: {
      minHeight: 48,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 12,
    },
    switchCopy: {
      flex: 1,
      gap: 3,
    },
    switchTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    switchDescription: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 10,
      lineHeight: 14,
    },
    switchDivider: {
      height: 1,
      backgroundColor: colors.border,
    },
    automaticBadge: {
      borderRadius: 12,
      backgroundColor: colors.muted,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    automaticBadgeText: {
      color: colors.primary,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 9,
      letterSpacing: 0.6,
    },
  };
}
