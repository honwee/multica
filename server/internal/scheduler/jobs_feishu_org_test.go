package scheduler

import (
	"context"
	"errors"
	"testing"
)

type stubFeishuOrgSyncer struct {
	applied int
	err     error
	calls   int
}

func (s *stubFeishuOrgSyncer) SyncFeishuOrganizations(context.Context) (int, error) {
	s.calls++
	return s.applied, s.err
}

func TestFeishuOrgSyncJobSpecIsValidAndReportsApplied(t *testing.T) {
	syncer := &stubFeishuOrgSyncer{applied: 3}
	job := FeishuOrgSyncJob(syncer)
	if err := job.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	result, err := job.Handler(context.Background(), HandlerInput{Job: &job, Scope: ScopeGlobal})
	if err != nil || result.RowsAffected != 3 || syncer.calls != 1 {
		t.Fatalf("handler result = %+v err=%v calls=%d", result, err, syncer.calls)
	}
	syncer.err = errors.New("tenant down")
	if _, err := job.Handler(context.Background(), HandlerInput{Job: &job, Scope: ScopeGlobal}); err == nil {
		t.Fatal("handler must surface the sync error for the audit row")
	}
}
