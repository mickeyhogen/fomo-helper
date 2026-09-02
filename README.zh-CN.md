# Fomo放大镜 (Fomo Helper)

[English](README.md) · **中文**

一个 [fomo.family](https://fomo.family) 的 Chrome 扩展。进任意代币页，一张卡看全这只币的叙事、每个持有人的 thesis 和头部持仓者——原本要在三个地方来回点的东西。没有后端，不用登录，不收集任何数据。

[图文说明](https://hogen.pro/fomo-helper) · [下载](https://github.com/mickeyhogen/fomo-helper/releases/latest) · [隐私说明](PRIVACY.md) · [更新日志](CHANGELOG.md) · by [@0xHogen](https://x.com/0xHogen)

<table>
<tr>
<td align="center"><b>Meta 叙事</b></td>
<td align="center"><b>Thesis 观点</b></td>
<td align="center"><b>Holders 持仓者</b></td>
</tr>
<tr>
<td><img src="test/screenshots/28-pair-chips.png" width="280" alt="Meta 标签"></td>
<td><img src="test/screenshots/29-thesis-timesort.png" width="280" alt="Thesis 标签"></td>
<td><img src="test/screenshots/14-kol-fixed.png" width="280" alt="Holders 标签"></td>
</tr>
</table>

## 卡片上有什么

- **Meta** —— 叙事起源、评级理由、叙事来源推文、传播路径、开发者（数据来自 DeBot，原样展示）。代币名旁边的小标签（`$HIMS` `$LLY` …）是这只币的**副池交易对**（DexScreener），主池（`$ETH` `$USDC`…）特意不显示。
- **Thesis** —— 每个持有人对*这只币*写的 thesis，带点赞数、持仓和盈亏。可按**赞**（默认）或**最新 ≥2赞**（带发言时间）排序。
- **Holders** —— 头部持仓者：持仓、盈亏、持有时长。
- 头部的 **中/EN** 切换卡片语言；Chrome 自带翻译可用时，英文 thesis 可自动翻成中文。

## 安装

1. [下载 zip](https://github.com/mickeyhogen/fomo-helper/releases/latest)，解压得到 `fomo-helper/` 文件夹
2. 打开 `chrome://extensions`，开启**开发者模式**，点**加载已解压的扩展程序**，选 `fomo-helper` 文件夹
3. 打开 `fomo.family` 任意代币页，卡片自动弹出

**更新：**新版解压覆盖同一个文件夹，回 `chrome://extensions` 在扩展卡片上点 ↻，设置不会丢。

## 怎么用

- 拖头部移动卡片；`Esc` 或点卡外关闭；右下角 `🔍` 重新打开。
- 鼠标在 fomo 左栏某行停 0.6 秒，不离开当前页就能预览那只币。
- 点扩展图标进设置：**自动弹出模式**（精简 / 完整 / 关闭）、**悬停预览**、**默认语言**，改完即时生效。

## 注意事项

- **Friends only**：Thesis 和 Holders 读的是 fomo 当前显示的内容。开着 *Friends only* 就只有好友——卡片为空时会提示。
- Holders 表是懒加载的，滚到可见一次卡片会自己补上。
- 「最新」排序需要 fomo 的 thesis 评论流渲染出来——点开过那个 tab 一次即可。
- 显示"没有叙事"= DeBot 没收录这只币，是数据侧的事实，不是扩展坏了。
- fomo 大改版可能让 Thesis / Holders 退化成灰字提示，欢迎开 issue。

## 隐私

只在 `fomo.family` 生效；只访问四个固定公开端点——DeBot、FxTwitter、DexScreener 和页面本身，别的一概不碰。不读你的 fomo 登录态、cookie、钱包；没有统计，没有追踪。详见 [PRIVACY.md](PRIVACY.md)。

MIT © 2026 [0xHogen](https://x.com/0xHogen) · 设计细节长文：[docs/DETAILS.zh-CN.md](docs/DETAILS.zh-CN.md)
