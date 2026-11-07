package lark

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type cardActionHandlerFunc func(context.Context, Installation, CardActionEvent) *CardActionReply

func (f cardActionHandlerFunc) HandleCardAction(ctx context.Context, inst Installation, event CardActionEvent) *CardActionReply {
	return f(ctx, inst, event)
}

const testCardCallback = `{"schema":"2.0","header":{"event_id":"e1","event_type":"card.action.trigger"},
 "event":{"operator":{"open_id":"ou_clicker","union_id":"on_clicker"},
  "action":{"tag":"button","value":{"multica_card":"tok"},"form_value":{"multica_input":"改到周五"}},
  "context":{"open_message_id":"om_1","open_chat_id":"oc_1"}}}`

func pushCardFrame(conn *fakeWSConn, payload []byte, messageID string) {
	f := &Frame{
		Method:  FrameMethodData,
		Service: 7,
		Headers: []FrameHeader{
			{Key: FrameHeaderTypeKey, Value: FrameHeaderTypeCard},
			{Key: FrameHeaderMessageIDKey, Value: messageID},
		},
		Payload: payload,
	}
	conn.Push(f.Marshal())
}

func decodeAckData(t *testing.T, raw []byte) (int, []byte) {
	t.Helper()
	frame, err := UnmarshalFrame(raw)
	if err != nil {
		t.Fatalf("unmarshal ack: %v", err)
	}
	var ack struct {
		Code int    `json:"code"`
		Data []byte `json:"data"`
	}
	if err := json.Unmarshal(frame.Payload, &ack); err != nil {
		t.Fatalf("decode ack payload %s: %v", frame.Payload, err)
	}
	return ack.Code, ack.Data
}

func TestParseCardActionPayload(t *testing.T) {
	event, err := ParseCardActionPayload([]byte(testCardCallback))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if event.OperatorOpenID != "ou_clicker" || event.OperatorUnionID != "on_clicker" || event.MessageID != "om_1" ||
		event.Value["multica_card"] != "tok" || event.FormValue["multica_input"] != "改到周五" {
		t.Fatalf("event = %+v", event)
	}

	legacy, err := ParseCardActionPayload([]byte(`{"open_id":"ou_x","open_message_id":"om_2","action":{"value":"{\"multica_card\":\"t2\"}"}}`))
	if err != nil || legacy.OperatorOpenID != "ou_x" || legacy.MessageID != "om_2" || legacy.Value["multica_card"] != "t2" {
		t.Fatalf("legacy = %+v err=%v", legacy, err)
	}

	if _, err := ParseCardActionPayload([]byte(`{"schema":"2.0","event":{"action":{}}}`)); err == nil {
		t.Fatal("a callback without message or operator must be rejected")
	}
}

func TestWSConnectorAnswersCardActionsInTheAck(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		t.Error("card callbacks must not reach the message decoder")
		return InboundMessage{}, false, nil
	})
	c := connectorWithLogger(t, conn, decoder, time.Hour, slog.Default())
	var mu sync.Mutex
	var got CardActionEvent
	c.cfg.CardActions = cardActionHandlerFunc(func(ctx context.Context, inst Installation, event CardActionEvent) *CardActionReply {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("card action handler must run under a deadline")
		}
		mu.Lock()
		got = event
		mu.Unlock()
		return &CardActionReply{Toast: &CardToast{Type: CardToastSuccess, Content: "已同意"}, Card: json.RawMessage(`{"schema":"2.0"}`)}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	pushCardFrame(conn, []byte(testCardCallback), "m1")
	waitForWrites(t, conn, 1)
	code, data := decodeAckData(t, conn.snapshot()[0])
	if code != 200 {
		t.Fatalf("ack code = %d", code)
	}
	var reply struct {
		Toast CardToast `json:"toast"`
		Card  struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		} `json:"card"`
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatalf("decode callback reply %s: %v", data, err)
	}
	if reply.Toast.Content != "已同意" || reply.Card.Type != "raw" || string(reply.Card.Data) != `{"schema":"2.0"}` {
		t.Fatalf("reply = %s", data)
	}
	mu.Lock()
	if got.MessageID != "om_1" {
		t.Fatalf("handler saw %+v", got)
	}
	mu.Unlock()
	cancel()
	<-done
}

func TestWSConnectorWithoutCardActionsAcksCardFramesAsBefore(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := connectorWithLogger(t, conn, decoder, time.Hour, slog.Default())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	pushCardFrame(conn, []byte(testCardCallback), "m1")
	waitForWrites(t, conn, 1)
	code, data := decodeAckData(t, conn.snapshot()[0])
	if code != 200 || len(data) != 0 {
		t.Fatalf("ack code=%d data=%s, want a bare 200", code, data)
	}
	cancel()
	<-done
}
