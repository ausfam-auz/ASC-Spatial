import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getGetTechnicianAccessHistoryQueryKey,
  getListTechniciansQueryKey,
  useGetAccount,
  useGetTechnicianAccessHistory,
  useListTechnicians,
  useUpdateTechnicianAccess,
  type TechnicianAccount,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

function accountName(account: TechnicianAccount): string {
  const name = [account.firstName, account.lastName].filter(Boolean).join(' ');
  return name || account.email || `Account ${account.id.slice(0, 8)}`;
}

function AccessHistory({ userId }: { userId: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const history = useGetTechnicianAccessHistory(userId);

  if (history.isLoading) {
    return (
      <View style={styles.historyState}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.mutedText}>Loading access history…</Text>
      </View>
    );
  }
  if (history.isError) {
    return (
      <View style={styles.historyState}>
        <Text style={styles.errorText}>Access history could not be loaded.</Text>
        <Pressable onPress={() => void history.refetch()}>
          <Text style={styles.linkText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const events = history.data?.events ?? [];
  if (!events.length) {
    return (
      <Text style={styles.historyEmpty}>
        No technician access decisions have been recorded.
      </Text>
    );
  }

  return (
    <View style={styles.historyList}>
      {events.map((event) => {
        const name = [
          event.changedBy.firstName,
          event.changedBy.lastName,
        ].filter(Boolean).join(' ');
        return (
          <View key={event.id} style={styles.historyEvent}>
            <View style={styles.historyEventCopy}>
              <Text style={styles.historyTransition}>
                {event.previousIsTechnician ? 'Field Technician' : 'Pending'}
                {' → '}
                {event.isTechnician ? 'Field Technician' : 'Pending'}
              </Text>
              <Text style={styles.mutedText}>
                {name || event.changedBy.email || 'Workspace administrator'}
              </Text>
            </View>
            <Text style={styles.historyDate}>
              {new Date(event.changedAt).toLocaleDateString()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function TechnicianRow({
  account,
  disabled,
  expanded,
  onToggleAccess,
  onToggleHistory,
}: {
  account: TechnicianAccount;
  disabled: boolean;
  expanded: boolean;
  onToggleAccess: () => void;
  onToggleHistory: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const approved = account.isTechnician;

  return (
    <View style={styles.accountRow}>
      <View style={styles.accountTopline}>
        <View style={styles.accountIdentity}>
          <View
            style={[
              styles.accountIcon,
              approved ? styles.approvedIcon : styles.pendingIcon,
            ]}
          >
            <Feather
              name={approved ? 'user-check' : 'user'}
              size={16}
              color={approved ? colors.primary : colors.mutedForeground}
            />
          </View>
          <View style={styles.accountCopy}>
            <Text style={styles.accountName} numberOfLines={1}>
              {accountName(account)}
            </Text>
            <Text style={styles.accountEmail} numberOfLines={1}>
              {account.email ?? 'Email unavailable'}
            </Text>
            <Text style={styles.accountDate}>
              Registered {new Date(account.createdAt).toLocaleDateString()}
            </Text>
          </View>
        </View>
        <View style={[styles.levelBadge, approved ? styles.approvedBadge : styles.pendingBadge]}>
          <Text style={[styles.levelText, approved ? styles.approvedText : styles.pendingText]}>
            {approved ? 'Field Technician' : 'Pending'}
          </Text>
        </View>
      </View>

      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Hide' : 'Show'} access history for ${account.email ?? account.id}`}
          testID={`technician-history-${account.id}`}
          onPress={onToggleHistory}
          style={({ pressed }) => [
            styles.historyButton,
            pressed && styles.pressed,
          ]}
        >
          <Feather name="clock" size={14} color={colors.foreground} />
          <Text style={styles.historyButtonText}>
            {expanded ? 'Hide history' : 'Access history'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID={`technician-level-${account.id}`}
          disabled={disabled}
          onPress={onToggleAccess}
          style={({ pressed }) => [
            approved ? styles.revokeButton : styles.approveButton,
            disabled && styles.disabledButton,
            pressed && !disabled && styles.pressed,
          ]}
        >
          {disabled ? (
            <ActivityIndicator size="small" color={approved ? colors.foreground : colors.primaryForeground} />
          ) : (
            <Feather
              name={approved ? 'minus-circle' : 'check'}
              size={14}
              color={approved ? colors.foreground : colors.primaryForeground}
            />
          )}
          <Text style={approved ? styles.revokeButtonText : styles.approveButtonText}>
            {approved ? 'Set Pending' : 'Approve technician'}
          </Text>
        </Pressable>
      </View>

      {expanded ? <AccessHistory userId={account.id} /> : null}
    </View>
  );
}

export default function TechnicianAccessScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { isLoaded, isSignedIn } = useAuth();
  const account = useGetAccount({
    query: { enabled: isLoaded && !!isSignedIn, retry: false },
  });
  const isAdmin = Boolean(account.data?.user?.isAdmin);
  const accountsQuery = useListTechnicians({
    query: {
      queryKey: getListTechniciansQueryKey(),
      enabled: isAdmin,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  });
  const updateAccess = useUpdateTechnicianAccess({
    mutation: {
      onSuccess: async (_data, variables) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getListTechniciansQueryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: getGetTechnicianAccessHistoryQueryKey(variables.userId),
          }),
        ]);
      },
    },
  });
  const [emailFilter, setEmailFilter] = useState('');
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const accounts = accountsQuery.data?.accounts ?? [];
  const normalizedFilter = emailFilter.trim().toLowerCase();
  const matchingAccounts = accounts.filter((entry) =>
    !normalizedFilter ||
    [entry.email, accountName(entry)]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedFilter)),
  );
  const pending = matchingAccounts.filter((entry) => !entry.isTechnician);
  const approved = matchingAccounts.filter((entry) => entry.isTechnician);

  if (!isLoaded || (isSignedIn && account.isLoading)) {
    return (
      <View style={[styles.centerPage, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.mutedText}>Checking administrator access…</Text>
      </View>
    );
  }
  if (!isSignedIn) return <Redirect href="/sign-in" />;
  if (account.isError || !account.data?.user) {
    return (
      <View style={[styles.centerPage, { paddingTop: insets.top }]}>
        <Text style={styles.pageTitle}>Account access unavailable</Text>
        <Text style={styles.mutedText}>
          Your workspace account could not be loaded.
        </Text>
        <Pressable onPress={() => void account.refetch()} style={styles.outlineButton}>
          <Text style={styles.historyButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!isAdmin) {
    return (
      <View style={[styles.centerPage, { paddingTop: insets.top }]}>
        <Feather name="lock" size={24} color={colors.destructive} />
        <Text style={styles.pageTitle}>Administrator access required</Text>
        <Text style={styles.mutedText}>
          Only workspace administrators can change technician access.
        </Text>
        <Pressable onPress={() => router.replace('/')} style={styles.outlineButton}>
          <Text style={styles.historyButtonText}>Return to workspace</Text>
        </Pressable>
      </View>
    );
  }

  function accountRows(rows: TechnicianAccount[]) {
    return rows.map((technician) => (
      <TechnicianRow
        key={technician.id}
        account={technician}
        disabled={updateAccess.isPending}
        expanded={expandedHistory === technician.id}
        onToggleHistory={() =>
          setExpandedHistory((current) =>
            current === technician.id ? null : technician.id,
          )
        }
        onToggleAccess={() =>
          updateAccess.mutate({
            userId: technician.id,
            data: { isTechnician: !technician.isTechnician },
          })
        }
      />
    ));
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Return to workspace"
          onPress={() => router.replace('/')}
          style={styles.backButton}
        >
          <Feather name="arrow-left" size={17} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerBrand}>
          <Text style={styles.brandName}>ASC SPATIAL</Text>
          <Text style={styles.brandCaption}>ADMINISTRATION</Text>
        </View>
      </View>

      <View style={styles.titleBlock}>
        <View style={styles.titleIcon}>
          <Feather name="shield" size={20} color={colors.primary} />
        </View>
        <Text style={styles.eyebrow}>ACCESS SETTINGS</Text>
        <Text style={styles.pageTitle}>Technician review</Text>
        <Text style={styles.intro}>
          Find a registered account by email and set its level to Pending or
          Field Technician.
        </Text>
      </View>

      <View style={styles.ownerNote}>
        <Feather name="info" size={16} color={colors.primary} />
        <Text style={styles.ownerNoteText}>
          Administrator access is appointed separately by the workspace owner.
          New users must create an account before they appear here.
        </Text>
      </View>

      <Text style={styles.sectionLabel}>EMAIL ADDRESS</Text>
      <View style={styles.searchField}>
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          accessibilityLabel="Find a registered account by email"
          testID="technician-email-filter"
          value={emailFilter}
          onChangeText={setEmailFilter}
          placeholder="name@company.com"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          style={styles.searchInput}
        />
        {emailFilter ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear email search"
            onPress={() => setEmailFilter('')}
            hitSlop={8}
          >
            <Feather name="x-circle" size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>

      {updateAccess.isError ? (
        <View style={styles.errorNotice}>
          <Text style={styles.errorText}>
            Technician access could not be updated. Refresh and try again.
          </Text>
        </View>
      ) : null}

      {accountsQuery.isLoading ? (
        <View style={styles.loadingCard}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.mutedText}>Loading workspace accounts…</Text>
        </View>
      ) : accountsQuery.isError ? (
        <View style={styles.loadingCard}>
          <Text style={styles.errorText}>Workspace accounts could not be loaded.</Text>
          <Pressable onPress={() => void accountsQuery.refetch()} style={styles.outlineButton}>
            <Text style={styles.historyButtonText}>Refresh accounts</Text>
          </Pressable>
        </View>
      ) : normalizedFilter && matchingAccounts.length === 0 ? (
        <View style={styles.loadingCard}>
          <Feather name="search" size={20} color={colors.mutedForeground} />
          <Text style={styles.mutedText}>
            No registered account matches that email.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Pending approval</Text>
            <Text style={styles.pendingCount}>{pending.length}</Text>
          </View>
          <View style={styles.accountList}>
            {pending.length ? (
              accountRows(pending)
            ) : (
              <Text style={styles.emptyText}>
                {normalizedFilter
                  ? 'This account is already approved.'
                  : 'There are no accounts waiting for review.'}
              </Text>
            )}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Approved technicians</Text>
            <Text style={styles.approvedCount}>{approved.length}</Text>
          </View>
          <View style={styles.accountList}>
            {approved.length ? (
              accountRows(approved)
            ) : (
              <Text style={styles.emptyText}>
                {normalizedFilter
                  ? 'This account is currently pending.'
                  : 'No approved technicians yet.'}
              </Text>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: 20, gap: 14 },
    centerPage: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      paddingHorizontal: 24,
      gap: 12,
    },
    header: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 10,
    },
    backButton: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    headerBrand: { gap: 2 },
    brandName: {
      color: colors.foreground,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 12,
      letterSpacing: 1,
    },
    brandCaption: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 1.2,
    },
    titleBlock: { gap: 8, marginBottom: 4 },
    titleIcon: {
      width: 42,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 13,
      backgroundColor: colors.muted,
      marginBottom: 2,
    },
    eyebrow: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 1.5,
    },
    pageTitle: {
      color: colors.foreground,
      fontFamily: 'InstrumentSerif_400Regular',
      fontSize: 34,
      lineHeight: 40,
    },
    intro: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 20,
    },
    ownerNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.card,
      padding: 12,
    },
    ownerNoteText: {
      flex: 1,
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
    },
    sectionLabel: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
      letterSpacing: 1.3,
      marginTop: 2,
    },
    searchField: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.card,
      paddingHorizontal: 13,
    },
    searchInput: {
      flex: 1,
      minHeight: 46,
      color: colors.foreground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 8,
    },
    sectionTitle: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
    },
    pendingCount: {
      color: colors.primary,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 11,
    },
    approvedCount: {
      color: colors.primary,
      fontFamily: 'IBMPlexMono_500Medium',
      fontSize: 11,
    },
    accountList: {
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.card,
    },
    accountRow: {
      padding: 13,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 12,
    },
    accountTopline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    accountIdentity: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    accountIcon: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 11,
    },
    approvedIcon: { backgroundColor: colors.muted },
    pendingIcon: { backgroundColor: colors.muted },
    accountCopy: { flex: 1, minWidth: 0, gap: 2 },
    accountName: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
    },
    accountEmail: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
    },
    accountDate: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
    },
    levelBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 5 },
    approvedBadge: { backgroundColor: colors.muted },
    pendingBadge: { backgroundColor: colors.muted },
    levelText: { fontFamily: 'DMSans_600SemiBold', fontSize: 9 },
    approvedText: { color: colors.primary },
    pendingText: { color: colors.mutedForeground },
    rowActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    historyButton: {
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 10,
    },
    historyButtonText: {
      color: colors.foreground,
      fontFamily: 'DMSans_500Medium',
      fontSize: 11,
    },
    approveButton: {
      flex: 1,
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingHorizontal: 8,
    },
    approveButtonText: {
      color: colors.primaryForeground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 11,
    },
    revokeButton: {
      flex: 1,
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 8,
    },
    revokeButtonText: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 11,
    },
    disabledButton: { opacity: 0.6 },
    pressed: { opacity: 0.72 },
    historyState: {
      alignItems: 'flex-start',
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    historyList: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 4,
    },
    historyEvent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    historyEventCopy: { flex: 1, gap: 3 },
    historyTransition: {
      color: colors.foreground,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 11,
    },
    historyDate: {
      color: colors.mutedForeground,
      fontFamily: 'IBMPlexMono_400Regular',
      fontSize: 9,
    },
    historyEmpty: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    emptyText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      padding: 14,
    },
    loadingCard: {
      alignItems: 'center',
      gap: 11,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.card,
      padding: 22,
    },
    mutedText: {
      color: colors.mutedForeground,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
    },
    errorText: {
      color: colors.destructive,
      fontFamily: 'DMSans_500Medium',
      fontSize: 12,
      lineHeight: 18,
    },
    errorNotice: {
      borderWidth: 1,
      borderColor: colors.destructive,
      borderRadius: 10,
      backgroundColor: colors.card,
      padding: 11,
    },
    linkText: {
      color: colors.primary,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
    },
    outlineButton: {
      minHeight: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
    },
  });
}
