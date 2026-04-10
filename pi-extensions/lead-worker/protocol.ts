import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type PairRole = "lead" | "worker";
export type PairMessageType = "request" | "reply" | "command" | "event";

export type PairMessageV2 = {
  version: 2;
  id: string;
  type: PairMessageType;
  from: PairRole;
  to: PairRole;
  pairId: string;
  timestamp: string;
  name?: string;
  body?: string;
  payload?: unknown;
  replyTo?: string;
  ok?: boolean;
  error?: string;
  handoffId?: string;
};

export function createMessage(params: Omit<PairMessageV2, "version" | "id" | "timestamp"> & { id?: string; timestamp?: string }): PairMessageV2 {
  return {
    version: PROTOCOL_VERSION,
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? new Date().toISOString(),
    ...params,
  };
}

export function validateMessage(value: unknown): PairMessageV2 {
  if (typeof value !== "object" || value === null) {
    throw new Error("message must be an object");
  }

  const msg = value as Record<string, unknown>;
  const type = msg.type;
  const from = msg.from;
  const to = msg.to;

  if (msg.version !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version: ${String(msg.version)}`);
  if (typeof msg.id !== "string" || !msg.id.trim()) throw new Error("message.id must be a non-empty string");
  if (type !== "request" && type !== "reply" && type !== "command" && type !== "event") {
    throw new Error(`invalid message.type: ${String(type)}`);
  }
  if (from !== "lead" && from !== "worker") throw new Error(`invalid message.from: ${String(from)}`);
  if (to !== "lead" && to !== "worker") throw new Error(`invalid message.to: ${String(to)}`);
  if (typeof msg.pairId !== "string" || !msg.pairId.trim()) throw new Error("message.pairId must be a non-empty string");
  if (typeof msg.timestamp !== "string" || !msg.timestamp.trim()) throw new Error("message.timestamp must be a non-empty string");
  if (msg.name !== undefined && typeof msg.name !== "string") throw new Error("message.name must be a string when present");
  if (msg.body !== undefined && typeof msg.body !== "string") throw new Error("message.body must be a string when present");
  if (msg.replyTo !== undefined && typeof msg.replyTo !== "string") throw new Error("message.replyTo must be a string when present");
  if (msg.ok !== undefined && typeof msg.ok !== "boolean") throw new Error("message.ok must be a boolean when present");
  if (msg.error !== undefined && typeof msg.error !== "string") throw new Error("message.error must be a string when present");
  if (msg.handoffId !== undefined && typeof msg.handoffId !== "string") throw new Error("message.handoffId must be a string when present");

  if ((type === "command" || type === "event") && (typeof msg.name !== "string" || !msg.name.trim())) {
    throw new Error(`message.name is required for ${type}`);
  }
  if (type === "reply") {
    if (typeof msg.replyTo !== "string" || !msg.replyTo.trim()) throw new Error("message.replyTo is required for reply");
    if (typeof msg.ok !== "boolean") throw new Error("message.ok is required for reply");
  }

  return msg as PairMessageV2;
}

export function encodeMessage(message: PairMessageV2): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`message exceeds max frame size (${payload.byteLength} > ${MAX_FRAME_BYTES})`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function writeMessage(socket: Socket, message: PairMessageV2): void {
  socket.write(encodeMessage(message));
}

export function createMessageReader(
  onMessage: (message: PairMessageV2) => void,
  onProtocolError: (error: Error) => void,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);

  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length <= 0 || length > MAX_FRAME_BYTES) {
          throw new Error(`invalid frame length: ${length}`);
        }
        if (buffer.length < 4 + length) return;

        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          throw new Error(`invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
        }

        onMessage(validateMessage(parsed));
      }
    } catch (error) {
      onProtocolError(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
