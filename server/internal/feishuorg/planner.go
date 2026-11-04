package feishuorg

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

type Mapping struct {
	GroupID      string   `json:"group_id"`
	Kind         string   `json:"kind"`
	ExternalID   string   `json:"external_id"`
	ExternalName string   `json:"external_name"`
	MemberRole   string   `json:"member_role"`
	AgentIDs     []string `json:"agent_ids"`
}

type Member struct {
	MemberID       string   `json:"member_id"`
	UserID         string   `json:"user_id"`
	Name           string   `json:"name"`
	Email          string   `json:"email"`
	Role           string   `json:"role"`
	FeishuOpenID   string   `json:"feishu_open_id"`
	ManagedRole    string   `json:"managed_role"`
	Disabled       bool     `json:"disabled"`
	ChannelOpenIDs []string `json:"channel_open_ids"`
	UnionIDs       []string `json:"union_ids"`
	Tracked        bool     `json:"tracked"`
}

type Membership struct {
	GroupID string `json:"group_id"`
	UserID  string `json:"user_id"`
	Active  bool   `json:"active"`
}

type Change struct {
	UserID    string `json:"user_id"`
	UserName  string `json:"user_name"`
	Action    string `json:"action"`
	GroupID   string `json:"group_id"`
	GroupName string `json:"group_name"`
	Before    string `json:"before"`
	After     string `json:"after"`
	Reason    string `json:"reason"`
}

type RoleAssignment struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

type AgentChange struct {
	AgentID   string `json:"agent_id"`
	GroupID   string `json:"group_id"`
	GroupName string `json:"group_name"`
	Action    string `json:"action"`
}

type Plan struct {
	Changes         []Change         `json:"changes"`
	AgentChanges    []AgentChange    `json:"agent_changes"`
	Warnings        []string         `json:"warnings"`
	RoleAssignments []RoleAssignment `json:"role_assignments,omitempty"`
}

type memberPlan struct {
	kind          string
	user          lark.OrgUser
	desiredGroups map[string]struct{}
	mappedRole    string
	desiredRole   string
	skipDisable   bool
	skipRole      bool
}

type identityIndex struct {
	union   map[string][]int
	feishu  map[string][]int
	channel map[string][]int
	email   map[string][]int
}

func BuildPlan(snapshot lark.OrgSnapshot, mappings []Mapping, members []Member, memberships []Membership) (Plan, error) {
	if !snapshot.Complete {
		return Plan{}, errors.New("feishuorg: organization snapshot is incomplete")
	}

	warnings := make(map[string]struct{})
	validMappings := validateMappings(snapshot, mappings, warnings)
	matches, blocked := matchMembers(snapshot.Users, members, warnings)
	currentGroups := activeGroups(members, memberships)
	groupNames := groupNames(mappings)

	plans := make([]memberPlan, len(members))
	for i, member := range members {
		if blocked[i] {
			continue
		}
		if snapshotIndex, ok := matches[i]; ok {
			if snapshot.Users[snapshotIndex].Active {
				user := snapshot.Users[snapshotIndex]
				groups, role := desiredAccess(user, validMappings)
				plans[i] = memberPlan{
					kind:          "active",
					user:          user,
					desiredGroups: groups,
					mappedRole:    role,
					desiredRole:   desiredRole(member, role),
				}
			} else {
				plans[i] = memberPlan{kind: "disabled", desiredGroups: map[string]struct{}{}}
			}
			continue
		}
		if member.Tracked {
			addWarning(warnings, fmt.Sprintf("tracked member %q is missing from the Feishu snapshot; visibility or offboarding must be verified before any change", member.UserID))
		}
	}

	protectActiveOwner(members, plans)

	plan := Plan{Changes: []Change{}, Warnings: []string{}}
	for _, i := range sortedMemberIndexes(members) {
		member := members[i]
		memberPlan := plans[i]
		if memberPlan.kind == "" {
			continue
		}

		base := Change{UserID: member.UserID, UserName: member.Name}
		if memberPlan.kind == "disabled" {
			if !member.Disabled {
				change := base
				change.Action = "member_disabled"
				change.Before = "active"
				change.After = "disabled"
				if memberPlan.skipDisable {
					change.Action = "skipped"
					change.Reason = "member_disabled skipped: at least one active owner is required"
				}
				plan.Changes = append(plan.Changes, change)
			}
			if !memberPlan.skipDisable {
				for _, groupID := range sortedGroupIDs(currentGroups[i]) {
					plan.Changes = append(plan.Changes, membershipChange(base, groupNames, groupID, "group_left"))
				}
			}
			continue
		}

		if !memberPlan.skipRole {
			switch {
			case memberPlan.mappedRole != "":
				if member.ManagedRole != "" || roleRank(member.Role) <= roleRank(memberPlan.mappedRole) {
					plan.RoleAssignments = append(plan.RoleAssignments, RoleAssignment{UserID: member.UserID, Role: memberPlan.desiredRole})
				}
			case member.ManagedRole != "":
				plan.RoleAssignments = append(plan.RoleAssignments, RoleAssignment{UserID: member.UserID, Role: "member"})
			}
		}

		if member.Disabled {
			change := base
			change.Action = "member_restored"
			change.Before = "disabled"
			change.After = "active"
			plan.Changes = append(plan.Changes, change)
		}
		for _, groupID := range sortedGroupIDs(memberPlan.desiredGroups) {
			if _, ok := currentGroups[i][groupID]; !ok {
				plan.Changes = append(plan.Changes, membershipChange(base, groupNames, groupID, "group_joined"))
			}
		}
		for _, groupID := range sortedGroupIDs(currentGroups[i]) {
			if _, ok := memberPlan.desiredGroups[groupID]; !ok {
				plan.Changes = append(plan.Changes, membershipChange(base, groupNames, groupID, "group_left"))
			}
		}
		if memberPlan.desiredRole != member.Role {
			change := base
			change.Action = "role_changed"
			change.Before = member.Role
			change.After = memberPlan.desiredRole
			if memberPlan.skipRole {
				change.Action = "skipped"
				change.Reason = "role_changed skipped: at least one active owner is required"
			}
			plan.Changes = append(plan.Changes, change)
		}
	}

	sort.SliceStable(plan.Changes, func(i, j int) bool {
		a, b := plan.Changes[i], plan.Changes[j]
		if a.UserID != b.UserID {
			return a.UserID < b.UserID
		}
		if a.Action != b.Action {
			return a.Action < b.Action
		}
		return a.GroupID < b.GroupID
	})
	for warning := range warnings {
		plan.Warnings = append(plan.Warnings, warning)
	}
	sort.Strings(plan.Warnings)
	return plan, nil
}

func validateMappings(snapshot lark.OrgSnapshot, mappings []Mapping, warnings map[string]struct{}) []Mapping {
	departments := make(map[string]struct{}, len(snapshot.Departments))
	for _, department := range snapshot.Departments {
		if department.ID != "" {
			departments[department.ID] = struct{}{}
		}
	}
	jobTitles := make(map[string]struct{})
	userUnionIDs := make(map[string]struct{})
	for _, user := range snapshot.Users {
		if user.JobTitle != "" {
			jobTitles[user.JobTitle] = struct{}{}
		}
		if user.UnionID != "" {
			userUnionIDs[user.UnionID] = struct{}{}
		}
	}

	valid := make([]Mapping, 0, len(mappings))
	for _, mapping := range mappings {
		known := false
		switch mapping.Kind {
		case "department":
			_, known = departments[mapping.ExternalID]
		case "job_title":
			_, known = jobTitles[mapping.ExternalID]
		case "user":
			_, known = userUnionIDs[mapping.ExternalID]
		default:
			addWarning(warnings, fmt.Sprintf("unknown mapping kind %q for group %q; mapping has no permissions", mapping.Kind, mapping.GroupID))
			continue
		}
		if !known {
			addWarning(warnings, fmt.Sprintf("unknown %s %q for group %q; mapping has no permissions", mapping.Kind, mapping.ExternalID, mapping.GroupID))
			continue
		}
		if mapping.MemberRole != "" && roleRank(mapping.MemberRole) == 0 {
			addWarning(warnings, fmt.Sprintf("unknown member role %q for group %q; role has no permissions", mapping.MemberRole, mapping.GroupID))
			mapping.MemberRole = ""
		}
		valid = append(valid, mapping)
	}
	return valid
}

// MatchMembers exposes the shared identity matcher for read-only organization
// directories. A blocked member has conflicting identities and is not linked.
func MatchMembers(users []lark.OrgUser, members []Member) (map[int]int, map[int]bool) {
	matches, blocked := matchMembers(users, members, make(map[string]struct{}))
	return matches, blocked
}

func matchMembers(users []lark.OrgUser, members []Member, warnings map[string]struct{}) (map[int]int, map[int]bool) {
	index := identityIndex{
		union:   make(map[string][]int),
		feishu:  make(map[string][]int),
		channel: make(map[string][]int),
		email:   make(map[string][]int),
	}
	for i, member := range members {
		for _, id := range member.UnionIDs {
			addIdentity(index.union, id, i)
		}
		addIdentity(index.feishu, member.FeishuOpenID, i)
		for _, id := range member.ChannelOpenIDs {
			addIdentity(index.channel, id, i)
		}
		addIdentity(index.email, strings.ToLower(member.Email), i)
	}

	matches := make(map[int]int)
	memberMatches := make([][]int, len(members))
	blocked := make(map[int]bool)
	for userIndex, user := range users {
		candidates := make(map[int]struct{})
		addCandidates(candidates, index.union[user.UnionID])
		addCandidates(candidates, index.feishu[user.OpenID])
		addCandidates(candidates, index.channel[user.OpenID])
		addCandidates(candidates, index.email[strings.ToLower(user.Email)])
		if len(candidates) > 1 {
			addWarning(warnings, fmt.Sprintf("identity conflict for Feishu user %q; automatic changes skipped", orgUserIdentity(user)))
			for memberIndex := range candidates {
				blocked[memberIndex] = true
			}
			continue
		}
		for memberIndex := range candidates {
			memberMatches[memberIndex] = append(memberMatches[memberIndex], userIndex)
		}
	}
	for memberIndex, userIndexes := range memberMatches {
		if len(userIndexes) > 1 {
			addWarning(warnings, fmt.Sprintf("duplicate Feishu identity for member %q; automatic changes skipped", members[memberIndex].UserID))
			blocked[memberIndex] = true
			continue
		}
		if len(userIndexes) == 1 {
			matches[memberIndex] = userIndexes[0]
		}
	}
	return matches, blocked
}

func addIdentity(index map[string][]int, identity string, memberIndex int) {
	if identity == "" {
		return
	}
	for _, existing := range index[identity] {
		if existing == memberIndex {
			return
		}
	}
	index[identity] = append(index[identity], memberIndex)
}

func addCandidates(candidates map[int]struct{}, indexes []int) {
	for _, index := range indexes {
		candidates[index] = struct{}{}
	}
}

func orgUserIdentity(user lark.OrgUser) string {
	for _, identity := range []string{user.UnionID, user.OpenID, strings.ToLower(user.Email), user.Name} {
		if identity != "" {
			return identity
		}
	}
	return "<unknown>"
}

func activeGroups(members []Member, memberships []Membership) []map[string]struct{} {
	groups := make([]map[string]struct{}, len(members))
	memberIndexes := make(map[string][]int, len(members))
	for i, member := range members {
		groups[i] = make(map[string]struct{})
		memberIndexes[member.UserID] = append(memberIndexes[member.UserID], i)
	}
	for _, membership := range memberships {
		if !membership.Active || membership.GroupID == "" {
			continue
		}
		for _, memberIndex := range memberIndexes[membership.UserID] {
			groups[memberIndex][membership.GroupID] = struct{}{}
		}
	}
	return groups
}

func desiredAccess(user lark.OrgUser, mappings []Mapping) (map[string]struct{}, string) {
	groups := make(map[string]struct{})
	role := ""
	for _, mapping := range mappings {
		matched := false
		switch mapping.Kind {
		case "department":
			for _, departmentID := range user.DepartmentIDs {
				if departmentID == mapping.ExternalID {
					matched = true
					break
				}
			}
		case "job_title":
			matched = user.JobTitle == mapping.ExternalID
		case "user":
			matched = user.UnionID == mapping.ExternalID
		}
		if !matched {
			continue
		}
		if mapping.GroupID != "" {
			groups[mapping.GroupID] = struct{}{}
		}
		if roleRank(mapping.MemberRole) > roleRank(role) {
			role = mapping.MemberRole
		}
	}
	return groups, role
}

func desiredRole(member Member, mappedRole string) string {
	if mappedRole == "" {
		if member.ManagedRole != "" {
			return "member"
		}
		return member.Role
	}
	if member.ManagedRole == "" && roleRank(member.Role) > roleRank(mappedRole) {
		return member.Role
	}
	return mappedRole
}

func roleRank(role string) int {
	switch role {
	case "owner":
		return 3
	case "admin":
		return 2
	case "member":
		return 1
	default:
		return 0
	}
}

func protectActiveOwner(members []Member, plans []memberPlan) {
	ownerCount := 0
	oldOwners := make([]bool, len(members))
	newOwners := make([]bool, len(members))
	for i, member := range members {
		oldOwners[i] = !member.Disabled && member.Role == "owner"
		newOwners[i] = oldOwners[i]
		if oldOwners[i] {
			ownerCount++
		}
		switch plans[i].kind {
		case "active":
			newOwners[i] = plans[i].desiredRole == "owner"
		case "disabled":
			newOwners[i] = false
		}
		if !oldOwners[i] && newOwners[i] {
			ownerCount++
		}
	}

	// Apply owner additions before removals so one plan can safely transfer ownership.
	for _, i := range sortedMemberIndexes(members) {
		if !oldOwners[i] || newOwners[i] {
			continue
		}
		switch plans[i].kind {
		case "active", "disabled":
		default:
			continue
		}
		if ownerCount > 1 {
			ownerCount--
			continue
		}
		if plans[i].kind == "disabled" {
			plans[i].skipDisable = true
		} else {
			plans[i].skipRole = true
		}
	}
}

func sortedMemberIndexes(members []Member) []int {
	indexes := make([]int, len(members))
	for i := range indexes {
		indexes[i] = i
	}
	sort.SliceStable(indexes, func(i, j int) bool {
		a, b := members[indexes[i]], members[indexes[j]]
		if a.UserID != b.UserID {
			return a.UserID < b.UserID
		}
		return a.MemberID < b.MemberID
	})
	return indexes
}

func groupNames(mappings []Mapping) map[string]string {
	names := make(map[string]string)
	for _, mapping := range mappings {
		if mapping.GroupID == "" || mapping.ExternalName == "" {
			continue
		}
		if current, ok := names[mapping.GroupID]; !ok || mapping.ExternalName < current {
			names[mapping.GroupID] = mapping.ExternalName
		}
	}
	return names
}

func membershipChange(base Change, names map[string]string, groupID, action string) Change {
	change := base
	change.Action = action
	change.GroupID = groupID
	change.GroupName = names[groupID]
	if action == "group_joined" {
		change.Before = "inactive"
		change.After = "active"
	} else {
		change.Before = "active"
		change.After = "inactive"
	}
	return change
}

func sortedGroupIDs(groups map[string]struct{}) []string {
	ids := make([]string, 0, len(groups))
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func addWarning(warnings map[string]struct{}, warning string) {
	warnings[warning] = struct{}{}
}
