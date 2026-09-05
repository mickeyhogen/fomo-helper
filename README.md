# Fomo Lens · Fomo放大镜

**English** · [中文](README.zh-CN.md)

One floating card for **Fomo, GMGN and XXYY**: token narratives, Fomo theses, holders and Fomo holding share. XXYY supports both its old and new layouts, including `www.xxyy.io` and `pro.xxyy.io`.

[Download v0.9.21](https://github.com/mickeyhogen/fomo-helper/releases/download/v0.9.21/fomo-helper-v0.9.21.zip) · [Guide](https://hogen.pro/fomo-helper/) · [Privacy](PRIVACY.md) · [Changelog](CHANGELOG.md) · MIT · by [@0xHogen](https://x.com/0xHogen)

## New since v0.9.8

- **Three sites, one extension.** Token pages open a compact card automatically. Hover over token rows to preview them; XXYY favorites, wallet monitor widgets and both layout versions are supported.
- **The same Fomo data everywhere.** Thesis, Holders and holding share come from Fomo. Sign in to Fomo in the same browser profile. If the extension cannot read the data, it provides the corresponding Fomo page and a retry action.
- **Fomo holding share at a glance.** The card shows the value of loaded Fomo holdings divided by market cap, with coverage counts. Incomplete coverage is marked `≥`; unavailable data is never presented as zero.
- **Reliable current-token loading.** XXYY pool URLs resolve to the actual contract, including Robinhood V4 pools. Mixed-case EVM addresses now retrieve the same narrative as lowercase hover addresses. Solana addresses retain their case.
- **Recovery and reopening.** Transient narrative failures retry once. Manual Retry preserves the loaded Fomo panels. A small draggable magnifier reopens the card after dismissal. Extension reloads reconnect existing supported pages.
- **Chinese and English.** Card and settings labels, loading states and login instructions are bilingual. Original theses keep their source language; optional local translation depends on browser support.

## In the card

**Meta** shows the DeBot narrative, rating rationale and source tweets. Origin and rationale are open by default; additional sections can be expanded. Secondary-pool chips come from DexScreener.

**Thesis** lists the highest-liked holder theses, up to 30, with position and PnL. The total reported by Fomo and the truncation notice are preserved. A newest-first view is available when the Fomo feed is readable.

**Holders** shows the six largest loaded positions, their PnL and holding duration; hover a row for average entry. The share bar uses **all loaded holder rows**, not just those six. It is not a complete on-chain ownership statistic.

Hover on a token row for about 0.6 seconds to preview it. Pin a preview with 📌. Drag the card header to move it, resize from the corner, or double-click the header to reset position and size. The reopen magnifier supports dragging, keyboard activation and saved position. Card placement is stored separately for each site.

## Install or update

Chrome, Edge and Brave are supported; Safari and Firefox are not.

1. Download the release ZIP and extract it to a permanent `fomo-helper` folder.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode and choose **Load unpacked**. Select the folder containing `manifest.json`.
3. Disable older separate Fomo/GMGN/XXYY editions to avoid duplicate cards. Allow the extension to run on the supported sites.
4. Sign in at [fomo.family](https://fomo.family) in the same browser profile, then open a token page on any supported site.

**Updating from v0.9.8:** overwrite the original folder and click the extension's reload button. The public extension ID is unchanged, so settings are retained. Chrome may ask you to enable the extension or approve its newly added site access. Refresh existing website tabs once to clear legacy listeners. Later reloads reconnect automatically. If automatic opening was previously disabled, that preference stays disabled; use the magnifier or change the setting.

The settings panel controls language, automatic opening, hover preview, brightness, opacity and GitHub update checks. GitHub checks are cached for six hours and can be disabled.

## How Fomo data is read

On Fomo, the extension reads the rendered token page. On GMGN or XXYY, it first looks for an already open matching Fomo page. If none is readable, it opens a temporary inactive Fomo token page using your existing browser login and closes that page after reading. It does not click, scroll or navigate an existing Fomo page.

The extension does **not** extract cookies, login tokens, private keys or seed phrases. Temporary Fomo pages do make the normal network requests of that website. Public narrative, tweet and pool queries send the relevant contract or tweet ID to their providers. There is no developer-operated collection server or telemetry. See [Privacy](PRIVACY.md) for exact access and storage details.

## When data is unavailable

- **No card:** refresh the site, check extension access and the automatic-opening setting, or click the magnifier.
- **Thesis/Holders cannot be read:** open the Fomo link, check login in the same browser profile and wait for the token page to load. Return and press ↻. A loading/login failure is not an empty portfolio.
- **Fewer rows than expected:** Fomo filters and lazy-loaded coverage affect what can be read. `≥` and the loaded/total count make that limit visible.
- **Narrative unavailable:** DeBot may not cover that token, or its service may be unavailable. Narrative recovery is independent of Fomo login.
- **Translated page breaks parsing:** use the site's own language setting or switch browser page translation back to the original. Local card translation is a separate feature.

Fomo data routing currently supports Solana, Ethereum, BSC, Base and Robinhood. Upstream site changes can affect parsing. On 2026-09-05, v0.9.21 also passed live checks on a signed-in GMGN Solana private wallet-monitor list: native token hover, navigation, scrolling, reload and Chinese/English display. Fomo theses, holders and share matched the same token's Fomo card. Coverage still depends on the rows visible on Fomo; an unreadable result is not zero holdings.

## Development

`bash scripts/package.sh` creates the release ZIP in `dist/`. `test/README.md` describes installed-browser acceptance. The public edition does not include custom analysis sources or optional wildcard host permissions.
