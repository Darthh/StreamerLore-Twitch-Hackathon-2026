import type { Lore, Moment, StreamState } from '../shared/types.ts';

export const DEMO_PROFILE = { login: 'thedarthh', displayName: 'TheDarthh', profileImageUrl: '/assets/thedarthh-profile.png' };

export type Snapshot = {
  channel: StreamState['channel']; stream: StreamState['stream']; moments: Moment[]; lore: Lore[];
  loreDropId: string | null; scenarioStep: number; captions: string;
  chat: { user: string; text: string; at: string }[];
};

export function createSeed(demo: boolean, now = Date.now()): Snapshot {
  const startedAt = new Date(now - 134 * 60_000).toISOString();
  if (!demo) return {
    channel: { login: process.env.TWITCH_CHANNEL || '', displayName: process.env.TWITCH_CHANNEL || 'Your channel', category: 'Waiting for Twitch', title: 'A new chapter starts here', live: false, startedAt: new Date(now).toISOString() },
    stream: { objective: 'Set the stream objective in the moderator room.', summary: [], updatedAt: new Date(now).toISOString() },
    moments: [], lore: [], loreDropId: null, scenarioStep: 0, captions: '', chat: [],
  };
  const moment = (id: string, title: string, body: string, kind: Moment['kind'], minutes: number): Moment => ({
    id, title, body, kind, at: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), offsetSeconds: minutes * 60, source: 'demo', clipUrl: '',
  });
  const lore = (id: string, term: string, explanation: string, origin: string, category: Lore['category'], votes: number, aliases: string[] = [], status: Lore['status'] = 'approved'): Lore => ({
    id, term, explanation, origin, category, votes, aliases, status, clipUrl: '', source: 'demo', createdAt: new Date(now - 3 * 86_400_000).toISOString(),
  });
  return {
    channel: { ...DEMO_PROFILE, category: 'Celeste', title: 'One summit. Zero dashes. Probably a terrible idea.', live: true, startedAt },
    stream: { objective: 'Reach the summit without using a single dash.', summary: [
      'TheDarthh is attempting a no-dash summit run. The community has named the final climb “The Refrigerator.”',
      'After 12 attempts, a new wall-jump route finally worked. The summit is the next big hurdle.',
      'If chat says “hold the milk,” they mean slow down and commit to the jump. Yes, there is a story.',
    ], updatedAt: new Date(now - 2 * 60_000).toISOString() },
    moments: [
      moment('moment-6', 'A new route. A little hope.', 'The wall-jump shortcut worked on attempt 12. TheDarthh is back at the final climb.', 'milestone', 132),
      moment('moment-5', '“Hold the milk” makes a comeback', 'Chat brought back the classic after TheDarthh rushed the same jump three times.', 'context', 118),
      moment('moment-4', 'The summit was right there', 'An early jump ended attempt 11, one room before the final climb.', 'setback', 101),
      moment('moment-3', 'Checkpoint unlocked', 'The first half of the mountain is complete. Chat voted to keep the no-dash rule.', 'milestone', 74),
      moment('moment-2', 'The Refrigerator has entered the chat', 'A very square ice wall reminded the community of a very old kitchen incident.', 'highlight', 36),
      moment('moment-1', 'A wonderfully bad idea begins', 'The community picked today’s challenge: reach the summit, zero dashes allowed.', 'context', 0),
    ],
    lore: [
      lore('refrigerator', 'The Refrigerator', 'The community’s name for any obstacle that looks easy but refuses to move. Today, it is the final ice wall.', 'In this fictional demo history, TheDarthh spent 40 minutes trying to move a refrigerator in a co-op game before noticing it was part of the background. Chat never let it go.', 'Inside joke', 128, ['fridge', 'refrigerator']),
      lore('hold-the-milk', 'Hold the milk', 'A loving reminder to slow down before doing something spectacularly avoidable.', 'In this demo story, TheDarthh announced “hold my milk” before a speedrun shortcut and immediately fell into the first pit. The phrase became chat’s unofficial caution sign.', 'Inside joke', 96, ['milk', 'hold my milk']),
      lore('one-more', 'One more means seven', 'When TheDarthh says “one more attempt,” regulars settle in. The stream usually has a few attempts left.', 'A fictional end-of-stream promise turned into seven more boss attempts. Now chat keeps a ceremonial counter.', 'Tradition', 74, ['one more', 'seven']),
      lore('sir-beans', 'Sir Beans', 'The tiny frog on TheDarthh’s desk. Unofficial coach. Zero useful advice. Immaculate vibes.', 'A viewer named the desk frog during a demo community art night. Every difficult run now begins with a nod to Sir Beans.', 'Character', 63, ['beans', 'frog']),
      lore('kitchen-percent', 'Kitchen%', 'The community’s invented speedrun category for accidentally turning any game into a cooking disaster.', 'In the demo archive, a five-minute cooking detour became a full stream. The name stuck whenever TheDarthh ignores the main quest for food.', 'Moment', 51, ['kitchen']),
      lore('summit-tax', 'The summit tax', 'One unnecessary fall immediately before the finish. Chat considers it a mountain toll.', 'Suggested during today’s fictional challenge after the third near-finish fall. A moderator has approved it for a community vote.', 'Inside joke', 2, ['tax'], 'nominated'),
      lore('wall-friend', 'Wall friend', 'A proposed name for the wall TheDarthh keeps returning to on the no-dash run.', 'Demo draft: several chat messages repeated “wall friend” after the new shortcut. A moderator still needs to verify the meaning and origin.', 'Inside joke', 0, ['wall'], 'pending'),
      lore('gravity-check', 'Gravity check', 'A proposed phrase for a quick accidental fall between serious attempts.', 'Demo draft awaiting review. Repeated by a few viewers after attempt 11; the backstory has not been confirmed.', 'Moment', 0, ['gravity'], 'pending'),
    ], loreDropId: null, scenarioStep: 0, captions: '', chat: [],
  };
}

export function advanceDemo(snapshot: Snapshot): void {
  const now = new Date().toISOString();
  const step = snapshot.scenarioStep++ % 3;
  if (step === 0) {
    snapshot.moments.unshift({ id: `demo-${Date.now()}`, title: 'THE SUMMIT. FINALLY.', body: 'Attempt 13 is the one. TheDarthh completed the no-dash summit run, and chat is celebrating with a very predictable appliance.', kind: 'milestone', at: now, offsetSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.channel.startedAt)) / 1000)), source: 'demo', clipUrl: '' });
    snapshot.stream.objective = 'Summit reached. Pick the community’s next challenge.';
    snapshot.stream.summary = ['TheDarthh just completed the no-dash summit run on attempt 13.', 'The wall-jump route made the difference after 12 failed attempts.', 'Chat is celebrating with “refrigerator.” It is an old channel joke about stubborn obstacles.'];
    snapshot.loreDropId = 'refrigerator';
  } else if (step === 1) {
    snapshot.moments.unshift({ id: `demo-${Date.now()}`, title: 'A tribute to Sir Beans', body: 'TheDarthh credits the desk frog with the win. The community is taking this entirely seriously.', kind: 'highlight', at: now, offsetSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.channel.startedAt)) / 1000)), source: 'demo', clipUrl: '' });
    snapshot.loreDropId = 'sir-beans';
    snapshot.stream.summary = ['The no-dash summit challenge is complete.', 'TheDarthh dedicated the win to Sir Beans, the community’s tiny desk-frog mascot.', 'The community is choosing what to play next.'];
  } else {
    snapshot.loreDropId = null;
    snapshot.stream.objective = 'One more run. Chat knows what that means.';
    snapshot.stream.summary = ['The summit run is complete, but TheDarthh has promised “one more.”', 'Regulars know that usually means seven. There is a whole channel tradition.', 'You are all caught up. An excellent time to join the next attempt.'];
  }
  snapshot.stream.updatedAt = now;
}
