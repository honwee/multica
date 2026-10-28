package feishuorg

import (
	"reflect"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

func TestBuildPlanMappingsRoleConflictAndStableOutput(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete: true,
		Departments: []lark.OrgDepartment{
			{ID: "d1", Name: "Old team"},
			{ID: "d2", Name: "New team"},
		},
		Users: []lark.OrgUser{{
			UnionID:       "union-alice",
			OpenID:        "open-alice",
			Name:          "Alice",
			JobTitle:      "Engineer",
			DepartmentIDs: []string{"d2"},
			Active:        true,
		}},
	}
	mappings := []Mapping{
		{GroupID: "g3", Kind: "department", ExternalID: "d1", ExternalName: "Old team", MemberRole: "member"},
		{GroupID: "g2", Kind: "job_title", ExternalID: "Engineer", ExternalName: "Engineers", MemberRole: "admin"},
		{GroupID: "g1", Kind: "department", ExternalID: "d2", ExternalName: "New team", MemberRole: "owner"},
	}
	members := []Member{{
		MemberID: "m1",
		UserID:   "u1",
		Name:     "Alice",
		Role:     "member",
		UnionIDs: []string{"union-alice"},
		Tracked:  true,
	}}
	memberships := []Membership{
		{GroupID: "g3", UserID: "u1", Active: true},
		{GroupID: "g2", UserID: "u1", Active: false},
	}

	got, err := BuildPlan(snapshot, mappings, members, memberships)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	want := []Change{
		groupChange("u1", "Alice", "group_joined", "g1", "New team"),
		groupChange("u1", "Alice", "group_joined", "g2", "Engineers"),
		groupChange("u1", "Alice", "group_left", "g3", "Old team"),
		{UserID: "u1", UserName: "Alice", Action: "role_changed", Before: "member", After: "owner"},
	}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
	}
	if len(got.Warnings) != 0 {
		t.Fatalf("BuildPlan() warnings = %v", got.Warnings)
	}

	again, err := BuildPlan(snapshot, mappings, members, memberships)
	if err != nil {
		t.Fatalf("second BuildPlan() error = %v", err)
	}
	if !reflect.DeepEqual(got, again) {
		t.Fatalf("BuildPlan() is not idempotent: first %#v, second %#v", got, again)
	}
}

func TestBuildPlanRoleRules(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1"}},
		Users: []lark.OrgUser{{
			UnionID:       "union-u1",
			DepartmentIDs: []string{"d1"},
			Active:        true,
		}},
	}
	mapping := Mapping{GroupID: "g1", Kind: "department", ExternalID: "d1", ExternalName: "Team", MemberRole: "admin"}

	t.Run("preserve a higher manual role", func(t *testing.T) {
		member := Member{UserID: "u1", Name: "Alice", Role: "owner", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{member}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if len(got.Changes) != 0 {
			t.Fatalf("BuildPlan() changes = %#v, want none", got.Changes)
		}
	})

	t.Run("remove a managed role when no mapping remains", func(t *testing.T) {
		withoutMappings := snapshot
		withoutMappings.Users = append([]lark.OrgUser(nil), snapshot.Users...)
		withoutMappings.Users[0].DepartmentIDs = nil
		member := Member{UserID: "u1", Name: "Alice", Role: "admin", ManagedRole: "admin", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(withoutMappings, []Mapping{mapping}, []Member{member}, nil)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []Change{{UserID: "u1", UserName: "Alice", Action: "role_changed", Before: "admin", After: "member"}}
		if !reflect.DeepEqual(got.Changes, want) {
			t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
		}
	})

	t.Run("lower a managed role to the mapped role", func(t *testing.T) {
		member := Member{UserID: "u1", Name: "Alice", Role: "owner", ManagedRole: "admin", UnionIDs: []string{"union-u1"}, Tracked: true}
		otherOwner := Member{UserID: "u2", Name: "Owner", Role: "owner"}
		got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{member, otherOwner}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []Change{{UserID: "u1", UserName: "Alice", Action: "role_changed", Before: "owner", After: "admin"}}
		if !reflect.DeepEqual(got.Changes, want) {
			t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
		}
	})
}

func TestBuildPlanRoleAssignments(t *testing.T) {
	mapping := Mapping{GroupID: "g1", Kind: "department", ExternalID: "d1", ExternalName: "Team", MemberRole: "admin"}
	snapshot := lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1"}},
		Users: []lark.OrgUser{{
			UnionID:       "union-u1",
			DepartmentIDs: []string{"d1"},
			Active:        true,
		}},
	}

	t.Run("starts managing an already matching role", func(t *testing.T) {
		member := Member{UserID: "u1", Role: "admin", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{member}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if len(got.Changes) != 0 {
			t.Fatalf("BuildPlan() changes = %#v, want none", got.Changes)
		}
		want := []RoleAssignment{{UserID: "u1", Role: "admin"}}
		if !reflect.DeepEqual(got.RoleAssignments, want) {
			t.Fatalf("BuildPlan() role assignments = %#v, want %#v", got.RoleAssignments, want)
		}
	})

	t.Run("does not manage a higher manual role", func(t *testing.T) {
		member := Member{UserID: "u1", Role: "owner", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{member}, nil)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if len(got.RoleAssignments) != 0 {
			t.Fatalf("BuildPlan() role assignments = %#v, want none", got.RoleAssignments)
		}
	})

	t.Run("tracks removal of a previously managed role", func(t *testing.T) {
		withoutMappings := snapshot
		withoutMappings.Users = append([]lark.OrgUser(nil), snapshot.Users...)
		withoutMappings.Users[0].DepartmentIDs = nil
		member := Member{UserID: "u1", Role: "admin", ManagedRole: "admin", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(withoutMappings, []Mapping{mapping}, []Member{member}, nil)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []RoleAssignment{{UserID: "u1", Role: "member"}}
		if !reflect.DeepEqual(got.RoleAssignments, want) {
			t.Fatalf("BuildPlan() role assignments = %#v, want %#v", got.RoleAssignments, want)
		}
	})
}

func TestBuildPlanDisableAndMembershipHistory(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete: true,
		Users: []lark.OrgUser{{
			UnionID: "union-inactive",
			Active:  false,
		}},
	}
	members := []Member{
		{UserID: "u0", Name: "Owner", Role: "owner"},
		{UserID: "u1", Name: "Inactive", Role: "member", UnionIDs: []string{"union-inactive"}, Tracked: true},
		{UserID: "u2", Name: "Missing", Role: "member", UnionIDs: []string{"union-missing"}, Tracked: true},
		{UserID: "u3", Name: "Untracked", Role: "member", UnionIDs: []string{"union-untracked"}},
		{UserID: "u4", Name: "Already disabled", Role: "member", Disabled: true, UnionIDs: []string{"union-disabled"}, Tracked: true},
	}
	memberships := []Membership{
		{GroupID: "g1", UserID: "u1", Active: true},
		{GroupID: "history", UserID: "u1", Active: false},
		{GroupID: "g2", UserID: "u2", Active: true},
		{GroupID: "g3", UserID: "u3", Active: true},
		{GroupID: "g4", UserID: "u4", Active: true},
	}

	got, err := BuildPlan(snapshot, nil, members, memberships)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	want := []Change{
		groupChange("u1", "Inactive", "group_left", "g1", ""),
		{UserID: "u1", UserName: "Inactive", Action: "member_disabled", Before: "active", After: "disabled"},
	}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
	}
	if len(got.Warnings) != 2 {
		t.Fatalf("BuildPlan() warnings = %#v, want missing-member warnings for u2 and u4", got.Warnings)
	}
}

func TestBuildPlanEmptySnapshotCannotMassDisable(t *testing.T) {
	members := []Member{{UserID: "u1", Role: "member", Tracked: true}}
	memberships := []Membership{{GroupID: "g1", UserID: "u1", Active: true}}
	got, err := BuildPlan(lark.OrgSnapshot{Complete: true}, nil, members, memberships)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(got.Changes) != 0 {
		t.Fatalf("empty snapshot produced changes: %#v", got.Changes)
	}
	if len(got.Warnings) != 1 {
		t.Fatalf("empty snapshot warnings = %#v, want one verification warning", got.Warnings)
	}
}

func TestBuildPlanDisablesMatchedResignedMemberBeforeFirstGrant(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete: true,
		Users:    []lark.OrgUser{{OpenID: "open-resigned", Active: false}},
	}
	members := []Member{
		{UserID: "u0", Role: "owner"},
		{UserID: "u1", Role: "member", FeishuOpenID: "open-resigned"},
	}
	got, err := BuildPlan(snapshot, nil, members, nil)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	want := []Change{{UserID: "u1", Action: "member_disabled", Before: "active", After: "disabled"}}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
	}
}

func TestBuildPlanUnknownMappingsOnlyWarn(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1"}},
		Users: []lark.OrgUser{{
			UnionID:       "union-u1",
			JobTitle:      "Engineer",
			DepartmentIDs: []string{"d1"},
			Active:        true,
		}},
	}
	mappings := []Mapping{
		{GroupID: "g1", Kind: "department", ExternalID: "missing"},
		{GroupID: "g2", Kind: "job_title", ExternalID: "Manager"},
		{GroupID: "g1", Kind: "department", ExternalID: "missing"},
	}
	member := Member{UserID: "u1", Role: "member", UnionIDs: []string{"union-u1"}, Tracked: true}

	got, err := BuildPlan(snapshot, mappings, []Member{member}, nil)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(got.Changes) != 0 {
		t.Fatalf("BuildPlan() changes = %#v, want none", got.Changes)
	}
	wantWarnings := []string{
		`unknown department "missing" for group "g1"; mapping has no permissions`,
		`unknown job_title "Manager" for group "g2"; mapping has no permissions`,
	}
	if !reflect.DeepEqual(got.Warnings, wantWarnings) {
		t.Fatalf("BuildPlan() warnings = %#v, want %#v", got.Warnings, wantWarnings)
	}
}

func TestBuildPlanRejectsIncompleteSnapshot(t *testing.T) {
	got, err := BuildPlan(lark.OrgSnapshot{Complete: false}, nil, []Member{{UserID: "u1", Tracked: true}}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
	if err == nil {
		t.Fatal("BuildPlan() error = nil, want incomplete snapshot error")
	}
	if len(got.Changes) != 0 {
		t.Fatalf("BuildPlan() changes = %#v, want none", got.Changes)
	}
}

func TestBuildPlanIdentityFallbacks(t *testing.T) {
	tests := []struct {
		name   string
		member Member
		user   lark.OrgUser
	}{
		{
			name:   "union ID",
			member: Member{UnionIDs: []string{"union-u1"}, FeishuOpenID: "other-open", Email: "other@example.com"},
			user:   lark.OrgUser{UnionID: "union-u1", OpenID: "snapshot-open", Email: "snapshot@example.com"},
		},
		{
			name:   "Feishu open ID",
			member: Member{FeishuOpenID: "open-u1"},
			user:   lark.OrgUser{OpenID: "open-u1"},
		},
		{
			name:   "channel open ID",
			member: Member{ChannelOpenIDs: []string{"open-u1"}},
			user:   lark.OrgUser{OpenID: "open-u1"},
		},
		{
			name:   "case insensitive email",
			member: Member{Email: "Person@Example.com"},
			user:   lark.OrgUser{Email: "person@example.COM"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.member.UserID = "u1"
			tt.member.Name = "Alice"
			tt.member.Role = "member"
			tt.member.Tracked = true
			tt.user.DepartmentIDs = []string{"d1"}
			tt.user.Active = true
			snapshot := lark.OrgSnapshot{Complete: true, Departments: []lark.OrgDepartment{{ID: "d1"}}, Users: []lark.OrgUser{tt.user}}
			mapping := Mapping{GroupID: "g1", Kind: "department", ExternalID: "d1", ExternalName: "Team"}

			got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{tt.member}, nil)
			if err != nil {
				t.Fatalf("BuildPlan() error = %v", err)
			}
			want := []Change{groupChange("u1", "Alice", "group_joined", "g1", "Team")}
			if !reflect.DeepEqual(got.Changes, want) {
				t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
			}
		})
	}
}

func TestBuildPlanIdentityConflictsAreQuarantined(t *testing.T) {
	mapping := Mapping{GroupID: "g1", Kind: "department", ExternalID: "d1", ExternalName: "Team"}
	tests := []struct {
		name        string
		users       []lark.OrgUser
		members     []Member
		warningPart string
	}{
		{
			name:  "duplicate email",
			users: []lark.OrgUser{{Email: "same@example.com", DepartmentIDs: []string{"d1"}, Active: true}},
			members: []Member{
				{UserID: "u1", Email: "same@example.com", Tracked: true},
				{UserID: "u2", Email: "SAME@example.com", Tracked: true},
			},
			warningPart: "identity conflict",
		},
		{
			name:  "identifiers point to different members",
			users: []lark.OrgUser{{UnionID: "union-u1", OpenID: "open-u2", DepartmentIDs: []string{"d1"}, Active: true}},
			members: []Member{
				{UserID: "u1", UnionIDs: []string{"union-u1"}, Tracked: true},
				{UserID: "u2", FeishuOpenID: "open-u2", Tracked: true},
			},
			warningPart: "identity conflict",
		},
		{
			name: "duplicate snapshot identity",
			users: []lark.OrgUser{
				{UnionID: "union-u1", DepartmentIDs: []string{"d1"}, Active: true},
				{UnionID: "union-u1", DepartmentIDs: []string{"d1"}, Active: true},
			},
			members:     []Member{{UserID: "u1", UnionIDs: []string{"union-u1"}, Tracked: true}},
			warningPart: "duplicate Feishu identity",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snapshot := lark.OrgSnapshot{Complete: true, Departments: []lark.OrgDepartment{{ID: "d1"}}, Users: tt.users}
			got, err := BuildPlan(snapshot, []Mapping{mapping}, tt.members, nil)
			if err != nil {
				t.Fatalf("BuildPlan() error = %v", err)
			}
			if len(got.Changes) != 0 {
				t.Fatalf("BuildPlan() changes = %#v, want none", got.Changes)
			}
			if len(got.Warnings) != 1 || !strings.Contains(got.Warnings[0], tt.warningPart) {
				t.Fatalf("BuildPlan() warnings = %v, want one containing %q", got.Warnings, tt.warningPart)
			}
		})
	}
}

func TestBuildPlanRestoresDisabledMemberWithCurrentAccess(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete: true,
		Departments: []lark.OrgDepartment{
			{ID: "d1"},
			{ID: "d2"},
		},
		Users: []lark.OrgUser{{
			UnionID:       "union-u1",
			DepartmentIDs: []string{"d2"},
			Active:        true,
		}},
	}
	mappings := []Mapping{
		{GroupID: "g1", Kind: "department", ExternalID: "d1", ExternalName: "Old"},
		{GroupID: "g2", Kind: "department", ExternalID: "d2", ExternalName: "New"},
	}
	member := Member{UserID: "u1", Name: "Alice", Role: "member", Disabled: true, UnionIDs: []string{"union-u1"}, Tracked: true}

	got, err := BuildPlan(snapshot, mappings, []Member{member}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	want := []Change{
		groupChange("u1", "Alice", "group_joined", "g2", "New"),
		groupChange("u1", "Alice", "group_left", "g1", "Old"),
		{UserID: "u1", UserName: "Alice", Action: "member_restored", Before: "disabled", After: "active"},
	}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
	}
}

func TestBuildPlanProtectsLastActiveOwner(t *testing.T) {
	t.Run("disable is skipped with membership intact", func(t *testing.T) {
		member := Member{UserID: "u1", Name: "Owner", Role: "owner", UnionIDs: []string{"union-u1"}, Tracked: true}
		snapshot := lark.OrgSnapshot{Complete: true, Users: []lark.OrgUser{{UnionID: "union-u1", Active: false}}}
		got, err := BuildPlan(snapshot, nil, []Member{member}, []Membership{{GroupID: "g1", UserID: "u1", Active: true}})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []Change{{
			UserID: "u1", UserName: "Owner", Action: "skipped", Before: "active", After: "disabled",
			Reason: "member_disabled skipped: at least one active owner is required",
		}}
		if !reflect.DeepEqual(got.Changes, want) {
			t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
		}
	})

	t.Run("demotion is skipped", func(t *testing.T) {
		snapshot := lark.OrgSnapshot{Complete: true, Users: []lark.OrgUser{{UnionID: "union-u1", Active: true}}}
		member := Member{UserID: "u1", Name: "Owner", Role: "owner", ManagedRole: "owner", UnionIDs: []string{"union-u1"}, Tracked: true}
		got, err := BuildPlan(snapshot, nil, []Member{member}, nil)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []Change{{
			UserID: "u1", UserName: "Owner", Action: "skipped", Before: "owner", After: "member",
			Reason: "role_changed skipped: at least one active owner is required",
		}}
		if !reflect.DeepEqual(got.Changes, want) {
			t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
		}
	})

	t.Run("disable proceeds when another owner remains", func(t *testing.T) {
		members := []Member{
			{UserID: "u1", Name: "Leaving", Role: "owner", UnionIDs: []string{"union-u1"}, Tracked: true},
			{UserID: "u2", Name: "Remaining", Role: "owner"},
		}
		snapshot := lark.OrgSnapshot{Complete: true, Users: []lark.OrgUser{{UnionID: "union-u1", Active: false}}}
		got, err := BuildPlan(snapshot, nil, members, nil)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		want := []Change{{UserID: "u1", UserName: "Leaving", Action: "member_disabled", Before: "active", After: "disabled"}}
		if !reflect.DeepEqual(got.Changes, want) {
			t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
		}
	})
}

func TestBuildPlanUserMappings(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering"}},
		Users:       []lark.OrgUser{{UnionID: "union-alice", OpenID: "open-alice", Name: "Alice", DepartmentIDs: []string{"d1"}, Active: true}},
	}
	mappings := []Mapping{
		{GroupID: "g-user", Kind: "user", ExternalID: "union-alice", ExternalName: "Alice", MemberRole: "admin"},
		{GroupID: "g-dept", Kind: "department", ExternalID: "d1", ExternalName: "Engineering", MemberRole: "member"},
	}
	member := Member{MemberID: "m1", UserID: "u1", Name: "Alice", Role: "member", UnionIDs: []string{"union-alice"}, Tracked: true}
	got, err := BuildPlan(snapshot, mappings, []Member{member}, nil)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	want := []Change{
		groupChange("u1", "Alice", "group_joined", "g-dept", "Engineering"),
		groupChange("u1", "Alice", "group_joined", "g-user", "Alice"),
		{UserID: "u1", UserName: "Alice", Action: "role_changed", Before: "member", After: "admin"},
	}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("BuildPlan() changes = %#v, want %#v", got.Changes, want)
	}
	if len(got.RoleAssignments) != 1 || got.RoleAssignments[0].Role != "admin" {
		t.Fatalf("BuildPlan() role assignments = %#v, want admin", got.RoleAssignments)
	}
}

func TestBuildPlanUserMappingDoesNotInvite(t *testing.T) {
	snapshot := lark.OrgSnapshot{
		Complete: true,
		Users:    []lark.OrgUser{{UnionID: "union-new", OpenID: "open-new", Name: "New Person", Active: true}},
	}
	mapping := Mapping{GroupID: "g-user", Kind: "user", ExternalID: "union-new", ExternalName: "New Person", MemberRole: "member"}
	member := Member{MemberID: "m1", UserID: "u1", Name: "Existing", Role: "member", UnionIDs: []string{"union-other"}, Tracked: true}
	got, err := BuildPlan(snapshot, []Mapping{mapping}, []Member{member}, nil)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(got.Changes) != 0 || len(got.RoleAssignments) != 0 {
		t.Fatalf("user mapping must not invite: changes=%#v role assignments=%#v", got.Changes, got.RoleAssignments)
	}
}

func groupChange(userID, userName, action, groupID, groupName string) Change {
	change := Change{UserID: userID, UserName: userName, Action: action, GroupID: groupID, GroupName: groupName}
	if action == "group_joined" {
		change.Before = "inactive"
		change.After = "active"
	} else {
		change.Before = "active"
		change.After = "inactive"
	}
	return change
}
