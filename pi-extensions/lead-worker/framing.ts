/**
 * Length-prefixed JSON framing for lead–worker Unix socket communication.
 * Wire format: [4-byte big-endian uint32 length][UTF-8 JSON payload]
 */

import type { Socket } from "net";

export interface Message {
	id: string;
	type: "request" | "reply" | "command";
	replyTo?: string; // set on replies: ID of the originating request
	payload: string;  // task, status, question, answer, or command string
}

export function writeMessage(socket: Socket, msg: Message): void {
	const json = Buffer.from(JSON.stringify(msg), "utf8");
	const len = Buffer.allocUnsafe(4);
	len.writeUInt32BE(json.length, 0);
	socket.write(Buffer.concat([len, json]));
}

export function createMessageReader(onMessage: (msg: Message) => void): (chunk: Buffer) => void {
	let buf = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 4) {
			const msgLen = buf.readUInt32BE(0);
			if (buf.length < 4 + msgLen) break;
			const payload = buf.subarray(4, 4 + msgLen).toString("utf8");
			buf = buf.subarray(4 + msgLen);
			try {
				onMessage(JSON.parse(payload) as Message);
			} catch {
				// malformed JSON — skip
			}
		}
	};
}
