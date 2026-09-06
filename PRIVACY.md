# Privacy / 隐私说明

Fomo Lens has no developer-operated collection server, telemetry or extension account. It reads supported token pages and queries the fixed services below. It does not place trades or connect to a wallet.

Fomo Lens 没有开发者自建采集服务器、遥测或扩展账号。它读取支持站点的代币页面，并访问下列固定服务；不会下单或连接钱包。

## Website access / 站点访问

The content script runs on `https://fomo.family/*`, `https://gmgn.ai/*`, `https://pro.xxyy.io/*` and `https://www.xxyy.io/*`.

On Fomo it first reads rendered token data; opening a comment view may additionally request a matching Fomo page as described below. On GMGN and XXYY, a bounded, read-only page probe identifies the hovered token's chain and contract address. For Thesis, Holders and holding share, the extension reads an existing matching Fomo page or opens an inactive temporary token page. Temporary pages use the browser's existing Fomo login, make the normal requests of that website, and are closed after reading. Fomo pauses comments in hidden tabs. The explicit **Read in Fomo, then return** action opens a temporary foreground tab, closes it after reading and returns to its opener. Merely changing the sort does not activate another tab. Existing Fomo pages are not clicked, scrolled or navigated by the reader.

脚本只注入上述精确域名。在 Fomo 优先读取已渲染内容，打开评论视图时也可能按下述方式读取同币页面；在 GMGN / XXYY 用有界只读探针识别悬停代币的链和 CA。观点、持有人和持仓占比读取已有的同币 Fomo 页，或打开临时后台代币页。临时页复用浏览器现有登录，正常向 Fomo 请求页面数据，读完关闭；不会点击、滚动或跳转已有 Fomo 页面。Fomo 会暂停后台标签页的评论，只有点击「打开 Fomo 读取，完成后返回」才会打开前台临时页，读完自动关闭并返回；单纯切换排序不会切走当前页。因此三站取数不能称为“零网络”。

The extension does not extract, store or forward login cookies, session tokens, private keys or seed phrases. It does not have cookie or wallet permissions. Login is completed directly on Fomo, never in this extension.

扩展不提取、存储或外发登录 cookie、会话令牌、私钥或助记词，没有 cookie 或钱包权限。登录在 Fomo 网站上完成。

## Fixed services / 固定服务

| Service | Data and purpose |
| --- | --- |
| `app.debot.ai`, `debot.ai` | Contract address → narrative. Public request without login credentials. / CA 查询叙事，不带登录凭证。 |
| `api.fxtwitter.com` | Tweet ID → source tweet. / 按推文 ID 读取来源正文。 |
| `api.dexscreener.com` | Contract/pool address and chain → token resolution and pool information. / 解析池子与交易对。 |
| `api.github.com` | Latest release for `mickeyhogen/fomo-helper`; no token, wallet or page data is sent. / 检查本项目新版，不发送代币、钱包或网页数据。 |
| `fomo.family` | Token page loads using the browser's existing login when needed. / 必要时用现有登录加载代币页。 |

These providers can observe the requested address or tweet ID, the request time and the browser's network address in their own logs. Choosing a different card tab does not stop the card's other data requests. Disable the extension on a site to stop its activity there. Update checks can be disabled independently in settings and are cached for six hours.

上述提供方可能在自己的日志中看到查询的 CA / 推文 ID、时间和网络地址。切换卡片标签不会停止其它部分取数；若要停止某站点上的扩展活动，请停用该站点访问。更新检查可在设置中单独关闭，缓存六小时。

## Browser storage / 浏览器存储

- `chrome.storage.sync`: language, automatic opening, hover preview and update-check preferences. Chrome may synchronize these settings through its own browser account feature. / 语言、自动弹出、悬停及更新偏好；浏览器可能通过自己的账号同步这些设置。
- `chrome.storage.local`: card/magnifier position, size, appearance and release-check cache. / 卡片及放大镜的位置、尺寸、外观与版本检查缓存。
- `chrome.storage.session` and service-worker memory: bounded caches of public narrative, tweet and pool data. Fomo snapshots are held in service-worker memory for up to 60 seconds. / 叙事、推文、池子数据缓存；Fomo 快照只在后台内存短暂保留，最多 60 秒。

The extension does not write a browsing-history log or upload these settings/snapshots to the developer. Data cached by the browser is removed when its extension storage is cleared or the extension is uninstalled; synchronized settings remain subject to the browser's own sync behavior.

扩展不保存浏览历史日志，也不把设置或 Fomo 快照上传给开发者。清理扩展存储或卸载会清除浏览器中的扩展数据；已同步设置受浏览器自身同步机制管理。

## Permissions / 权限

`storage` stores preferences and short-lived caches. `scripting` reads token identity from the supported sites' page components and reconnects this extension after reload. Host permissions are limited to the exact supported sites and fixed services listed above. There is no `<all_urls>`, no optional wildcard host permission and no custom analysis-source request path.

`storage` 用于设置与短期缓存；`scripting` 用于读取支持站点的代币身份，以及扩展重新加载后重连自己的卡片。站点权限限定于上述域名，没有全站访问、可选通配域名或自定义分析源请求通道。

For questions, open a [GitHub issue](https://github.com/mickeyhogen/fomo-helper/issues). Please do not post cookies, login tokens or private keys.
