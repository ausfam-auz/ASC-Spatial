import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { File } from 'expo-file-system';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getListScansQueryKey,
  useHealthCheck,
  useListScans,
  type ScanSummary,
} from '@workspace/api-client-react';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { PlyScanPreview } from '@/components/PlyScanPreview';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@clerk/expo';
import { useGetAccount } from '@workspace/api-client-react';
import { router } from 'expo-router';
import { lidarScanner, type LidarDeviceStatus } from '@/lib/lidarScanner';
import { scanUploadQueue } from '@/lib/scanUploadQueue';
import type { ScanUploadQueueItem } from '@/lib/scanUploadQueueCore';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MODULE_TYPES = ['DeckOps', 'ToolingAudit'] as const;
type ModuleType = (typeof MODULE_TYPES)[number];

interface SelectedScanFile {
  uri: string;
  name: string;
  size: number | null;
  source?: 'picked' | 'lidar';
  vertexCount?: number;
  faceCount?: number;
  decimationFactor?: number;
}

function localDateTimeValue(date = new Date()): string {
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 16);
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024)
    return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function readableDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scanExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function uploadQueueStatusLabel(item: ScanUploadQueueItem): string {
  switch (item.state) {
    case 'uploading':
      return 'Sending scan…';
    case 'failed':
      return 'Failed after several attempts';
    case 'sent':
      return item.serverRecordId
        ? `Sent · ${item.serverRecordId.slice(0, 8)}`
        : 'Sent';
    default:
      return item.attempts > 0
        ? `Waiting to retry · attempt ${item.attempts + 1} of 6`
        : 'Pending · saved on this device';
  }
}

function discardGeneratedScan(file: SelectedScanFile | null): void {
  if (file?.source !== 'lidar') return;
  try {
    lidarScanner.removeCapturedFile(file.uri);
  } catch {
    // Cache cleanup should not block selecting or uploading another scan.
  }
}

function ScanRecord({
  scan,
  colors,
}: {
  scan: ScanSummary;
  colors: ReturnType<typeof useColors>;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const extension = scanExtension(scan.fileName);
  return (
    <View style={styles.record}>
      <View style={styles.recordIcon}>
        <Feather name="box" size={17} color={colors.primary} />
      </View>
      <View style={styles.recordMain}>
        <Text style={styles.recordTitle} numberOfLines={1}>
          {scan.vesselAssetName}
        </Text>
        <Text style={styles.recordMeta} numberOfLines={1}>
          {scan.moduleType} · {readableDate(scan.timestamp)}
        </Text>
      </View>
      <View style={styles.recordFile}>
        <Text style={styles.recordExtension}>{extension.toUpperCase()}</Text>
        <Text style={styles.recordSize}>{formatSize(scan.fileSize)}</Text>
      </View>
    </View>
  );
}

export default function ScanWorkspaceScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const account = useGetAccount({
    query: {
      enabled: isLoaded && !!isSignedIn,
      retry: false,
      staleTime: 0,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  // The server has already resolved the session to the correct local account.
  const user = account.data?.user ?? null;
  const authLoading = !isLoaded || (!!isSignedIn && account.isLoading);
  const isAuthenticated = !!isSignedIn;
  const authError = account.error?.message ?? null;
  const login = () => router.push('/sign-in');
  const logout = async () => {
    await signOut();
    router.replace('/');
  };
  const [moduleType, setModuleType] = useState<ModuleType>('DeckOps');
  const [vesselAssetName, setVesselAssetName] = useState('');
  const [inspectionTime, setInspectionTime] = useState(() =>
    localDateTimeValue(),
  );
  const [selectedFile, setSelectedFile] = useState<SelectedScanFile | null>(
    null,
  );
  const [pendingCapturePreview, setPendingCapturePreview] =
    useState<SelectedScanFile | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastUploadedId, setLastUploadedId] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<ScanUploadQueueItem[]>([]);
  const [isQueueing, setIsQueueing] = useState(false);
  const noticedSentUploads = useRef(new Set<string>());
  const [isPicking, setIsPicking] = useState(false);
  const [lidarStatus, setLidarStatus] = useState<LidarDeviceStatus | null>(
    null,
  );
  const [capturePhase, setCapturePhase] = useState<
    'idle' | 'capturing' | 'compressing'
  >('idle');
  const [captureProgress, setCaptureProgress] = useState(0);
  const [captureMeshCount, setCaptureMeshCount] = useState(0);
  const [compressionStage, setCompressionStage] = useState('');

  useEffect(() => {
    try {
      setLidarStatus(lidarScanner.getDeviceStatus());
    } catch {
      setLidarStatus({
        supported: false,
        cameraPermission: 'unavailable',
        canAskAgain: false,
        reason: 'LiDAR capture is not available in this app build.',
      });
    }
    const captureSubscription = lidarScanner.onCaptureProgress((event) => {
      setCaptureProgress(event.progress);
      setCaptureMeshCount(event.meshCount);
    });
    const compressionSubscription = lidarScanner.onCompressionProgress(
      (event) => {
        setCaptureProgress(event.progress);
        setCompressionStage(event.stage);
      },
    );
    const appStateSubscription = AppState.addEventListener(
      'change',
      (state) => {
        if (state !== 'active') return;
        try {
          setLidarStatus(lidarScanner.getDeviceStatus());
        } catch {
          // Keep the last known device state if the native module is unavailable.
        }
      },
    );
    return () => {
      captureSubscription?.remove();
      compressionSubscription?.remove();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(
    () => () => {
      lidarScanner.cancelCapture();
    },
    [],
  );

  const health = useHealthCheck();
  const canAccessScans = Boolean(
    isAuthenticated && (user?.isTechnician || user?.isAdmin),
  );
  const scansQuery = useListScans({
    query: {
      queryKey: getListScansQueryKey(),
      enabled: canAccessScans,
    },
  });
  const scans = scansQuery.data?.scans ?? [];
  const serviceLabel = health.isError
    ? 'API unavailable'
    : health.isLoading
      ? 'Connecting'
      : (health.data?.status ?? 'API connected');
  const serviceColor = health.isError ? colors.destructive : colors.primary;
  const topInset =
    Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset =
    Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;
  const currentQueueItems = queueItems
    .filter((item) => item.technicianId === user?.id)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 6);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = scanUploadQueue.subscribe((items) => {
      if (mounted) setQueueItems(items);
    });
    void scanUploadQueue
      .load()
      .then(() => {
        if (mounted) setQueueError(null);
      })
      .catch(() => {
        if (mounted) {
          setQueueError(
            'Saved uploads could not be read from this device. Keep the app installed and try again.',
          );
        }
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' || !canAccessScans || !user?.id) return;
    let active = true;
    let running = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextAttempt = () => {
      if (!active || running) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = scanUploadQueue.nextRetryDelay(user.id);
      if (delay === null) {
        retryTimer = null;
        return;
      }
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          void flushQueue();
        },
        Math.max(250, delay),
      );
    };

    const flushQueue = async () => {
      if (!active || running) return;
      running = true;
      try {
        await scanUploadQueue.flushDue(user.id);
        setQueueError(null);
      } catch {
        setQueueError(
          'The upload queue could not be saved. Your selected scan has not been removed.',
        );
      } finally {
        running = false;
        scheduleNextAttempt();
      }
    };

    const unsubscribe = scanUploadQueue.subscribe(scheduleNextAttempt);
    const appStateSubscription = AppState.addEventListener(
      'change',
      (state) => {
        if (state !== 'active') return;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        void flushQueue();
      },
    );

    void scanUploadQueue
      .load()
      .then(flushQueue)
      .catch(() => {
        setQueueError(
          'Saved uploads could not be read from this device. Keep the app installed and try again.',
        );
      });

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
      appStateSubscription.remove();
    };
  }, [canAccessScans, user?.id]);

  useEffect(() => {
    const newlySent = queueItems.find(
      (item) =>
        item.technicianId === user?.id &&
        item.state === 'sent' &&
        item.serverRecordId &&
        !noticedSentUploads.current.has(item.id),
    );
    if (!newlySent?.serverRecordId) return;

    noticedSentUploads.current.add(newlySent.id);
    setLastUploadedId(newlySent.serverRecordId);
    setQueueNotice(null);
    void queryClient.invalidateQueries({
      queryKey: getListScansQueryKey(),
    });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [queueItems, queryClient, user?.id]);

  async function pickFile() {
    setFormError(null);
    setLastUploadedId(null);
    setIsPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const extension = scanExtension(asset.name);
      if (extension !== 'ply' && extension !== 'obj') {
        discardGeneratedScan(selectedFile);
        setSelectedFile(null);
        setFormError('Choose a .ply or .obj scan file.');
        return;
      }
      if (typeof asset.size === 'number' && asset.size > MAX_FILE_SIZE) {
        discardGeneratedScan(selectedFile);
        setSelectedFile(null);
        setFormError('This file exceeds the 100 MiB upload limit.');
        return;
      }

      discardGeneratedScan(selectedFile);
      setSelectedFile({
        uri: asset.uri,
        name: asset.name,
        size: typeof asset.size === 'number' ? asset.size : null,
        source: 'picked',
      });
      setFormError(null);
    } catch {
      setFormError('The file picker could not open. Please try again.');
    } finally {
      setIsPicking(false);
    }
  }

  async function requestLidarPermission() {
    try {
      const status = await lidarScanner.requestCameraPermission();
      setLidarStatus(status);
      if (status.cameraPermission !== 'authorized') {
        setFormError(
          status.cameraPermission === 'restricted'
            ? 'Camera access is restricted on this device.'
            : 'Camera access is required to capture a LiDAR scan.',
        );
      } else {
        setFormError(null);
      }
    } catch {
      setFormError(
        'Camera permission could not be requested. Please try again.',
      );
    }
  }

  async function startLidarCapture() {
    setFormError(null);
    setLastUploadedId(null);
    discardGeneratedScan(selectedFile);
    setSelectedFile(null);
    setCaptureProgress(0.02);
    setCaptureMeshCount(0);
    try {
      await lidarScanner.startCapture();
      setCapturePhase('capturing');
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'LiDAR capture could not start. Check camera access and try again.',
      );
    }
  }

  async function finishLidarCapture() {
    setCapturePhase('compressing');
    setCompressionStage('Preparing captured mesh');
    setCaptureProgress(0.08);
    try {
      const result = await lidarScanner.finishCapture();
      if (result.size > MAX_FILE_SIZE) {
        lidarScanner.removeCapturedFile(result.uri);
        throw new Error(
          'The compressed scan exceeds the 100 MiB upload limit.',
        );
      }
      if (scanExtension(result.name) !== 'ply') {
        lidarScanner.removeCapturedFile(result.uri);
        throw new Error(
          'The captured scan is not a PLY file. Please capture again.',
        );
      }
      setPendingCapturePreview({
        uri: result.uri,
        name: result.name,
        size: result.size,
        source: 'lidar',
        vertexCount: result.vertexCount,
        faceCount: result.faceCount,
        decimationFactor: result.decimationFactor,
      });
      setSelectedFile(null);
      setFormError(null);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'The scan could not be compressed. Please capture a smaller area.',
      );
    } finally {
      setCapturePhase('idle');
      setCaptureProgress(0);
      setCompressionStage('');
    }
  }

  function acceptCapturedPreview() {
    if (!pendingCapturePreview) return;
    setSelectedFile(pendingCapturePreview);
    setPendingCapturePreview(null);
    setFormError(null);
  }

  function discardPreviewAndRecapture() {
    if (!pendingCapturePreview) return;
    discardGeneratedScan(pendingCapturePreview);
    setPendingCapturePreview(null);
    setFormError(null);
    void startLidarCapture();
  }

  function cancelLidarCapture() {
    lidarScanner.cancelCapture();
    setCapturePhase('idle');
    setCaptureProgress(0);
    setCaptureMeshCount(0);
  }

  async function openCameraSettings() {
    try {
      await Linking.openSettings();
    } catch {
      setFormError(
        'Settings could not be opened. Enable camera access in iOS Settings.',
      );
    }
  }

  async function submitUpload() {
    setFormError(null);
    setLastUploadedId(null);

    if (Platform.OS === 'web') {
      setFormError(
        'Use the ASC Spatial web app for browser uploads. Offline-safe queuing is available in the native iOS app.',
      );
      return;
    }

    if (!user?.isTechnician && !user?.isAdmin) {
      setFormError('Your account is not approved for field uploads.');
      return;
    }
    if (!vesselAssetName.trim()) {
      setFormError('Enter the vessel or asset name.');
      return;
    }
    const parsedTime = new Date(inspectionTime);
    if (!inspectionTime || Number.isNaN(parsedTime.getTime())) {
      setFormError('Enter a valid inspection date and time.');
      return;
    }
    if (!selectedFile) {
      setFormError('Select a .ply or .obj scan file first.');
      return;
    }
    if (selectedFile.size !== null && selectedFile.size > MAX_FILE_SIZE) {
      setFormError('This file exceeds the 100 MiB upload limit.');
      return;
    }

    const fileToUpload = selectedFile;
    const fileSize = selectedFile.size ?? new File(selectedFile.uri).size;
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      setFormError('The scan file size could not be determined.');
      return;
    }

    setIsQueueing(true);
    try {
      await scanUploadQueue.enqueue({
        sourceUri: selectedFile.uri,
        fileName: selectedFile.name,
        fileSize,
        moduleType,
        technicianId: user.id,
        timestamp: parsedTime.toISOString(),
        vesselAssetName: vesselAssetName.trim(),
      });
      discardGeneratedScan(fileToUpload);
      setSelectedFile(null);
      setVesselAssetName('');
      setInspectionTime(localDateTimeValue());
      setQueueNotice(
        'Scan saved on this device. It will upload now or retry automatically when the connection returns.',
      );
      setQueueError(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'The scan could not be saved on this device. Keep it selected and try again.',
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsQueueing(false);
    }
  }

  async function retryQueuedScan(id: string) {
    if (!user?.id) return;
    try {
      const retried = await scanUploadQueue.retry(id, user.id);
      if (retried) await scanUploadQueue.flushDue(user.id);
    } catch {
      setQueueError(
        'The scan could not be retried. Its local copy is still saved.',
      );
    }
  }

  function renderHeader() {
    return (
      <View style={styles.header}>
        <View style={styles.brandMark}>
          <Image
            accessibilityLabel="ASC Spatial logo"
            source={require('../assets/images/icon.png')}
            style={styles.brandLogo}
            resizeMode="cover"
          />
          <Text style={styles.brandName}>ASC SPATIAL</Text>
        </View>
        <View style={styles.headerRight}>
          {user?.isAdmin ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open technician access settings"
              testID="open-technician-review"
              onPress={() => router.push('/admin/technicians')}
              style={({ pressed }) => [
                styles.adminShortcut,
                pressed && styles.pressed,
              ]}
            >
              <Feather name="shield" size={14} color={colors.primary} />
              <Text style={styles.adminShortcutText}>Access</Text>
            </Pressable>
          ) : null}
          <View style={styles.connection}>
            <View
              style={[styles.statusDot, { backgroundColor: serviceColor }]}
            />
            <Text style={styles.connectionText}>{serviceLabel}</Text>
          </View>
        </View>
      </View>
    );
  }

  if (authLoading) {
    return (
      <View
        style={[
          styles.centerPage,
          { paddingTop: topInset, paddingBottom: bottomInset },
        ]}
      >
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.centerText}>Checking secure session…</Text>
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <KeyboardAwareScrollViewCompat
        style={styles.page}
        contentContainerStyle={[
          styles.pageContent,
          { paddingTop: topInset + 20, paddingBottom: bottomInset + 24 },
        ]}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
      >
        {renderHeader()}
        <View style={styles.hero}>
          <Image
            accessibilityLabel="ASC Spatial logo"
            source={require('../assets/images/icon.png')}
            style={styles.signInLogo}
            resizeMode="cover"
          />
          <Text style={styles.eyebrow}>FIELD OPERATIONS / 01</Text>
          <Text style={styles.title}>Scan intake,{'\n'}made reliable.</Text>
          <Text style={styles.intro}>
            Sign in with your approved field account to send compressed 3D scans
            and inspection details.
          </Text>
        </View>
        {authError ? (
          <InlineNotice message={authError} tone="error" colors={colors} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          testID="sign-in-button"
          onPress={() => void login()}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>Sign in securely</Text>
          <Feather
            name="arrow-up-right"
            size={18}
            color={colors.primaryForeground}
          />
        </Pressable>
        <Text style={styles.footnote}>
          {Platform.OS === 'web'
            ? 'Preview sessions stay in this browser tab.'
            : 'Your session is stored in the iOS Keychain.'}
        </Text>
      </KeyboardAwareScrollViewCompat>
    );
  }

  if (account.isError) {
    return (
      <View
        style={[
          styles.page,
          { paddingTop: topInset + 24, paddingHorizontal: 24 },
        ]}
      >
        <Text style={styles.title}>Account unavailable</Text>
        <Text style={styles.intro}>{authError}</Text>
        <Pressable onPress={() => void account.refetch()}>
          <Text style={styles.cardTitle}>Retry</Text>
        </Pressable>
        <Pressable onPress={() => void logout()}>
          <Text style={styles.cardTitle}>Sign out</Text>
        </Pressable>
      </View>
    );
  }
  if (!user?.isTechnician && !user?.isAdmin) {
    return (
      <KeyboardAwareScrollViewCompat
        style={styles.page}
        contentContainerStyle={[
          styles.pageContent,
          { paddingTop: topInset + 20, paddingBottom: bottomInset + 24 },
        ]}
      >
        {renderHeader()}
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>ACCOUNT STATUS</Text>
          <Text style={styles.title}>Approval{'\n'}in progress.</Text>
          <Text style={styles.intro}>
            You’re signed in, but this account is not yet enabled for field
            uploads. Contact your ASC Spatial administrator to request
            technician access.
          </Text>
        </View>
        <View style={styles.approvalCard}>
          <Feather name="lock" size={18} color={colors.primary} />
          <View style={styles.approvalCopy}>
            <Text style={styles.cardTitle}>Uploads are protected</Text>
            <Text style={styles.cardText}>
              Only approved field technicians can submit scan files.
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          testID="sign-out-button"
          onPress={() => void logout()}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Sign out</Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    );
  }

  return (
    <KeyboardAwareScrollViewCompat
      style={styles.page}
      contentContainerStyle={[
        styles.pageContent,
        { paddingTop: topInset + 16, paddingBottom: bottomInset + 28 },
      ]}
      bottomOffset={86}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {renderHeader()}

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>FIELD OPERATIONS / 01</Text>
        <Text style={styles.title}>Scan intake.</Text>
        <Text style={styles.intro}>
          Send a compressed 3D scan with its inspection record.
        </Text>
      </View>

      <View style={styles.formCard}>
        <View style={styles.sectionHeading}>
          <View>
            <Text style={styles.cardEyebrow}>NEW RECORD</Text>
            <Text style={styles.cardTitle}>Inspection details</Text>
          </View>
          <Feather name="crosshair" size={19} color={colors.primary} />
        </View>

        <Text style={styles.label}>Module type</Text>
        <View style={styles.segmentGroup}>
          {MODULE_TYPES.map((type) => {
            const selected = moduleType === type;
            return (
              <Pressable
                key={type}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                testID={`module-${type}`}
                onPress={() => setModuleType(type)}
                style={[styles.segment, selected && styles.segmentSelected]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    selected && styles.segmentTextSelected,
                  ]}
                >
                  {type}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.label}>Vessel or asset</Text>
        <TextInput
          accessibilityLabel="Vessel or asset name"
          testID="vessel-asset-input"
          value={vesselAssetName}
          onChangeText={(value) => {
            setVesselAssetName(value);
            setFormError(null);
          }}
          placeholder="e.g. MV Northwind / Deck 04"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="words"
          returnKeyType="next"
          style={styles.input}
          maxLength={255}
        />

        <Text style={styles.label}>Inspection date and time · local</Text>
        <TextInput
          accessibilityLabel="Inspection date and time"
          testID="inspection-time-input"
          value={inspectionTime}
          onChangeText={(value) => {
            setInspectionTime(value);
            setFormError(null);
          }}
          placeholder="YYYY-MM-DDTHH:mm"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          style={styles.input}
        />

        <Text style={styles.label}>Scan file</Text>
        <View style={styles.captureCard}>
          <View style={styles.captureHeading}>
            <View style={styles.captureIcon}>
              <Feather name="box" size={18} color={colors.primary} />
            </View>
            <View style={styles.captureCopy}>
              <Text style={styles.captureTitle}>Capture with LiDAR</Text>
              <Text style={styles.captureCaption}>
                {!lidarStatus
                  ? 'Checking device LiDAR support…'
                  : !lidarStatus.supported
                    ? lidarStatus.reason
                    : lidarStatus.cameraPermission === 'restricted'
                      ? 'Camera access is restricted by iOS settings or device policy.'
                      : lidarStatus.cameraPermission !== 'authorized'
                        ? 'Allow camera access to start a LiDAR scan.'
                        : 'Create a scan on this device and compress it for upload.'}
              </Text>
            </View>
          </View>

          {capturePhase === 'capturing' ? (
            <>
              <View style={styles.captureProgressTrack}>
                <View
                  style={[
                    styles.captureProgressFill,
                    { width: `${Math.round(captureProgress * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.captureProgressText}>
                Scanning · {captureMeshCount} mesh areas found · move slowly
                around the surface
              </Text>
              <Pressable
                accessibilityRole="button"
                testID="finish-lidar-capture"
                onPress={() => void finishLidarCapture()}
                style={({ pressed }) => [
                  styles.captureButton,
                  styles.captureStopButton,
                  pressed && styles.pressed,
                ]}
              >
                <Feather name="check" size={16} color={colors.foreground} />
                <Text style={styles.captureButtonText}>
                  Finish and compress
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                testID="cancel-lidar-capture"
                onPress={cancelLidarCapture}
                style={styles.captureCancel}
              >
                <Text style={styles.captureCancelText}>Cancel capture</Text>
              </Pressable>
            </>
          ) : capturePhase === 'compressing' ? (
            <View style={styles.captureBusy}>
              <ActivityIndicator color={colors.primary} />
              <View style={styles.captureBusyCopy}>
                <Text style={styles.captureTitle}>Compressing scan</Text>
                <Text style={styles.captureCaption}>
                  {compressionStage || 'Preparing the mesh for upload…'} ·{' '}
                  {Math.round(captureProgress * 100)}%
                </Text>
              </View>
            </View>
          ) : lidarStatus?.supported &&
            lidarStatus.cameraPermission === 'authorized' ? (
            <Pressable
              accessibilityRole="button"
              testID="start-lidar-capture"
              disabled={isQueueing || isPicking || !!pendingCapturePreview}
              onPress={() => void startLidarCapture()}
              style={({ pressed }) => [
                styles.captureButton,
                styles.captureStartButton,
                pressed && styles.pressed,
                (isQueueing || isPicking || !!pendingCapturePreview) &&
                  styles.disabled,
              ]}
            >
              <Feather
                name="crosshair"
                size={16}
                color={colors.primaryForeground}
              />
              <Text style={styles.captureStartButtonText}>
                Start LiDAR scan
              </Text>
            </Pressable>
          ) : lidarStatus?.supported &&
            (lidarStatus.cameraPermission === 'denied' ||
              lidarStatus.cameraPermission === 'restricted') &&
            !lidarStatus.canAskAgain ? (
            <Pressable
              accessibilityRole="button"
              testID="open-camera-settings"
              onPress={() => void openCameraSettings()}
              style={styles.captureButton}
            >
              <Feather name="settings" size={16} color={colors.foreground} />
              <Text style={styles.captureButtonText}>
                Open Settings for camera access
              </Text>
            </Pressable>
          ) : lidarStatus?.supported &&
            lidarStatus.cameraPermission !== 'authorized' ? (
            <Pressable
              accessibilityRole="button"
              testID="request-camera-permission"
              onPress={() => void requestLidarPermission()}
              style={styles.captureButton}
            >
              <Feather name="camera" size={16} color={colors.foreground} />
              <Text style={styles.captureButtonText}>Allow camera access</Text>
            </Pressable>
          ) : null}
        </View>

        {pendingCapturePreview ? (
          <PlyScanPreview
            uri={pendingCapturePreview.uri}
            fileName={pendingCapturePreview.name}
            fileSize={pendingCapturePreview.size ?? 0}
            onUseScan={acceptCapturedPreview}
            onDiscardAndRecapture={discardPreviewAndRecapture}
          />
        ) : null}

        <Pressable
          accessibilityRole="button"
          testID="choose-scan-file"
          disabled={
            isPicking ||
            isQueueing ||
            capturePhase !== 'idle' ||
            !!pendingCapturePreview
          }
          onPress={() => void pickFile()}
          style={({ pressed }) => [
            styles.filePicker,
            pressed && styles.pressed,
            (isPicking ||
              isQueueing ||
              capturePhase !== 'idle' ||
              !!pendingCapturePreview) &&
              styles.disabled,
          ]}
        >
          <View style={styles.fileIcon}>
            {isPicking || capturePhase === 'compressing' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="upload-cloud" size={20} color={colors.primary} />
            )}
          </View>
          <View style={styles.fileCopy}>
            <Text style={styles.fileTitle} numberOfLines={1}>
              {selectedFile?.name ?? 'Choose a scan file'}
            </Text>
            <Text style={styles.fileCaption}>
              {selectedFile
                ? selectedFile.size === null
                  ? '.PLY or .OBJ'
                  : `${formatSize(selectedFile.size)} · .PLY or .OBJ`
                : 'Compressed .PLY or .OBJ · up to 100 MiB'}
            </Text>
          </View>
          {selectedFile ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove selected file"
              testID="remove-scan-file"
              hitSlop={10}
              onPress={(event) => {
                event.stopPropagation();
                discardGeneratedScan(selectedFile);
                setSelectedFile(null);
                setFormError(null);
              }}
              style={styles.removeFile}
            >
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : (
            <Feather name="plus" size={17} color={colors.mutedForeground} />
          )}
        </Pressable>

        {formError ? (
          <InlineNotice message={formError} tone="error" colors={colors} />
        ) : null}
        {lastUploadedId ? (
          <InlineNotice
            message={`Scan saved. Record ID: ${lastUploadedId}`}
            tone="success"
            colors={colors}
          />
        ) : null}
        {queueNotice ? (
          <InlineNotice message={queueNotice} tone="success" colors={colors} />
        ) : null}
        {queueError ? (
          <InlineNotice message={queueError} tone="error" colors={colors} />
        ) : null}
        {currentQueueItems.length > 0 ? (
          <View style={styles.historyCard} testID="scan-upload-queue">
            <Text style={styles.cardEyebrow}>
              ON THIS DEVICE · UPLOAD STATUS
            </Text>
            {currentQueueItems.map((item) => {
              const stateColor =
                item.state === 'failed'
                  ? colors.destructive
                  : item.state === 'sent'
                    ? colors.primary
                    : colors.mutedForeground;
              const stateIcon =
                item.state === 'failed'
                  ? 'alert-circle'
                  : item.state === 'sent'
                    ? 'check-circle'
                    : item.state === 'uploading'
                      ? 'upload-cloud'
                      : 'clock';
              return (
                <View
                  key={item.id}
                  style={styles.record}
                  testID={`queued-scan-${item.id}`}
                >
                  <View style={styles.recordIcon}>
                    <Feather name={stateIcon} size={17} color={stateColor} />
                  </View>
                  <View style={styles.recordMain}>
                    <Text style={styles.recordTitle} numberOfLines={1}>
                      {item.vesselAssetName}
                    </Text>
                    <Text style={styles.recordMeta} numberOfLines={1}>
                      {item.moduleType} · {item.fileName} ·{' '}
                      {formatSize(item.fileSize)}
                    </Text>
                    <Text
                      style={{
                        color: stateColor,
                        fontFamily: 'DMSans_500Medium',
                        fontSize: 11,
                      }}
                    >
                      {uploadQueueStatusLabel(item)}
                    </Text>
                  </View>
                  {item.state === 'failed' && user?.id ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Retry upload for ${item.vesselAssetName}`}
                      testID={`retry-upload-${item.id}`}
                      onPress={() => void retryQueuedScan(item.id)}
                      style={styles.retryButton}
                    >
                      <Text style={styles.retryText}>Retry</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.technicianLine}>
          <Feather name="user-check" size={15} color={colors.mutedForeground} />
          <Text style={styles.technicianText} numberOfLines={1}>
            Technician · {user.email ?? user.id}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          testID="upload-scan-button"
          disabled={
            isQueueing ||
            isPicking ||
            capturePhase !== 'idle' ||
            !!pendingCapturePreview
          }
          onPress={submitUpload}
          style={({ pressed }) => [
            styles.primaryButton,
            (isQueueing ||
              isPicking ||
              capturePhase !== 'idle' ||
              !!pendingCapturePreview) &&
              styles.disabled,
            pressed && !isQueueing && capturePhase === 'idle' && styles.pressed,
          ]}
        >
          {isQueueing ? (
            <ActivityIndicator color={colors.primaryForeground} size="small" />
          ) : (
            <Feather
              name="arrow-up-right"
              size={18}
              color={colors.primaryForeground}
            />
          )}
          <Text style={styles.primaryButtonText}>
            {isQueueing ? 'Saving scan on this device…' : 'Upload scan'}
          </Text>
        </Pressable>
        <Text style={styles.privacyNote}>
          Files are sent over a secure connection and stored with this record.
        </Text>
      </View>

      <View style={styles.historyHeader}>
        <View>
          <Text style={styles.cardEyebrow}>ON THIS ACCOUNT</Text>
          <Text style={styles.historyTitle}>Recent scans</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh recent scans"
          testID="refresh-scans"
          onPress={() => void scansQuery.refetch()}
          hitSlop={10}
          style={({ pressed }) => [
            styles.refreshButton,
            pressed && styles.pressed,
          ]}
        >
          <Feather name="refresh-cw" size={16} color={colors.foreground} />
        </Pressable>
      </View>

      <View style={styles.historyCard}>
        {scansQuery.isLoading ? (
          <View style={styles.historyState}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.stateText}>Loading recent records…</Text>
          </View>
        ) : scansQuery.isError ? (
          <View style={styles.historyState}>
            <Feather name="wifi-off" size={20} color={colors.mutedForeground} />
            <Text style={styles.stateText}>
              Recent records could not be loaded.
            </Text>
            <Pressable
              accessibilityRole="button"
              testID="retry-scans"
              onPress={() => void scansQuery.refetch()}
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : scans.length === 0 ? (
          <View style={styles.historyState}>
            <Feather name="archive" size={20} color={colors.mutedForeground} />
            <Text style={styles.stateText}>No scans uploaded yet.</Text>
            <Text style={styles.emptyHint}>
              Your latest field records will appear here.
            </Text>
          </View>
        ) : (
          scans.map((scan) => (
            <ScanRecord key={scan.id} scan={scan} colors={colors} />
          ))
        )}
      </View>

      <View style={styles.footerRow}>
        <Text style={styles.footerText}>ASC SPATIAL · FIELD RECORDS</Text>
        <Pressable
          accessibilityRole="button"
          testID="sign-out-button"
          onPress={() => void logout()}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

function InlineNotice({
  message,
  tone,
  colors,
}: {
  message: string;
  tone: 'error' | 'success';
  colors: ReturnType<typeof useColors>;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const color = tone === 'error' ? colors.destructive : colors.primary;
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        { borderColor: `${color}35`, backgroundColor: `${color}10` },
      ]}
    >
      <Feather
        name={tone === 'error' ? 'alert-circle' : 'check-circle'}
        size={16}
        color={color}
      />
      <Text style={[styles.noticeText, { color }]}>{message}</Text>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    page: {
      flex: 1,
      backgroundColor: colors.background,
    },
    pageContent: {
      paddingHorizontal: 22,
      gap: 22,
    },
    centerPage: {
      flex: 1,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingHorizontal: 24,
    },
    centerText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 14,
    },
    header: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    adminShortcut: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    adminShortcutText: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 11,
    },
    brandMark: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    brandLogo: {
      width: 38,
      height: 38,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    signInLogo: {
      width: 92,
      height: 92,
      borderRadius: 23,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 7,
    },
    brandName: {
      color: colors.foreground,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 12,
      letterSpacing: 1.1,
    },
    connection: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    connectionText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 11,
    },
    hero: {
      paddingTop: 14,
      gap: 9,
    },
    eyebrow: {
      color: colors.primary,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 10,
      letterSpacing: 1.4,
    },
    title: {
      color: colors.foreground,
      fontFamily: 'InstrumentSerif_400Regular',
      fontSize: 42,
      lineHeight: 46,
      letterSpacing: -0.8,
    },
    intro: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 15,
      lineHeight: 22,
      maxWidth: 340,
    },
    formCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 18,
      padding: 17,
      gap: 11,
    },
    sectionHeading: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 5,
    },
    cardEyebrow: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 1.15,
      marginBottom: 4,
    },
    cardTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
    },
    label: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      marginTop: 5,
    },
    segmentGroup: {
      flexDirection: 'row',
      gap: 8,
    },
    segment: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      borderRadius: 10,
      minHeight: 42,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
    },
    segmentSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.primary,
    },
    segmentText: {
      color: colors.foreground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 13,
    },
    segmentTextSelected: {
      color: colors.primaryForeground,
      fontFamily: 'DMSans_600SemiBold',
    },
    input: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.input,
      backgroundColor: colors.background,
      borderRadius: 10,
      paddingHorizontal: 12,
      color: colors.foreground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
    },
    filePicker: {
      minHeight: 68,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      backgroundColor: colors.background,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    captureCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.background,
      padding: 12,
      gap: 11,
    },
    captureHeading: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    captureIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.muted,
    },
    captureCopy: {
      flex: 1,
      gap: 3,
    },
    captureTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    captureCaption: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
    },
    captureButton: {
      minHeight: 42,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 11,
    },
    captureStartButton: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    captureStopButton: {
      backgroundColor: colors.card,
    },
    captureButtonText: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      textAlign: 'center',
    },
    captureStartButtonText: {
      color: colors.primaryForeground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    captureProgressTrack: {
      height: 5,
      overflow: 'hidden',
      borderRadius: 3,
      backgroundColor: colors.muted,
    },
    captureProgressFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: colors.primary,
    },
    captureProgressText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
    },
    captureCancel: {
      alignSelf: 'center',
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    captureCancelText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 11,
    },
    captureBusy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 42,
    },
    captureBusyCopy: {
      flex: 1,
      gap: 3,
    },
    fileIcon: {
      width: 38,
      height: 38,
      borderRadius: 11,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileCopy: {
      flex: 1,
      gap: 3,
    },
    fileTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    fileCaption: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
    },
    removeFile: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    technicianLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 4,
    },
    technicianText: {
      flex: 1,
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 10,
    },
    primaryButton: {
      minHeight: 50,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      borderRadius: 12,
      backgroundColor: colors.primary,
      paddingHorizontal: 16,
      marginTop: 4,
    },
    primaryButtonText: {
      color: colors.primaryForeground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
    },
    secondaryButton: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    secondaryButtonText: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
    },
    privacyNote: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
      textAlign: 'center',
    },
    footnote: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      textAlign: 'center',
      marginTop: 5,
    },
    notice: {
      borderWidth: 1,
      borderRadius: 10,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      padding: 11,
      marginTop: 2,
    },
    noticeText: {
      flex: 1,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
      lineHeight: 17,
    },
    historyHeader: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingTop: 2,
    },
    historyTitle: {
      color: colors.foreground,
      fontFamily: 'InstrumentSerif_400Regular',
      fontSize: 30,
      lineHeight: 34,
    },
    refreshButton: {
      width: 36,
      height: 36,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 2,
    },
    historyCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 16,
      overflow: 'hidden',
    },
    record: {
      minHeight: 72,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 13,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    recordIcon: {
      width: 36,
      height: 36,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.muted,
    },
    recordMain: {
      flex: 1,
      gap: 4,
    },
    recordTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    recordMeta: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 10,
    },
    recordFile: {
      alignItems: 'flex-end',
      gap: 3,
    },
    recordExtension: {
      color: colors.primary,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 9,
      letterSpacing: 0.6,
    },
    recordSize: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
    },
    historyState: {
      minHeight: 140,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      paddingHorizontal: 20,
      paddingVertical: 22,
    },
    stateText: {
      color: colors.foreground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 13,
      textAlign: 'center',
    },
    emptyHint: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      textAlign: 'center',
    },
    retryButton: {
      paddingHorizontal: 13,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.muted,
    },
    retryText: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    approvalCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 15,
      padding: 15,
    },
    approvalCopy: {
      flex: 1,
      gap: 4,
    },
    cardText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 2,
    },
    footerText: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 0.5,
    },
    signOutText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
    },
    pressed: {
      opacity: 0.82,
    },
    disabled: {
      opacity: 0.55,
    },
  });
}
