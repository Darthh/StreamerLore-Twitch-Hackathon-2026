# StreamLore

**What did I miss? What does that mean?** A Twitch companion that welcomes newcomers with a current-stream catch-up card and a channel’s lasting inside jokes, traditions, and characters.

## Run locally

Requires **Node.js 24 or later** (the server uses built-in SQLite and TypeScript support).

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. No credentials are needed for the fictional `pixelpilot` demo. The API runs on `127.0.0.1:8787`; Vite proxies `/api` to it.

For a production build served by the Node server:

```sh
npm run build
npm start
```

Then open **http://localhost:8787**. Change `STREAMLORE_PUBLIC_URL` to match the URL viewers will use.

## Try the demo

1. Read the catch-up card, current objective, and timestamped timeline.
   Ask “Why is chat saying refrigerator?” in the backstory box to open matching approved lore. Unknown phrases get an honest no-match response.
2. Open the lore library, search `refrigerator`, and read the backstory. Seeded histories, votes, and moments are fictional and labeled demo content. No fake clip links are supplied.
3. Enter **Moderator → Review queue**. Edit, approve, reject, or approve a draft for a community ballot. Unreviewed drafts never appear in the public library or bot replies.
4. Vote on a moderator-approved nomination. At **5 votes**, it becomes an approved library entry. The browser allows one vote per entry using a signed cookie; clearing cookies or changing browsers can bypass this limit. Twitch votes are deduplicated by Twitch user ID. This is a small-community ballot, not identity-verified voting.
5. Click **Play next moment** to advance the scenario. The recap and timeline update, and a classic joke gets an on-stream lore drop.
6. Open **Stream overlay**, or add `http://localhost:5173/overlay` as an OBS Browser Source. The background is transparent; an approved lore card appears when triggered and clears after 18 seconds.
7. **Moderator → Stream controls → Reset demo** restores the fictional history and removes demo edits and votes.

Demo mode grants moderator access to local connections. Keep it local; use live mode and a moderator password before exposing the server through hosting or a tunnel. A tunnel can make remote requests appear local to the server.

## Connect one Twitch channel

Copy `.env.example` to `.env`, fill in the values, and restart the server. `.env` and database files are ignored by Git.

```dotenv
STREAMLORE_MODE=live
STREAMLORE_MOD_PASSWORD=replace-with-a-long-private-password
TWITCH_CLIENT_ID=your-registered-twitch-application-client-id
TWITCH_ACCESS_TOKEN=your-user-access-token
TWITCH_CHANNEL=your_channel_login
STREAMLORE_PUBLIC_URL=https://your-viewer-accessible-domain.example
```

Register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). Obtain a **user access token issued for that application** with `user:read:chat` and `user:write:chat`. The simplest setup uses the broadcaster’s own account; that account also sends the command replies. This implementation uses EventSub WebSockets with a user token, rather than an app-token bot setup. See [Twitch chat authentication](https://dev.twitch.tv/docs/chat/authenticating/).

The moderator password must contain at least 12 characters. Sign in in the Moderator view; viewer pages remain readable without a moderator session. Live mode uses a separate, initially empty database. Changing from demo to live does not publish fictional history.

Supported chat commands:

| Command | Result |
| --- | --- |
| `!catchup` | Current recap and companion-page link. |
| `!lore` | A few available terms and the library link. |
| `!lore refrigerator` | Approved explanation and its clip or detail-page link. |
| `!lorevote summit tax` | Vote for a moderator-approved nomination. |

The bot validates its token at startup and hourly, reconnects EventSub, deduplicates events, and limits replies with a short cooldown. Keep a replacement token available when its authorization expires; automatic OAuth refresh is not implemented.

`localhost` works only on your computer. To share with viewers, serve the production build behind HTTPS or a tunnel and set `STREAMLORE_PUBLIC_URL` to that address. The Twitch EventSub connection is outbound and does not require a webhook. The default HTTP listener is loopback-only; `HOST` can change the binding when needed.

## Captions, clips, and optional AI

Manual objectives, moments, lore review, voting, and the overlay work without an AI key. Add these values to `.env` to enable AI:

```dotenv
OPENAI_API_KEY=your-private-api-key
OPENAI_MODEL=gpt-5.4-mini
```

The separate language model uses the Responses API to draft concise recaps and up to three lore candidates. Codex is the development tool used to build and test the application; it is not called to invent channel history at runtime.

In **Moderator → Captions & AI drafts**, paste streamer-provided captions or approved notes. Supply a Twitch clip link plus its transcript when using clip evidence. A URL or title alone is not evidence of what happened in a clip. StreamLore does **not** automatically capture OBS audio, fetch video, or transcribe clips. Use a caption provider or manually supply the excerpt.

The draft endpoint also accepts clip evidence directly:

```http
POST /api/mod/draft
Content-Type: application/json

{
  "captions": "The streamer explains that refrigerator means a stubborn obstacle.",
  "clipUrl": "https://clips.twitch.tv/YourActualClipIdentifier",
  "clipTitle": "Where the joke started",
  "clipTranscript": "An accurate transcript of the relevant clip excerpt."
}
```

Moderator authentication is required in live mode. The model can attach only a supplied clip URL supported by a transcript. Chat spikes are review signals: repeated phrases from distinct viewers can prompt a private draft, but cannot establish historical truth. AI drafts require moderator approval; familiar approved lore can trigger a drop after three distinct viewers mention it. Missing credentials or provider failures produce explicit unavailable/error states and preserve existing content.

## Storage and verification

The React/Vite interface receives approved state through server-sent events at `/api/events`. The Express server stores channel history, review state, votes, and the cookie-signing secret in SQLite under `data/`. Default files are `data/demo.sqlite` and `data/live.sqlite`; `STREAMLORE_DB_PATH` overrides the path. Back up the database if you want to preserve a channel’s history. A new live broadcast resets the current-stream timeline and recap while keeping channel lore.

```sh
npm test
npm run build
```

Tests cover API review boundaries, moderation authentication, voting, input validation, persistence, demo updates, lore triggers, chat-command parsing, and mocked Twitch/AI failures. Mocked integration tests are not proof of a live connection. Live Twitch delivery and real AI generation require your credentials and a final channel test.

## Hackathon submission

Include the source repository, installation instructions, a demo showing the project working on Twitch, and how Codex helped build it. Keep the Codex session ID for the thread containing most of the implementation (`/status` in Codex). Verify the current [hackathon submission requirements](https://twitchcon-codex.devpost.com/resources) before submitting. Do not commit tokens, `.env`, or private channel transcripts.
