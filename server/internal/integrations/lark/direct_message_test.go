package lark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestSendUserCard_AddressesTheUser(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	var gotType string
	var gotBody map[string]any
	fake.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		gotType = r.URL.Query().Get("receive_id_type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		writeJSON(w, map[string]any{"code": 0, "msg": "ok", "data": map[string]any{"message_id": "om_1"}})
	})
	c := newTestClient(fake, time.Now)

	id, err := c.SendUserCard(context.Background(), SendUserCardParams{
		Credentials: testCreds(), ReceiveIDType: ReceiveIDTypeOpenID, ReceiveID: "ou_user", CardJSON: `{"schema":"2.0"}`,
	})
	if err != nil {
		t.Fatalf("SendUserCard: %v", err)
	}
	if id != "om_1" {
		t.Fatalf("message id = %q", id)
	}
	if gotType != "open_id" || gotBody["receive_id"] != "ou_user" || gotBody["msg_type"] != "interactive" {
		t.Fatalf("unexpected request: type=%q body=%v", gotType, gotBody)
	}
}

func TestSendUserCard_SurfacesBusinessError(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"code": 230013, "msg": "bot has no availability to this user"})
	})
	c := newTestClient(fake, time.Now)

	_, err := c.SendUserCard(context.Background(), SendUserCardParams{
		Credentials: testCreds(), ReceiveIDType: ReceiveIDTypeUnionID, ReceiveID: "on_user", CardJSON: "{}",
	})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != 230013 {
		t.Fatalf("want APIError 230013, got %v", err)
	}
}

func TestSendUserCard_RejectsUnknownReceiveIDType(t *testing.T) {
	c := NewHTTPAPIClient(HTTPClientConfig{}).(*httpAPIClient)
	if _, err := c.SendUserCard(context.Background(), SendUserCardParams{
		Credentials: testCreds(), ReceiveIDType: "chat_id", ReceiveID: "oc_x", CardJSON: "{}",
	}); err == nil {
		t.Fatal("want error for chat_id receive type")
	}
}
