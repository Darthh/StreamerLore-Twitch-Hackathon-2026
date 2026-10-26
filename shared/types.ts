export type LoreCategory = 'Inside joke' | 'Tradition' | 'Character' | 'Moment';
export type ContentAuthor = { id: string; login: string; displayName: string };
export type Lore = {
  id: string; term: string; aliases: string[]; explanation: string; origin: string;
  clipUrl: string; category: LoreCategory; status: 'approved' | 'pending' | 'nominated' | 'rejected';
  votes: number; createdAt: string; source: 'demo' | 'moderator' | 'ai' | 'community';
  author?: ContentAuthor; reviewedBy?: ContentAuthor;
};
export type Moment = {
  id: string; title: string; body: string; kind: 'milestone' | 'setback' | 'highlight' | 'context';
  at: string; offsetSeconds: number; source: 'demo' | 'moderator' | 'captions' | 'twitch'; clipUrl: string;
  author?: ContentAuthor;
};
export type Connection = { configured: boolean; connected: boolean; message: string };
export type StreamState = {
  mode: 'demo' | 'live';
  channel: { login: string; displayName: string; profileImageUrl?: string; category: string; title: string; live: boolean; startedAt: string };
  stream: { objective: string; summary: string[]; updatedAt: string };
  moments: Moment[]; lore: Lore[]; nominations: Lore[]; loreDrop: Lore | null;
  stats: { moments: number; lore: number; pending: number };
  connection: { twitch: Connection; ai: Connection };
};
export type ModeratorState = { pending: Lore[]; rejected: Lore[]; captions: string; chat: { user: string; text: string; at: string }[] };
export type AuthState = { authenticated: boolean; demoAccess: boolean; extensionManaged?: boolean };
