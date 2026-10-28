package handler

import (
	"context"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishuorg"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type LarkOrganizationDepartmentResponse struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	DirectMemberCount       int    `json:"direct_member_count"`
	ActiveDirectMemberCount int    `json:"active_direct_member_count"`
}

type LarkOrganizationJobTitleResponse struct {
	Name              string `json:"name"`
	MemberCount       int    `json:"member_count"`
	ActiveMemberCount int    `json:"active_member_count"`
}

type LarkOrganizationWorkspaceMemberResponse struct {
	UserID           string   `json:"user_id"`
	Name             string   `json:"name"`
	Role             string   `json:"role"`
	ManagedRole      string   `json:"managed_role"`
	Disabled         bool     `json:"disabled"`
	Linked           bool     `json:"linked"`
	IdentityConflict bool     `json:"identity_conflict"`
	JobTitle         string   `json:"job_title"`
	Departments      []string `json:"departments"`
	FeishuActive     *bool    `json:"feishu_active,omitempty"`
}

type LarkOrganizationCatalogResponse struct {
	SnapshotAt       string                                    `json:"snapshot_at"`
	Departments      []LarkOrganizationDepartmentResponse      `json:"departments"`
	JobTitles        []LarkOrganizationJobTitleResponse        `json:"job_titles"`
	Users            []LarkOrganizationUserResponse            `json:"users"`
	TotalUsers       int                                       `json:"total_users"`
	ActiveUsers      int                                       `json:"active_users"`
	JobTitleUsers    int                                       `json:"job_title_users"`
	WorkspaceMembers []LarkOrganizationWorkspaceMemberResponse `json:"workspace_members"`
}

func (h *Handler) buildLarkOrganizationCatalog(ctx context.Context, workspaceID pgtype.UUID, run db.FeishuOrgSyncRun, snapshot lark.OrgSnapshot) (*LarkOrganizationCatalogResponse, error) {
	memberRows, err := h.Queries.ListFeishuOrgMemberIdentities(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	members := feishuOrgMemberInputs(memberRows)
	matches, blocked := feishuorg.MatchMembers(snapshot.Users, members)

	catalog := &LarkOrganizationCatalogResponse{
		SnapshotAt:       timestampToString(run.CreatedAt),
		Departments:      make([]LarkOrganizationDepartmentResponse, 0, len(snapshot.Departments)),
		JobTitles:        make([]LarkOrganizationJobTitleResponse, 0),
		Users:            buildLarkOrganizationUsers(snapshot, matches, blocked),
		TotalUsers:       len(snapshot.Users),
		WorkspaceMembers: make([]LarkOrganizationWorkspaceMemberResponse, 0, len(members)),
	}
	departmentCounts := make(map[string][2]int)
	jobTitleCounts := make(map[string][2]int)
	for _, user := range snapshot.Users {
		active := 0
		if user.Active {
			active = 1
			catalog.ActiveUsers++
		}
		if strings.TrimSpace(user.JobTitle) != "" {
			catalog.JobTitleUsers++
			counts := jobTitleCounts[user.JobTitle]
			counts[0]++
			counts[1] += active
			jobTitleCounts[user.JobTitle] = counts
		}
		for _, departmentID := range user.DepartmentIDs {
			counts := departmentCounts[departmentID]
			counts[0]++
			counts[1] += active
			departmentCounts[departmentID] = counts
		}
	}
	for _, department := range snapshot.Departments {
		if department.ID == "" {
			continue
		}
		counts := departmentCounts[department.ID]
		catalog.Departments = append(catalog.Departments, LarkOrganizationDepartmentResponse{
			ID: department.ID, Name: department.Name,
			DirectMemberCount: counts[0], ActiveDirectMemberCount: counts[1],
		})
	}
	sort.Slice(catalog.Departments, func(i, j int) bool {
		if catalog.Departments[i].Name != catalog.Departments[j].Name {
			return catalog.Departments[i].Name < catalog.Departments[j].Name
		}
		return catalog.Departments[i].ID < catalog.Departments[j].ID
	})
	for name, counts := range jobTitleCounts {
		catalog.JobTitles = append(catalog.JobTitles, LarkOrganizationJobTitleResponse{
			Name: name, MemberCount: counts[0], ActiveMemberCount: counts[1],
		})
	}
	sort.Slice(catalog.JobTitles, func(i, j int) bool {
		if catalog.JobTitles[i].MemberCount != catalog.JobTitles[j].MemberCount {
			return catalog.JobTitles[i].MemberCount > catalog.JobTitles[j].MemberCount
		}
		return catalog.JobTitles[i].Name < catalog.JobTitles[j].Name
	})

	departmentNames := make(map[string]string, len(snapshot.Departments))
	for _, department := range snapshot.Departments {
		departmentNames[department.ID] = department.Name
	}
	for i, member := range members {
		item := LarkOrganizationWorkspaceMemberResponse{
			UserID: member.UserID, Name: member.Name, Role: member.Role,
			ManagedRole: member.ManagedRole, Disabled: member.Disabled,
			IdentityConflict: blocked[i], Departments: []string{},
		}
		if snapshotIndex, ok := matches[i]; ok && !blocked[i] {
			user := snapshot.Users[snapshotIndex]
			item.Linked = true
			item.JobTitle = user.JobTitle
			item.FeishuActive = new(bool)
			*item.FeishuActive = user.Active
			for _, departmentID := range user.DepartmentIDs {
				if name := departmentNames[departmentID]; name != "" {
					item.Departments = append(item.Departments, name)
				}
			}
			sort.Strings(item.Departments)
		}
		catalog.WorkspaceMembers = append(catalog.WorkspaceMembers, item)
	}
	return catalog, nil
}

func feishuOrgMemberInputs(rows []db.ListFeishuOrgMemberIdentitiesRow) []feishuorg.Member {
	members := make([]feishuorg.Member, 0, len(rows))
	for _, row := range rows {
		managedRole := ""
		if row.FeishuManagedRole.Valid {
			managedRole = row.FeishuManagedRole.String
		}
		feishuOpenID := ""
		if row.FeishuOpenID.Valid {
			feishuOpenID = row.FeishuOpenID.String
		}
		members = append(members, feishuorg.Member{
			MemberID: uuidToString(row.ID), UserID: uuidToString(row.UserID), Name: row.UserName, Email: row.UserEmail,
			Role: row.Role, FeishuOpenID: feishuOpenID, ManagedRole: managedRole, Disabled: row.DisabledAt.Valid,
			ChannelOpenIDs: row.ChannelOpenIds, UnionIDs: row.UnionIds,
		})
	}
	return members
}
