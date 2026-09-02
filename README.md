# Fomo Helper (Fomo放大镜)

**English** · [中文](README.zh-CN.md)

A Chrome extension for [fomo.family](https://fomo.family). Open any token page and one card shows the token's narrative, every holder's thesis and the top holders — the stuff you'd otherwise click around three places for. No backend, no account, collects nothing.

[Guide](https://hogen.pro/fomo-helper) · [Download](https://github.com/mickeyhogen/fomo-helper/releases/latest) · [Privacy](PRIVACY.md) · [Changelog](CHANGELOG.md) · by [@0xHogen](https://x.com/0xHogen)

<table>
<tr>
<td align="center"><b>Meta</b></td>
<td align="center"><b>Thesis</b></td>
<td align="center"><b>Holders</b></td>
</tr>
<tr>
<td><img src="test/screenshots/30-en-meta.png" width="280" alt="Meta tab"></td>
<td><img src="test/screenshots/31-en-thesis.png" width="280" alt="Thesis tab"></td>
<td><img src="test/screenshots/32-en-holders.png" width="280" alt="Holders tab"></td>
</tr>
</table>

## What's on the card

- **Meta** — where the narrative came from, the rating rationale, the source tweets, how it spread, and the dev (data from DeBot, shown as-is). The chips next to the ticker (`$HIMS` `$LLY` …) are the token's **secondary-pool pairs** from DexScreener — the main pool (`$ETH`, `$USDC`…) is deliberately hidden.
- **Thesis** — every holder's thesis for *this* token, with likes, position and PnL. Sort **By likes** (default) or **Newest ≥2 likes** (with post time).
- **Holders** — top holders with position, PnL and how long they've held.
- **中/EN** in the header switches the card language. Chinese theses can be auto-translated when Chrome's built-in translator is available.

## Install

1. [Download the zip](https://github.com/mickeyhogen/fomo-helper/releases/latest) and unzip it → a `fomo-helper/` folder
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `fomo-helper` folder
3. Open any token page on `fomo.family` — the card pops up

**Update:** unzip the new version over the same folder, then hit ↻ on the extension's card in `chrome://extensions`. Settings are kept.

## Using it

- Drag the header to move the card; `Esc` or click outside to close; the `🔍` button at the bottom-right reopens it.
- Hover a row in fomo's left panel for 0.6 s to preview that token without leaving the page.
- Click the extension icon for settings: **auto-open mode** (compact / full / off), **hover preview**, **default language**. Changes apply immediately.

## Good to know

- **Friends only**: Thesis and Holders read what fomo currently shows. With *Friends only* on you only see friends — the card says so when it's empty.
- The Holders table is lazy-loaded. Scroll it into view once and the card fills itself.
- *Newest* sorting needs fomo's thesis feed rendered — open that tab once.
- "No narrative" means DeBot has no record for the token. That's the data, not the extension.
- If fomo redesigns its page, Thesis / Holders may degrade to a grey hint. Please open an issue.

## Privacy

Runs only on `fomo.family`. Talks to four fixed public endpoints — DeBot, FxTwitter, DexScreener and the page itself — and nothing else. Never touches your fomo session, cookies or wallet; no analytics, no tracking. Details in [PRIVACY.md](PRIVACY.md).

MIT © 2026 [0xHogen](https://x.com/0xHogen) · design notes (中文): [docs/DETAILS.zh-CN.md](docs/DETAILS.zh-CN.md)
