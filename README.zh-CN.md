# Fomo放大镜 (Fomo Helper)

[English](README.md) · **中文**

一个 [fomo.family](https://fomo.family) 的 Chrome 扩展。进任意代币页，一张卡看全叙事（**Meta**）、每个持有人的 thesis（**Thesis**）、头部持仓者（**Holders**）和这只币的副池交易对。零后端，不采集任何数据。

[图文说明](https://hogen.pro/fomo-helper) · [下载](https://github.com/mickeyhogen/fomo-helper/releases/latest) · [隐私说明](PRIVACY.md) · [更新日志](CHANGELOG.md) · [@0xHogen](https://x.com/0xHogen)

![卡片](test/screenshots/01-public-docked.png)

## 使用说明

1. [下载 zip](https://github.com/mickeyhogen/fomo-helper/releases/latest)，解压得到 `fomo-helper/`
2. `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选 `fomo-helper` 文件夹
3. 打开 `fomo.family` 任意代币页，卡片自动弹出

- **Thesis** 页顶可切「按赞」/「最新 ≥2赞」两种排序。
- 鼠标在左栏某行停 0.6 秒可预览该币；`中/EN` 切换卡片语言。
- 拖头部移动；`Esc` 或点卡外关闭；右下角 `🔍` 重新打开。
- 设置（自动弹出、悬停预览、语言）在扩展图标里。
- **更新：**新版解压覆盖同一个文件夹，回扩展页点 ↻。

## 注意事项

- 只在 `fomo.family` 生效；只访问四个固定公开端点（DeBot、FxTwitter、DexScreener 和页面本身），不碰你的 fomo 登录态、cookie、钱包。详见 [PRIVACY.md](PRIVACY.md)。
- Thesis / Holders 读的是 fomo 当前显示的内容。开着 **Friends only** 就只有好友——卡片会明说。
- Holders 表是懒加载的，滚到可见一次卡片会自己补上。
- 「最新」排序需要 fomo 的 thesis 评论流渲染出来——点开过那个 tab 一次即可。
- DeBot 没收录 → 显示"没有叙事"，是数据侧的事实。
- fomo 大改版可能让 Thesis / Holders 退化成灰字提示，欢迎开 issue。

MIT © 2026 [0xHogen](https://x.com/0xHogen) · 设计细节长文：[docs/DETAILS.zh-CN.md](docs/DETAILS.zh-CN.md)
