import { z } from "zod";
import {
  RegisterAckMessageSchema,
  RegisterMessageSchema,
  RegisterRejectMessageSchema,
} from "./handshake.js";
import {
  AcceptMessageSchema,
  HeartbeatMessageSchema,
  NeedsInputMessageSchema,
  RunStatusMessageSchema,
  UploadMessageSchema,
} from "./client.js";
import {
  AnswerDeliveryMessageSchema,
  CancelMessageSchema,
  HeartbeatAckMessageSchema,
  LeaseMessageSchema,
  UploadAckMessageSchema,
} from "./server.js";

/**
 * The `/agent/v1` WSS message contract — assembled: two discriminated unions
 * over `type` (`ClientMessage` = agent→server, `ServerMessage` = server→agent),
 * a tolerant `AnyWireMessage` for forward-compat, and their parse helpers. Same
 * pattern as the events module (`../events/`): a strict discriminated union +
 * `parse*`, plus a tolerant `Any*` for a newer peer's unknown message type.
 */

// ── Re-export the pieces (schemas, inferred types, enums, helpers) ───────────
export * from "./envelope.js";
export * from "./handshake.js";
export * from "./client.js";
export * from "./server.js";

// ── AGENT → SERVER: `ClientMessage` ──────────────────────────────────────────

/** Every agent→server message variant, keyed by `type`. `register` (the opening
 *  handshake frame) is a client message; its ACKs are server messages. */
export const CLIENT_MESSAGE_VARIANTS = [
  RegisterMessageSchema,
  HeartbeatMessageSchema,
  AcceptMessageSchema,
  NeedsInputMessageSchema,
  UploadMessageSchema,
  RunStatusMessageSchema,
] as const;

/**
 * Strict, well-typed agent→server message: a discriminated union over `type`.
 * Rejects a malformed KNOWN message and an UNKNOWN `type`. For tolerant parsing
 * of an unknown-but-well-formed frame (a newer peer's new message type), use
 * {@link AnyWireMessage} from `./envelope.ts`.
 */
export const ClientMessage = z.discriminatedUnion("type", CLIENT_MESSAGE_VARIANTS);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** The literal string union of every agent→server message `type`. */
export const CLIENT_MESSAGE_TYPES = CLIENT_MESSAGE_VARIANTS.map((v) => v.shape.type.value) as readonly ClientMessage["type"][];
export type ClientMessageType = ClientMessage["type"];

// ── SERVER → AGENT: `ServerMessage` ──────────────────────────────────────────

/** Every server→agent message variant, keyed by `type`. */
export const SERVER_MESSAGE_VARIANTS = [
  RegisterAckMessageSchema,
  RegisterRejectMessageSchema,
  LeaseMessageSchema,
  AnswerDeliveryMessageSchema,
  CancelMessageSchema,
  HeartbeatAckMessageSchema,
  UploadAckMessageSchema,
] as const;

/**
 * Strict, well-typed server→agent message: a discriminated union over `type`.
 * Rejects a malformed KNOWN message and an UNKNOWN `type`. For tolerant parsing,
 * use {@link AnyWireMessage}.
 */
export const ServerMessage = z.discriminatedUnion("type", SERVER_MESSAGE_VARIANTS);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** The literal string union of every server→agent message `type`. */
export const SERVER_MESSAGE_TYPES = SERVER_MESSAGE_VARIANTS.map((v) => v.shape.type.value) as readonly ServerMessage["type"][];
export type ServerMessageType = ServerMessage["type"];

// ── Parse helpers ────────────────────────────────────────────────────────────

/**
 * Parse an unknown value as a well-typed AGENT→SERVER message. THROWS a
 * `ZodError` on a malformed known message or an unknown `type`. For tolerant
 * parsing of an unknown-but-well-formed frame, use `AnyWireMessage.parse`.
 */
export function parseClientMessage(input: unknown): ClientMessage {
  return ClientMessage.parse(input);
}

/** Non-throwing {@link parseClientMessage}: returns a zod `SafeParseReturnType`. */
export function safeParseClientMessage(input: unknown): z.SafeParseReturnType<unknown, ClientMessage> {
  return ClientMessage.safeParse(input);
}

/**
 * Parse an unknown value as a well-typed SERVER→AGENT message. THROWS a
 * `ZodError` on a malformed known message or an unknown `type`. For tolerant
 * parsing, use `AnyWireMessage.parse`.
 */
export function parseServerMessage(input: unknown): ServerMessage {
  return ServerMessage.parse(input);
}

/** Non-throwing {@link parseServerMessage}: returns a zod `SafeParseReturnType`. */
export function safeParseServerMessage(input: unknown): z.SafeParseReturnType<unknown, ServerMessage> {
  return ServerMessage.safeParse(input);
}
