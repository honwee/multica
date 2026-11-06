package lark

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

// Receive ID types accepted by IM v1 for a direct message to a user.
const (
	ReceiveIDTypeOpenID  = "open_id"
	ReceiveIDTypeUnionID = "union_id"
)

// SendUserCardParams addresses an interactive card to one user rather than
// a chat. ReceiveIDType is ReceiveIDTypeOpenID (scoped to the sending app)
// or ReceiveIDTypeUnionID (shared by every app of the same developer).
type SendUserCardParams struct {
	Credentials   InstallationCredentials
	ReceiveIDType string
	ReceiveID     string
	CardJSON      string
}

// DirectMessenger sends app-originated direct messages to users. It is
// separate from APIClient because only the platform's own notifications use
// it; agent chat replies always go to a chat.
type DirectMessenger interface {
	SendUserCard(ctx context.Context, p SendUserCardParams) (string, error)
}

// NewDirectMessenger builds a DirectMessenger over the real Lark HTTP API.
func NewDirectMessenger(cfg HTTPClientConfig) DirectMessenger {
	return NewHTTPAPIClient(cfg).(*httpAPIClient)
}

// SendUserCard posts an interactive card to a single user's 1:1 chat with
// the app's bot.
func (c *httpAPIClient) SendUserCard(ctx context.Context, p SendUserCardParams) (string, error) {
	if p.ReceiveID == "" {
		return "", errors.New("lark http client: missing receive_id")
	}
	if p.ReceiveIDType != ReceiveIDTypeOpenID && p.ReceiveIDType != ReceiveIDTypeUnionID {
		return "", fmt.Errorf("lark http client: unsupported receive_id_type %q", p.ReceiveIDType)
	}
	if p.CardJSON == "" {
		return "", errors.New("lark http client: missing card json")
	}
	q := url.Values{}
	q.Set("receive_id_type", p.ReceiveIDType)
	body := map[string]any{
		"receive_id": p.ReceiveID,
		"msg_type":   "interactive",
		"content":    p.CardJSON,
	}
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if err := c.doAuthedJSON(ctx, p.Credentials, http.MethodPost, "/open-apis/im/v1/messages?"+q.Encode(), body, &resp); err != nil {
		return "", fmt.Errorf("lark http client: send user card: %w", err)
	}
	if resp.Code != 0 || resp.Data.MessageID == "" {
		if isTokenError(resp.Code) {
			c.invalidateToken(p.Credentials.AppID)
		}
		return "", &APIError{Op: "send user card", Code: resp.Code, Msg: resp.Msg}
	}
	return resp.Data.MessageID, nil
}
