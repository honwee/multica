import { useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { Invitation, MemberWithUser } from "@multica/core/types";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { useAuthStore } from "@/data/auth-store";
import {
  invitationListOptions,
  memberListOptions,
} from "@/data/queries/members";
import {
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMemberRole,
} from "@/data/mutations/members";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { memberActionPermissions } from "@/lib/member-directory";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function MembersSettingsScreen() {
  const { t } = useT("settings");
  const { t: tCommon } = useT();
  const { colorScheme } = useColorScheme();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const userId = useAuthStore((s) => s.user?.id);
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const membersQuery = useQuery(memberListOptions(wsId));
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const currentMember = members.find((member) => member.user_id === userId);
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const invitationsQuery = useQuery(invitationListOptions(wsId, canManage));
  const invitations = invitationsQuery.data ?? [];
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const revokeInvitation = useRevokeInvitation();
  const busy = updateRole.isPending || removeMember.isPending || revokeInvitation.isPending;
  const needle = query.trim().toLocaleLowerCase();
  const visibleMembers = needle
    ? members.filter((member) =>
        `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle),
      )
    : members;

  const headerRight = useCallback(() => {
    if (!canManage || !wsSlug) return null;
    return (
      <IconButton
        name="add"
        accessibilityLabel={t("members.invite")}
        onPress={() => router.push(`/${wsSlug}/more/settings/invite`)}
      />
    );
  }, [canManage, t, wsSlug]);

  const changeRole = (member: MemberWithUser) => {
    const permissions = memberActionPermissions(currentMember, member, ownerCount);
    if (!permissions.canEditRole) return;
    const roles = permissions.roles.filter((role) => role !== member.role);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: t("members.change_role"),
        options: [
          ...roles.map((role) => t("members.set_role", { role: t(`members.roles.${role}`) })),
          tCommon("actions.cancel"),
        ],
        cancelButtonIndex: roles.length,
      },
      (index) => {
        const role = roles[index];
        if (!role) return;
        setActionError(null);
        updateRole.mutate(
          { memberId: member.id, role },
          { onError: () => setActionError(t("members.update_failed")) },
        );
      },
    );
  };

  const confirmRemove = (member: MemberWithUser) => {
    Alert.alert(t("members.remove_title", { name: member.name }), t("members.remove_message"), [
      { text: tCommon("actions.cancel"), style: "cancel" },
      {
        text: t("members.remove"),
        style: "destructive",
        onPress: () => {
          setActionError(null);
          removeMember.mutate(member.id, {
            onError: () => setActionError(t("members.remove_failed")),
          });
        },
      },
    ]);
  };

  const confirmRevoke = (invitation: Invitation) => {
    Alert.alert(t("members.revoke_title"), t("members.revoke_message", { email: invitation.invitee_email }), [
      { text: tCommon("actions.cancel"), style: "cancel" },
      {
        text: t("members.revoke"),
        style: "destructive",
        onPress: () => {
          setActionError(null);
          revokeInvitation.mutate(invitation.id, {
            onError: () => setActionError(t("members.revoke_failed")),
          });
        },
      },
    ]);
  };

  const showMemberActions = (member: MemberWithUser) => {
    const permissions = memberActionPermissions(currentMember, member, ownerCount);
    const actions: { label: string; onPress: () => void; destructive?: boolean }[] = [];
    if (permissions.canEditRole) {
      actions.push({ label: t("members.change_role"), onPress: () => changeRole(member) });
    }
    if (permissions.canRemove) {
      actions.push({ label: t("members.remove"), destructive: true, onPress: () => confirmRemove(member) });
    }
    if (!actions.length) return;
    const destructiveIndex = actions.findIndex((action) => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.label), tCommon("actions.cancel")],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: destructiveIndex >= 0 ? destructiveIndex : undefined,
      },
      (index) => actions[index]?.onPress(),
    );
  };

  const refresh = () => {
    void membersQuery.refetch();
    if (canManage) void invitationsQuery.refetch();
  };
  const loadError = membersQuery.error || (canManage && invitationsQuery.error);

  return (
    <>
      <Stack.Screen options={{ headerRight }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-4 py-4 gap-5"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={membersQuery.isRefetching} onRefresh={refresh} />}
      >
        <Input
          accessibilityLabel={t("members.search_members")}
          placeholder={t("members.search_members")}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {actionError ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">{actionError}</Text>
        ) : null}
        {membersQuery.isLoading ? (
          <ActivityIndicator className="py-8" />
        ) : loadError ? (
          <Pressable onPress={refresh} className="rounded-md border border-border bg-card p-4">
            <Text className="text-sm text-destructive">{t("members.load_failed")}</Text>
            <Text className="mt-2 text-sm text-foreground">{t("members.retry")}</Text>
          </Pressable>
        ) : (
          <View className="gap-2">
            <Text className="px-1 text-xs uppercase tracking-wider text-muted-foreground">
              {t("members.members")} · {visibleMembers.length}
            </Text>
            <View className="overflow-hidden rounded-md border border-border bg-card">
              {visibleMembers.map((member, index) => {
                const permissions = memberActionPermissions(currentMember, member, ownerCount);
                return (
                  <View key={member.id}>
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      <ActorAvatar type="member" id={member.user_id} name={member.name} avatarUrl={member.avatar_url} size={40} />
                      <View className="min-w-0 flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="shrink text-base font-medium" numberOfLines={1}>{member.name}</Text>
                          {member.user_id === userId ? (
                            <Text className="text-xs text-muted-foreground">{t("members.you")}</Text>
                          ) : null}
                        </View>
                        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                          {member.email.endsWith("@feishu.invalid") ? t("members.internal_email") : member.email}
                        </Text>
                        <Text className="mt-1 text-xs text-muted-foreground">{t(`members.roles.${member.role}`)}</Text>
                      </View>
                      {permissions.canEditRole || permissions.canRemove ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("members.actions_a11y", { name: member.name })}
                          disabled={busy}
                          onPress={() => showMemberActions(member)}
                          className="size-10 items-center justify-center rounded-md active:bg-secondary disabled:opacity-50"
                        >
                          <Ionicons name="ellipsis-horizontal" size={20} color={THEME[colorScheme].mutedForeground} />
                        </Pressable>
                      ) : null}
                    </View>
                    {index < visibleMembers.length - 1 ? <Separator /> : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}
        {canManage && !invitationsQuery.isLoading && !invitationsQuery.error ? (
          <View className="gap-2">
            <Text className="px-1 text-xs uppercase tracking-wider text-muted-foreground">{t("members.pending")}</Text>
            <View className="overflow-hidden rounded-md border border-border bg-card">
              {invitations.length ? invitations.map((invitation, index) => (
                <View key={invitation.id}>
                  <View className="flex-row items-center gap-3 px-4 py-3">
                    <View className="size-10 items-center justify-center rounded-full bg-muted">
                      <Ionicons name="mail-outline" size={19} color={THEME[colorScheme].mutedForeground} />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-sm font-medium" numberOfLines={1}>
                        {invitation.invitee_name ||
                          (invitation.invitee_email.endsWith("@feishu.invalid") ? t("members.internal_email") : invitation.invitee_email)}
                      </Text>
                      <Text className="mt-1 text-xs text-muted-foreground">{t(`members.roles.${invitation.role}`)}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("members.revoke")}
                      disabled={busy}
                      onPress={() => confirmRevoke(invitation)}
                      className="min-h-10 justify-center px-2 disabled:opacity-50"
                    >
                      <Text className="text-sm text-destructive">{t("members.revoke")}</Text>
                    </Pressable>
                  </View>
                  {index < invitations.length - 1 ? <Separator /> : null}
                </View>
              )) : <Text className="p-4 text-sm text-muted-foreground">{t("members.no_invitations")}</Text>}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}
