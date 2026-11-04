import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LarkOrganizationUser, MemberRole } from "@multica/core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalCloseButton } from "@/components/ui/modal-close-button";
import { Text } from "@/components/ui/text";
import { api } from "@/data/api";
import { memberKeys } from "@/data/queries/members";
import { larkOrganizationOptions } from "@/data/queries/lark";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { searchFeishuDirectory } from "@/lib/member-directory";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function InviteMemberScreen() {
  const { t } = useT("settings");
  const { colorScheme } = useColorScheme();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const qc = useQueryClient();
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [selected, setSelected] = useState<LarkOrganizationUser | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [error, setError] = useState<string | null>(null);
  const organization = useQuery(larkOrganizationOptions(wsId));
  const candidates = useMemo(
    () => searchFeishuDirectory(organization.data?.catalog?.users, directoryQuery),
    [directoryQuery, organization.data],
  );

  const invite = useMutation({
    mutationFn: async () => {
      if (!wsId) throw new Error("Workspace unavailable");
      const invitation = await api.createMember(wsId, {
        ...(selected ? { feishu_union_id: selected.union_id } : { email: email.trim() }),
        role,
      });
      if (!invitation.id) throw new Error("Invalid invitation response");
      return invitation;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: memberKeys.invitations(wsId) });
      router.back();
    },
    onError: () => setError(t("members.invitation_failed")),
  });

  const chooseCandidate = (candidate: LarkOrganizationUser) => {
    setSelected(candidate);
    setDirectoryQuery(candidate.name);
    setEmail("");
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="flex-row items-center justify-between px-4 pb-3 pt-4">
        <Text className="text-base font-semibold">{t("members.invite")}</Text>
        <ModalCloseButton />
      </View>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-4 pb-8"
      >
        <View className="gap-2">
          <Text className="text-sm font-medium">{t("members.search_directory")}</Text>
          <Input
            accessibilityLabel={t("members.search_directory")}
            placeholder={t("members.search_directory")}
            value={directoryQuery}
            autoFocus
            autoCorrect={false}
            onChangeText={(value) => {
              setDirectoryQuery(value);
              setSelected(null);
              setError(null);
            }}
          />
          {directoryQuery.trim() && !selected ? (
            <View className="overflow-hidden rounded-md border border-border bg-card">
              {organization.isLoading ? (
                <ActivityIndicator className="p-4" />
              ) : candidates.length ? candidates.map((candidate) => (
                <Pressable
                  key={candidate.union_id}
                  accessibilityRole="button"
                  onPress={() => chooseCandidate(candidate)}
                  className="border-b border-border px-3 py-3 last:border-b-0 active:bg-secondary"
                >
                  <Text className="text-sm font-medium">{candidate.name}</Text>
                  <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={2}>
                    {[candidate.job_title, ...candidate.departments].filter(Boolean).join(" · ")}
                  </Text>
                </Pressable>
              )) : (
                <Text className="p-3 text-xs text-muted-foreground">{t("members.no_directory_results")}</Text>
              )}
            </View>
          ) : null}
          {selected ? (
            <View className="flex-row items-center gap-2 rounded-md bg-secondary p-3">
              <Ionicons name="checkmark-circle" size={18} color={THEME[colorScheme].primary} />
              <Text className="flex-1 text-sm">{selected.name}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("members.search_directory")}
                onPress={() => {
                  setSelected(null);
                  setDirectoryQuery("");
                }}
                className="size-8 items-center justify-center"
              >
                <Ionicons name="close" size={18} color={THEME[colorScheme].mutedForeground} />
              </Pressable>
            </View>
          ) : null}
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium">{t("members.email")}</Text>
          <Input
            accessibilityLabel={t("members.email")}
            placeholder={t("members.email_placeholder")}
            value={email}
            editable={!selected}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => {
              setEmail(value);
              setSelected(null);
              setError(null);
            }}
          />
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium">{t("members.role")}</Text>
          <View className="flex-row gap-2">
            {(["member", "admin"] as const).map((value) => (
              <Button
                key={value}
                variant={role === value ? "secondary" : "outline"}
                className="flex-1"
                accessibilityState={{ selected: role === value }}
                onPress={() => setRole(value)}
              >
                <Text>{t(`members.roles.${value}`)}</Text>
              </Button>
            ))}
          </View>
        </View>

        {error ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">{error}</Text>
        ) : null}
        <Button
          disabled={invite.isPending || (!selected && !email.trim())}
          onPress={() => {
            setError(null);
            invite.mutate();
          }}
        >
          <Text>{invite.isPending ? t("members.sending") : t("members.send")}</Text>
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
