# StreamLore native Twitch Extension

The viewer stays in the channel: a 320px panel and responsive mobile view show catch-up cards, approved lore, origin clips, and community ballots. Configuration and Live Config provide channel-scoped creator controls. No secrets belong in these front-end files.

Build upload assets with a reachable public EBS origin:

```sh
npm run build:extension -- --api-url https://your-streamlore-api.example.com
```

This writes `dist-extension/` and `release/streamlore-twitch-extension.zip`. The upload ZIP contains only the four HTML views, two bundled assets, and generated public `config.js`. It excludes source notes, `.env` files, and all server code. The builder rejects missing API origins, embedded credentials, URL paths, private-network production origins, and insecure production HTTP.

For explicit localhost testing:

```sh
npm run build:extension -- --api-url http://127.0.0.1:8787 --local-test
```

Use the local Express server’s `/extension/panel.html?demo=1` only for a read-only fictional preview. Demo mode is accepted only on loopback. It cannot perform writes or bypass Twitch authorization. Inside Twitch, `onAuthorized` provides the latest JWT, sent in the `Authorization: Bearer …` header on every EBS request. The EBS verifies the role, channel, identity, signature, and expiration; URL parameters never select the channel. Tokens stay in memory.

Set these entry paths in the Twitch Extensions Manager:

| View | Asset path |
| --- | --- |
| Panel | `panel.html` |
| Mobile | `mobile.html` |
| Configuration | `config.html` |
| Live configuration | `live.html` |

The Twitch helper is the first script in all four pages. All other JavaScript and CSS is packaged, readable, and free of inline script, `eval`, third-party trackers, or external fonts. Declare the public API origin under allowed fetch domains and `https://static-cdn.jtvnw.net` for actual channel profile images. Origin clips open on Twitch in a clearly labeled new tab. OAuth authorization uses a link to `https://id.twitch.tv` from the broadcaster configuration view.

Connect the broadcaster’s Twitch account and share the creator’s Twitch identity before publishing. This lets the backend verify and display creator attribution; viewers can read without identity sharing. Configuration is complete after the broadcaster saves an objective and clicks **Save channel setup**. That writes server-side setup state and the broadcaster Configuration Service segment, version `1`, content `{"configured":true}`. Any required-configuration identifier must match the EBS configuration API integration; a frontend segment alone does not mark Twitch’s server-side required configuration as satisfied.

The initial package is for Local Test / Hosted Test. Public installation still requires Twitch review and release; test accounts can try prerelease versions. See [Twitch’s lifecycle](https://dev.twitch.tv/docs/extensions/life-cycle/), [helper reference](https://dev.twitch.tv/docs/extensions/reference/), and [Extension policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/). Test mobile behavior inside Twitch’s iOS and Android apps before submitting.
