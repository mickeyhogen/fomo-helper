# Browser acceptance

The installed suites load the real Manifest V3 extension in Chromium. Local HTTPS
fixtures replace upstream websites and APIs; content scripts remain isolated and
messages go through the actual extension worker. No live credentials are needed.
The rendering suite additionally exercises UI and translation with transport mocks.

The current Linux harness requires Node.js, OpenSSL, Chromium at
`/usr/bin/chromium`, and Puppeteer Core installed globally under
`/usr/local/lib/node_modules/puppeteer-core`. Adjust those executable/import paths
for another platform. Fixtures are synthetic; bundled Vue/virtual-list modules
retain their upstream MIT notices.

Build and extract the release ZIP first. Set `FOMO_EXTENSION_DIR` to its extracted
`fomo-helper` folder and `FOMO_TEST_OUTPUT` to a separate writable output directory.
Run from the repository root:

```sh
node --test test/message-recovery.test.mjs
node test/run-installed-address-case.mjs
node test/run-installed-recovery.mjs
node test/run-installed-gmgn-smoke.mjs
node test/run-installed-loading-regression.mjs
node test/run-installed-xxyy-layouts.mjs
node test/run-installed-unified-fomo.mjs
node test/run-installed-public-upgrade.mjs
node test/run-site-test.mjs
node test/run-render-test.mjs
```

Use a different output directory for each installed run. For Fomo parity, repeat
with `FOMO_TARGET_SITE=gmgn` and `xxyy`, and `FOMO_UI_LANG` / `FOMO_SITE_LANG` set to
`en` and `zh`. `FOMO_REFERENCE_DIR` can point to a separately accepted Fomo build;
otherwise the native Fomo renderer in the candidate is used as the comparison.
The fixture still independently checks expected shares, row counts, token IDs,
login failures, delayed rendering and tab cleanup.

The public-upgrade suite requires `FOMO_PREVIOUS_EXTENSION_DIR` pointing to the
extracted [v0.9.8 release](https://github.com/mickeyhogen/fomo-helper/releases/tag/v0.9.8).
It upgrades a disposable profile and checks the unchanged extension ID, settings,
permissions, both popup languages, update opt-out and disabled legacy data sources.

Address-case acceptance checks cold default versus the same token's hover, both
XXYY domains, Solana case preservation and rejection of another token's response.
Recovery acceptance injects outages and legacy-context faults. The layout suite
uses real Vue virtual-list behavior for old/new XXYY rows and reused DOM elements.
Website acceptance checks both languages, desktop/mobile layout and safe download
behavior when GitHub is stale, unavailable or returns an unexpected asset URL.

These fixtures do not prove that an upstream site's current live private account
view works. Release acceptance also checks live token pages separately. A visible
card alone is insufficient: narrative and Fomo fields must contain actual content.
