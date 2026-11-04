package lark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type orgTestPage struct {
	items      []map[string]any
	hasMore    bool
	pageToken  string
	code       int
	msg        string
	httpStatus int
}

func TestOrgClientFetchOrganization(t *testing.T) {
	alice := orgTestUser("ou_alice", "on_alice", "alice@example.com", "Alice", "CEO", false)
	bob := orgTestUser("ou_bob", "on_bob", "bob@example.com", "Bob", "Contractor", true)
	carol := orgTestUser("ou_carol", "on_carol", "carol@example.com", "Carol", "Engineer", false)
	dave := orgTestUser("ou_dave", "on_dave", "dave@example.com", "Dave", "Designer", false)

	client, fake := newOrgTestClient(t,
		map[string]map[string]orgTestPage{
			"0": {
				"":          {items: []map[string]any{orgTestDepartment("od_eng", "Engineering")}, hasMore: true, pageToken: "root-next"},
				"root-next": {items: []map[string]any{orgTestDepartment("od_design", "Design")}},
			},
			"od_eng": {
				"": {items: []map[string]any{orgTestDepartment("od_platform", "Platform")}},
			},
			"od_design":   {"": {}},
			"od_platform": {"": {}},
		},
		map[string]map[string]orgTestPage{
			"0": {
				"":                {items: []map[string]any{alice}, hasMore: true, pageToken: "root-users-next"},
				"root-users-next": {items: []map[string]any{bob}},
			},
			"od_eng": {
				"":               {items: []map[string]any{alice, carol}, hasMore: true, pageToken: "eng-users-next"},
				"eng-users-next": {items: []map[string]any{dave}},
			},
			"od_design":   {"": {items: []map[string]any{bob}}},
			"od_platform": {"": {items: []map[string]any{alice}}},
		},
	)

	var orgClient OrgAPIClient = client
	got, err := orgClient.FetchOrganization(context.Background(), testCreds())
	if err != nil {
		t.Fatalf("FetchOrganization: %v", err)
	}
	want := OrgSnapshot{
		Departments: []OrgDepartment{
			{ID: "od_eng", Name: "Engineering"},
			{ID: "od_design", Name: "Design"},
			{ID: "od_platform", Name: "Platform"},
		},
		Users: []OrgUser{
			{OpenID: "ou_alice", UnionID: "on_alice", Email: "alice@example.com", Name: "Alice", JobTitle: "CEO", DepartmentIDs: []string{"0", "od_eng", "od_platform"}, Active: true},
			{OpenID: "ou_bob", UnionID: "on_bob", Email: "bob@example.com", Name: "Bob", JobTitle: "Contractor", DepartmentIDs: []string{"0", "od_design"}, Active: false},
			{OpenID: "ou_carol", UnionID: "on_carol", Email: "carol@example.com", Name: "Carol", JobTitle: "Engineer", DepartmentIDs: []string{"od_eng"}, Active: true},
			{OpenID: "ou_dave", UnionID: "on_dave", Email: "dave@example.com", Name: "Dave", JobTitle: "Designer", DepartmentIDs: []string{"od_eng"}, Active: true},
		},
		Complete: true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("snapshot mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
	if got := fake.tokenN.Load(); got != 1 {
		t.Errorf("token requests = %d, want 1", got)
	}
}

func TestOrgClientFetchOrganizationEmpty(t *testing.T) {
	client, _ := newOrgTestClient(t,
		map[string]map[string]orgTestPage{"0": {"": {}}},
		map[string]map[string]orgTestPage{"0": {"": {}}},
	)

	got, err := client.FetchOrganization(context.Background(), testCreds())
	if err != nil {
		t.Fatalf("FetchOrganization: %v", err)
	}
	if !got.Complete || len(got.Departments) != 0 || len(got.Users) != 0 {
		t.Errorf("empty snapshot = %#v, want empty and complete", got)
	}
}

func TestOrgClientFetchOrganizationFailureDiscardsSnapshot(t *testing.T) {
	client, _ := newOrgTestClient(t,
		map[string]map[string]orgTestPage{
			"0":      {"": {items: []map[string]any{orgTestDepartment("od_eng", "Engineering")}}},
			"od_eng": {"": {}},
		},
		map[string]map[string]orgTestPage{
			"0": {"": {items: []map[string]any{orgTestUser("ou_alice", "on_alice", "alice@example.com", "Alice", "CEO", false)}}},
			"od_eng": {
				"":     {items: []map[string]any{orgTestUser("ou_carol", "on_carol", "carol@example.com", "Carol", "Engineer", false)}, hasMore: true, pageToken: "next"},
				"next": {httpStatus: http.StatusBadGateway, msg: "bad gateway"},
			},
		},
	)

	got, err := client.FetchOrganization(context.Background(), testCreds())
	if err == nil {
		t.Fatal("FetchOrganization succeeded, want upstream page failure")
	}
	if !reflect.DeepEqual(got, OrgSnapshot{}) {
		t.Errorf("snapshot after failure = %#v, want zero value", got)
	}
}

func TestOrgClientFetchOrganizationRejectsBrokenPagination(t *testing.T) {
	client, _ := newOrgTestClient(t,
		map[string]map[string]orgTestPage{
			"0": {"": {hasMore: true}},
		},
		map[string]map[string]orgTestPage{},
	)

	got, err := client.FetchOrganization(context.Background(), testCreds())
	if err == nil || !strings.Contains(err.Error(), "empty page_token") {
		t.Fatalf("FetchOrganization error = %v, want empty page_token error", err)
	}
	if !reflect.DeepEqual(got, OrgSnapshot{}) {
		t.Errorf("snapshot after pagination failure = %#v, want zero value", got)
	}
}

func TestOrgClientFetchOrganizationScopeErrors(t *testing.T) {
	tests := []struct {
		name             string
		departmentPage   orgTestPage
		userPage         orgTestPage
		wantErrorMessage string
	}{
		{
			name:             "missing app scope",
			departmentPage:   orgTestPage{code: 99991672, msg: "missing scope"},
			wantErrorMessage: "missing scope",
		},
		{
			name:             "department outside visibility scope",
			departmentPage:   orgTestPage{code: 40004, msg: "no dept authority", httpStatus: http.StatusForbidden},
			wantErrorMessage: "no dept authority",
		},
		{
			name:             "user outside visibility scope",
			departmentPage:   orgTestPage{},
			userPage:         orgTestPage{code: 41050, msg: "no user authority"},
			wantErrorMessage: "no user authority",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, _ := newOrgTestClient(t,
				map[string]map[string]orgTestPage{"0": {"": tt.departmentPage}},
				map[string]map[string]orgTestPage{"0": {"": tt.userPage}},
			)

			got, err := client.FetchOrganization(context.Background(), testCreds())
			if err == nil {
				t.Fatal("FetchOrganization succeeded, want ScopeError")
			}
			var scopeErr *ScopeError
			if !errors.As(err, &scopeErr) {
				t.Fatalf("error = %T %v, want *ScopeError", err, err)
			}
			if !strings.Contains(err.Error(), tt.wantErrorMessage) {
				t.Errorf("error = %q, want upstream message %q", err, tt.wantErrorMessage)
			}
			for _, want := range []string{"contact:department:readonly", "contact:user:readonly", "publish a new app version", "contact visibility scope"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error = %q, want configuration guidance %q", err, want)
				}
			}
			if !reflect.DeepEqual(got, OrgSnapshot{}) {
				t.Errorf("snapshot after scope failure = %#v, want zero value", got)
			}
		})
	}
}

func newOrgTestClient(t *testing.T, departmentPages, userPages map[string]map[string]orgTestPage) (*httpAPIClient, *larkFakeServer) {
	t.Helper()
	fake := newLarkFake(t)
	fake.stubToken("tok_org", 7200)

	const departmentPrefix = "/open-apis/contact/v3/departments/"
	fake.mux.HandleFunc(departmentPrefix, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("department children: method = %s, want GET", r.Method)
		}
		if !strings.HasSuffix(r.URL.Path, "/children") {
			t.Errorf("department children: unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		departmentID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, departmentPrefix), "/children")
		q := r.URL.Query()
		if got := q.Get("department_id_type"); got != "open_department_id" {
			t.Errorf("department children: department_id_type = %q", got)
		}
		if got := q.Get("page_size"); got != "50" {
			t.Errorf("department children: page_size = %q, want 50", got)
		}
		pageToken := q.Get("page_token")
		pages, ok := departmentPages[departmentID]
		if !ok {
			t.Errorf("department children: unexpected department %q", departmentID)
			http.NotFound(w, r)
			return
		}
		page, ok := pages[pageToken]
		if !ok {
			t.Errorf("department children: unexpected page_token %q for department %q", pageToken, departmentID)
			http.NotFound(w, r)
			return
		}
		writeOrgTestPage(w, page)
	})

	fake.mux.HandleFunc("/open-apis/contact/v3/users/find_by_department", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("department users: method = %s, want GET", r.Method)
		}
		q := r.URL.Query()
		if got := q.Get("user_id_type"); got != "open_id" {
			t.Errorf("department users: user_id_type = %q", got)
		}
		if got := q.Get("department_id_type"); got != "open_department_id" {
			t.Errorf("department users: department_id_type = %q", got)
		}
		if got := q.Get("page_size"); got != "50" {
			t.Errorf("department users: page_size = %q, want 50", got)
		}
		departmentID := q.Get("department_id")
		pageToken := q.Get("page_token")
		pages, ok := userPages[departmentID]
		if !ok {
			t.Errorf("department users: unexpected department %q", departmentID)
			http.NotFound(w, r)
			return
		}
		page, ok := pages[pageToken]
		if !ok {
			t.Errorf("department users: unexpected page_token %q for department %q", pageToken, departmentID)
			http.NotFound(w, r)
			return
		}
		writeOrgTestPage(w, page)
	})

	return newTestClient(fake, time.Now), fake
}

func writeOrgTestPage(w http.ResponseWriter, page orgTestPage) {
	w.Header().Set("Content-Type", "application/json")
	if page.httpStatus != 0 {
		w.WriteHeader(page.httpStatus)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code": page.code,
		"msg":  page.msg,
		"data": map[string]any{
			"items":      page.items,
			"has_more":   page.hasMore,
			"page_token": page.pageToken,
		},
	})
}

func orgTestDepartment(id, name string) map[string]any {
	return map[string]any{"open_department_id": id, "name": name}
}

func orgTestUser(openID, unionID, email, name, jobTitle string, resigned bool) map[string]any {
	return map[string]any{
		"open_id":   openID,
		"union_id":  unionID,
		"email":     email,
		"name":      name,
		"job_title": jobTitle,
		"status":    map[string]any{"is_resigned": resigned},
	}
}
