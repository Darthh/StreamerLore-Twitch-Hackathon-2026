# Twitch UI reference

Captured on October 26, 2026 from the public, signed-out Twitch homepage. StreamLore remains its own application; this reference supplies typography, colors, and layout measurements.

## REA investigation

Used official `rea-agents@6.8.0` from npm and the matching `reverse-engineer-anything` skill. REA was run through an isolated Node.js 26.12.1 runtime in `/tmp/streamlore-rea-tools`, because the workspace runtime was below REA's published minimum. No global agent configuration or Node installation was changed.

REA attached to a disposable headless Chrome 155 profile at `http://127.0.0.1:9223`; it did not read the user's signed-in browser profile.

```sh
rea list-browser-targets http://127.0.0.1:9223 --json
rea inspect-web-page http://127.0.0.1:9223 TARGET_ID --include-accessibility-text --observation-ms 1000 --json
rea capture-web-screenshot http://127.0.0.1:9223 TARGET_ID --json
rea inspect-web-page http://127.0.0.1:9223 TARGET_ID --allowed-origins https://www.twitch.tv --allowed-origins https://assets.twitch.tv --include-script-sources --observation-ms 500 --json
```

Local evidence, intentionally ignored by Git under `artifacts/rea/`:

- `twitch-page.json`: REA DOM/accessibility observation.
- `twitch-scripts.json`: REA captured script-source evidence.
- `twitch-screenshot.json` and `twitch-reference.png`: REA viewport capture.
- `twitch-core.css`: public stylesheet fetched from the URL in Twitch's HTML.
- `twitch-design-source.js`: theme token source extracted from the REA script capture.

First-page evidence ID: `ev_855d6713009920719d0c2ccc70700e12a1bd19d38b7ba43a32b074081212761e` (target inventory). Screenshot evidence ID: `ev_fe099dc41af34bb9ee3cec0f0e77b7d9efda78fb4ecad95b36776b86c5f06642`.

## Verified design values

The captured dark-theme definitions resolve these values:

| Element | Value |
| --- | --- |
| Page background | `#0e0e10` |
| Base/top bar | `#18181b` |
| Alternate/sidebar surface | `#26262c` |
| Intermediate surface | `#1f1f23` |
| Raised surface | `#323239` |
| Main text | `#efeff1` |
| Grey palette 9 | `#adadb8` |
| Grey palette 11 / text-alt-2 | `#d3d3d9` |
| Primary button | `#9147ff` |
| Primary button hover | `#772ce8` |
| Links | `#bf94ff` |
| Link hover | `#a970ff` |
| Secondary button | `rgba(83, 83, 95, 0.38)` |
| Border base | `rgba(83, 83, 95, 0.48)` |
| Top navigation height | `5rem` (50px with Twitch's root scale) |
| Expanded sidebar width | `24rem` (240px) |
| Body type size | `1.4rem` (14px) |
| Medium / large type | `1.8rem` / `2.4rem` (18px / 24px) |
| Body / heading line height | `1.4` / `1.1` |
| Button default / small / large | `3.2rem` / `2.4rem` / `3.6rem` |
| Medium corner radius | `0.4rem` (4px) |
| Default / large tabs | `3rem` / `4rem` |

Font stacks recovered from the theme source:

- Body: `"Inter", "Noto Sans Arabic", "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif`.
- Display: `"Roobert", "Tajawal", "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`.

The public CSS declares these exact Twitch-hosted font resources:

- [Roobert Regular](https://assets.twitch.tv/assets/Roobert-Regular-62f5cf0ef63ddd1ff1db.woff2)
- [Roobert Medium](https://assets.twitch.tv/assets/Roobert-Medium-417d5246124d150d8282.woff2)
- [Roobert Semibold](https://assets.twitch.tv/assets/Roobert-SemiBold-3b15a6369038c1c15954.woff2)
- [Roobert Bold](https://assets.twitch.tv/assets/Roobert-Bold-e8a29e94b2ce9ff073bb.woff2)
- [Inter Latin variable](https://assets.twitch.tv/assets/inter-latin-variable-wghtOnly-normal-383d894ed1f69dd95820.woff2)

Primary source artifacts:

- [Public core CSS](https://assets.twitch.tv/assets/core-ed50dd7cf0ed58d80a54.css): font-face declarations and `.side-nav` width/background.
- [Theme-token bundle](https://assets.twitch.tv/assets/74563-35b9ada3ad5fe9c85d26.js): fonts, spacing, colors, and component tokens.
- [Top-navigation bundle](https://assets.twitch.tv/assets/34759-b74b772ba9d8b8b561ba.js): `top-nav` explicitly renders `height: "5rem"`.

## Limits

REA observes a bounded attachment window. It does not recover network activity from before attachment, and the screenshot contains a cookie-choice notice and narrow-viewport sidebar. Token values above come from captured production code and the public stylesheet, rather than an assumption based on that screenshot. Twitch may change its assets; the recorded filenames and values describe this capture.
