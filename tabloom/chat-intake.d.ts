export interface ChatMessage { sender: string; text: string }
export function parseChat(raw: string): ChatMessage[];
export function senderList(messages: ChatMessage[]): Array<{ sender: string; count: number }>;
export function matchSenders(senders: string[], guests: Array<{ id: string; name: string }>): { matched: Record<string, string>; unmatched: string[] };
export function buildChatNote(messages: ChatMessage[], guestNameBySender: Record<string, string>, limit?: number): { note: string; used: number; dropped: number };
export function guestLine(row: { name: string; cents: number; url?: string }): string;
export function buildGroupMessage(input: { title?: string; rows: Array<{ name: string; cents: number; url?: string }>; receiptCents: number }): string;
export function buildGuestMessage(input: { title?: string; row: { name: string; cents: number; url?: string } }): string;
