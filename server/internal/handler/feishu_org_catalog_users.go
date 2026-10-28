package handler

import (
	"sort"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

type LarkOrganizationUserResponse struct {
	UnionID         string   `json:"union_id"`
	Name            string   `json:"name"`
	JobTitle        string   `json:"job_title"`
	Departments     []string `json:"departments"`
	Active          bool     `json:"active"`
	WorkspaceMember bool     `json:"workspace_member"`
}

func buildLarkOrganizationUsers(snapshot lark.OrgSnapshot, matches map[int]int, blocked map[int]bool) []LarkOrganizationUserResponse {
	departmentNames := make(map[string]string, len(snapshot.Departments))
	for _, department := range snapshot.Departments {
		departmentNames[department.ID] = department.Name
	}
	workspaceSnapshots := make(map[int]bool, len(matches))
	for memberIndex, snapshotIndex := range matches {
		if !blocked[memberIndex] {
			workspaceSnapshots[snapshotIndex] = true
		}
	}
	users := make([]LarkOrganizationUserResponse, 0, len(snapshot.Users))
	for index, user := range snapshot.Users {
		if user.UnionID == "" {
			continue
		}
		departments := make([]string, 0, len(user.DepartmentIDs))
		for _, departmentID := range user.DepartmentIDs {
			if name := departmentNames[departmentID]; name != "" {
				departments = append(departments, name)
			}
		}
		sort.Strings(departments)
		users = append(users, LarkOrganizationUserResponse{
			UnionID: user.UnionID, Name: user.Name, JobTitle: user.JobTitle,
			Departments: departments, Active: user.Active, WorkspaceMember: workspaceSnapshots[index],
		})
	}
	sort.Slice(users, func(i, j int) bool {
		if users[i].Name != users[j].Name {
			return users[i].Name < users[j].Name
		}
		return users[i].UnionID < users[j].UnionID
	})
	return users
}
