package lark

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	orgRootDepartmentID = "0"
	orgPageSize         = 50
)

// RequiredOrgScopes are the read-only app permissions needed to fetch the
// organization through the contact API.
var RequiredOrgScopes = []string{
	"contact:department:readonly",
	"contact:user:readonly",
	"contact:user.email:readonly",
	"is_resigned:read",
}

// OrgDepartment is a department identified by its open_department_id.
type OrgDepartment struct {
	ID   string
	Name string
}

// OrgUser is a user and every directly fetched department they belong to.
type OrgUser struct {
	OpenID        string
	UnionID       string
	Email         string
	Name          string
	JobTitle      string
	DepartmentIDs []string
	Active        bool
}

// OrgSnapshot is complete only when every department and user page succeeded.
type OrgSnapshot struct {
	Departments []OrgDepartment
	Users       []OrgUser
	Complete    bool
}

// OrgAPIClient reads an installation's organization without changing it.
type OrgAPIClient interface {
	FetchOrganization(ctx context.Context, creds InstallationCredentials) (OrgSnapshot, error)
}

// ScopeError reports missing contact permissions or an insufficient contact
// visibility scope. It is a configuration failure, not an empty organization.
type ScopeError struct {
	Op   string
	Code int
	Msg  string
	Err  error
}

func (e *ScopeError) Error() string {
	return fmt.Sprintf(
		"lark org client: %s: code=%d msg=%q; grant app scopes %s in the Lark/Feishu developer console, publish a new app version, and include every required department and user in the app's contact visibility scope",
		e.Op, e.Code, e.Msg, strings.Join(RequiredOrgScopes, ", "),
	)
}

func (e *ScopeError) Unwrap() error { return e.Err }

var _ OrgAPIClient = (*httpAPIClient)(nil)

// FetchOrganization walks the department tree from Lark's virtual root and
// fetches direct users for the root and every descendant. A user returned by
// multiple departments is emitted once with the union of those memberships.
func (c *httpAPIClient) FetchOrganization(ctx context.Context, creds InstallationCredentials) (OrgSnapshot, error) {
	var snapshot OrgSnapshot
	pending := []string{orgRootDepartmentID}
	seenDepartments := map[string]struct{}{orgRootDepartmentID: {}}
	userIndexes := make(map[string]int)

	for len(pending) > 0 {
		departmentID := pending[0]
		pending = pending[1:]

		children, err := c.fetchOrgChildDepartments(ctx, creds, departmentID)
		if err != nil {
			return OrgSnapshot{}, err
		}
		for _, department := range children {
			if department.ID == "" {
				return OrgSnapshot{}, fmt.Errorf("lark org client: department %q returned a child without open_department_id", departmentID)
			}
			if _, seen := seenDepartments[department.ID]; seen {
				continue
			}
			seenDepartments[department.ID] = struct{}{}
			snapshot.Departments = append(snapshot.Departments, department)
			pending = append(pending, department.ID)
		}

		users, err := c.fetchOrgDepartmentUsers(ctx, creds, departmentID)
		if err != nil {
			return OrgSnapshot{}, err
		}
		for _, user := range users {
			if user.OpenID == "" {
				return OrgSnapshot{}, fmt.Errorf("lark org client: department %q returned a user without open_id", departmentID)
			}
			if index, seen := userIndexes[user.OpenID]; seen {
				if !hasOrgDepartment(snapshot.Users[index].DepartmentIDs, departmentID) {
					snapshot.Users[index].DepartmentIDs = append(snapshot.Users[index].DepartmentIDs, departmentID)
				}
				continue
			}
			user.DepartmentIDs = []string{departmentID}
			userIndexes[user.OpenID] = len(snapshot.Users)
			snapshot.Users = append(snapshot.Users, user)
		}
	}

	snapshot.Complete = true
	return snapshot, nil
}

func hasOrgDepartment(departmentIDs []string, want string) bool {
	for _, departmentID := range departmentIDs {
		if departmentID == want {
			return true
		}
	}
	return false
}

func (c *httpAPIClient) fetchOrgChildDepartments(ctx context.Context, creds InstallationCredentials, departmentID string) ([]OrgDepartment, error) {
	op := fmt.Sprintf("list children of department %q", departmentID)
	base := "/open-apis/contact/v3/departments/" + url.PathEscape(departmentID) + "/children"
	var departments []OrgDepartment
	pageToken := ""
	seenPageTokens := make(map[string]struct{})

	for {
		q := url.Values{}
		q.Set("department_id_type", "open_department_id")
		q.Set("page_size", strconv.Itoa(orgPageSize))
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}

		var resp struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
			Data struct {
				Items []struct {
					OpenDepartmentID string `json:"open_department_id"`
					Name             string `json:"name"`
				} `json:"items"`
				HasMore   bool   `json:"has_more"`
				PageToken string `json:"page_token"`
			} `json:"data"`
		}
		if err := c.doAuthedJSON(ctx, creds, http.MethodGet, base+"?"+q.Encode(), nil, &resp); err != nil {
			return nil, newOrgTransportError(op, err)
		}
		if resp.Code != 0 {
			if isTokenError(resp.Code) {
				c.invalidateToken(creds.AppID)
			}
			return nil, newOrgResponseError(op, resp.Code, resp.Msg)
		}
		for _, item := range resp.Data.Items {
			departments = append(departments, OrgDepartment{ID: item.OpenDepartmentID, Name: item.Name})
		}

		if !resp.Data.HasMore {
			return departments, nil
		}
		next, err := nextOrgPageToken(op, resp.Data.PageToken, seenPageTokens)
		if err != nil {
			return nil, err
		}
		pageToken = next
	}
}

func (c *httpAPIClient) fetchOrgDepartmentUsers(ctx context.Context, creds InstallationCredentials, departmentID string) ([]OrgUser, error) {
	op := fmt.Sprintf("list direct users of department %q", departmentID)
	var users []OrgUser
	pageToken := ""
	seenPageTokens := make(map[string]struct{})

	for {
		q := url.Values{}
		q.Set("department_id", departmentID)
		q.Set("department_id_type", "open_department_id")
		q.Set("user_id_type", "open_id")
		q.Set("page_size", strconv.Itoa(orgPageSize))
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}

		var resp struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
			Data struct {
				Items []struct {
					OpenID   string `json:"open_id"`
					UnionID  string `json:"union_id"`
					Email    string `json:"email"`
					Name     string `json:"name"`
					JobTitle string `json:"job_title"`
					Status   struct {
						IsResigned bool `json:"is_resigned"`
					} `json:"status"`
				} `json:"items"`
				HasMore   bool   `json:"has_more"`
				PageToken string `json:"page_token"`
			} `json:"data"`
		}
		if err := c.doAuthedJSON(ctx, creds, http.MethodGet, "/open-apis/contact/v3/users/find_by_department?"+q.Encode(), nil, &resp); err != nil {
			return nil, newOrgTransportError(op, err)
		}
		if resp.Code != 0 {
			if isTokenError(resp.Code) {
				c.invalidateToken(creds.AppID)
			}
			return nil, newOrgResponseError(op, resp.Code, resp.Msg)
		}
		for _, item := range resp.Data.Items {
			users = append(users, OrgUser{
				OpenID:   item.OpenID,
				UnionID:  item.UnionID,
				Email:    item.Email,
				Name:     item.Name,
				JobTitle: item.JobTitle,
				Active:   !item.Status.IsResigned,
			})
		}

		if !resp.Data.HasMore {
			return users, nil
		}
		next, err := nextOrgPageToken(op, resp.Data.PageToken, seenPageTokens)
		if err != nil {
			return nil, err
		}
		pageToken = next
	}
}

func nextOrgPageToken(op, pageToken string, seen map[string]struct{}) (string, error) {
	if pageToken == "" {
		return "", fmt.Errorf("lark org client: %s: has_more=true with empty page_token", op)
	}
	if _, duplicate := seen[pageToken]; duplicate {
		return "", fmt.Errorf("lark org client: %s: repeated page_token %q", op, pageToken)
	}
	seen[pageToken] = struct{}{}
	return pageToken, nil
}

func newOrgResponseError(op string, code int, msg string) error {
	err := &APIError{Op: op, Code: code, Msg: msg}
	if isOrgScopeErrorCode(code) {
		return &ScopeError{Op: op, Code: code, Msg: msg, Err: err}
	}
	return err
}

func newOrgTransportError(op string, err error) error {
	code, msg, hasCode := larkErrorCodeMsg(err)
	var statusErr *larkAPIStatusError
	if (hasCode && isOrgScopeErrorCode(code)) || (errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusForbidden) {
		return &ScopeError{Op: op, Code: code, Msg: msg, Err: err}
	}
	return fmt.Errorf("lark org client: %s: %w", op, err)
}

func isOrgScopeErrorCode(code int) bool {
	switch code {
	case 40004, 41050, 99991672:
		return true
	default:
		return false
	}
}
