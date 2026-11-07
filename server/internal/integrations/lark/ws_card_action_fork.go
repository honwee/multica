package lark

// Fork extension point (see FORK.md): interactive card callbacks
// (card.action.trigger) received over the bot's long connection. Lark expects
// the callback answer — a toast and/or a replacement card — inside the ACK
// frame, within about three seconds, so the handler runs inline on the read
// loop under CardActionTimeout.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// CardActionEventType is the callback Lark sends when a card button is
// clicked or a card form is submitted.
const CardActionEventType = "card.action.trigger"

// CardActionTimeout bounds one callback, leaving room for the ACK write inside
// Lark's three second budget.
const CardActionTimeout = 2500 * time.Millisecond

// CardActionHandler answers a card callback for one installation. It must
// return within ctx; a nil reply ACKs without changing the card.
type CardActionHandler interface {
	HandleCardAction(ctx context.Context, inst Installation, event CardActionEvent) *CardActionReply
}

// CardActionEvent is the part of a card callback the platform reads.
type CardActionEvent struct {
	EventID         string
	OperatorOpenID  string
	OperatorUnionID string
	MessageID       string
	ChatID          string
	// Value is the button's callback value, as the card declared it.
	Value map[string]any
	// FormValue holds the form inputs when the button submits a form.
	FormValue map[string]any
	// InputValue is set when a standalone input element is submitted.
	InputValue string
}

// CardActionReply is the callback answer.
type CardActionReply struct {
	Toast *CardToast
	// Card, when set, replaces the clicked card (schema 2.0 card JSON).
	Card json.RawMessage
}

// CardToast types.
const (
	CardToastSuccess = "success"
	CardToastInfo    = "info"
	CardToastWarning = "warning"
	CardToastError   = "error"
)

type CardToast struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// MarshalJSON renders the callback response body Lark expects.
func (r CardActionReply) MarshalJSON() ([]byte, error) {
	body := map[string]any{}
	if r.Toast != nil {
		body["toast"] = r.Toast
	}
	if len(r.Card) > 0 {
		body["card"] = map[string]any{"type": "raw", "data": r.Card}
	}
	return json.Marshal(body)
}

type cardActionEnvelope struct {
	Schema string `json:"schema"`
	Header struct {
		EventID   string `json:"event_id"`
		EventType string `json:"event_type"`
	} `json:"header"`
	Event *cardActionBody `json:"event"`
	// Legacy (v1) callbacks put the body at the top level.
	cardActionBody
}

type cardActionBody struct {
	Operator *struct {
		OpenID  string `json:"open_id"`
		UnionID string `json:"union_id"`
	} `json:"operator"`
	OpenID        string `json:"open_id"`
	OpenMessageID string `json:"open_message_id"`
	OpenChatID    string `json:"open_chat_id"`
	Action        struct {
		Value      json.RawMessage `json:"value"`
		FormValue  map[string]any  `json:"form_value"`
		InputValue string          `json:"input_value"`
	} `json:"action"`
	Context *struct {
		OpenMessageID string `json:"open_message_id"`
		OpenChatID    string `json:"open_chat_id"`
	} `json:"context"`
}

// ParseCardActionPayload decodes a card callback in either the schema 2.0
// event envelope or the legacy top-level shape.
func ParseCardActionPayload(payload []byte) (CardActionEvent, error) {
	var env cardActionEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return CardActionEvent{}, fmt.Errorf("card action envelope: %w", err)
	}
	body := env.cardActionBody
	if env.Event != nil {
		body = *env.Event
	}
	out := CardActionEvent{
		EventID:        env.Header.EventID,
		MessageID:      body.OpenMessageID,
		ChatID:         body.OpenChatID,
		FormValue:      body.Action.FormValue,
		InputValue:     body.Action.InputValue,
		OperatorOpenID: body.OpenID,
	}
	if body.Operator != nil {
		if body.Operator.OpenID != "" {
			out.OperatorOpenID = body.Operator.OpenID
		}
		out.OperatorUnionID = body.Operator.UnionID
	}
	if body.Context != nil {
		if body.Context.OpenMessageID != "" {
			out.MessageID = body.Context.OpenMessageID
		}
		if body.Context.OpenChatID != "" {
			out.ChatID = body.Context.OpenChatID
		}
	}
	if len(body.Action.Value) > 0 && string(body.Action.Value) != "null" {
		// Lark delivers an object value as an object; some legacy cards send
		// it as a JSON string.
		if err := json.Unmarshal(body.Action.Value, &out.Value); err != nil {
			var encoded string
			if json.Unmarshal(body.Action.Value, &encoded) != nil || json.Unmarshal([]byte(encoded), &out.Value) != nil {
				return CardActionEvent{}, errors.New("card action value is not an object")
			}
		}
	}
	if out.MessageID == "" || out.OperatorOpenID == "" && out.OperatorUnionID == "" {
		return CardActionEvent{}, errors.New("card action is missing the message or operator")
	}
	return out, nil
}

// isCardActionFrame reports whether a data frame carries a card callback.
func isCardActionFrame(frame *Frame, payload []byte) bool {
	if frame.HeaderValue(FrameHeaderTypeKey) == FrameHeaderTypeCard {
		return true
	}
	return PeekEventType(payload) == CardActionEventType
}

// cardActionAck runs the handler and builds the ACK carrying its answer.
func (c *WSLongConnConnector) cardActionAck(ctx context.Context, frame *Frame, inst Installation, payload []byte) *Frame {
	event, err := ParseCardActionPayload(payload)
	if err != nil {
		c.cfg.Logger.Warn("lark ws connector: card action decode failed", "err", err.Error())
		return NewAckFrame(frame, true)
	}
	handlerCtx, cancel := context.WithTimeout(ctx, CardActionTimeout)
	defer cancel()
	reply := c.cfg.CardActions.HandleCardAction(handlerCtx, inst, event)
	if reply == nil {
		return NewAckFrame(frame, true)
	}
	body, err := json.Marshal(reply)
	if err != nil {
		return NewAckFrame(frame, true)
	}
	return NewAckFrameWithData(frame, body)
}

// NewAckFrameWithData is a 200 ACK whose data is a callback response. The
// long-connection protocol carries it base64-encoded, as encoding/json does
// for a []byte field.
func NewAckFrameWithData(inbound *Frame, data []byte) *Frame {
	payload, _ := json.Marshal(struct {
		Code    int               `json:"code"`
		Headers map[string]string `json:"headers"`
		Data    []byte            `json:"data"`
	}{Code: 200, Data: data})
	return &Frame{
		Method:  inbound.Method,
		Service: inbound.Service,
		Headers: inbound.Headers,
		Payload: payload,
	}
}
