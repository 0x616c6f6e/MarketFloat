# 浮窗看盘 · Electron 桌面版

Windows 10 / 11 x64。解压 Windows 压缩包到一个目录，双击里面的 `MarketFloat.exe`。程序已附带 Electron 运行时。

## 操作

- **展开面板**：单击悬浮图标或系统托盘图标。
- **收起为图标**：点击标题栏的缩小图标，或按 Esc。悬浮图标会置顶，可拖动，位置会自动保存。
- **隐藏到托盘**：点击标题栏的「−」，或右键悬浮图标选择「隐藏到托盘」。右键托盘图标可以显示面板、显示悬浮图标、刷新行情和退出。
- **添加自选**：点击「添加」或按 Ctrl+N，选择市场并输入代码，例如 `600519`、`AAPL`、`BTC-USDT` 或 `ETH-USD`。右键标的或点击标的右侧「⋯」可移除。
- **面板设置**：标题栏「⋯」可切换面板置顶、涨跌配色和 15 / 30 / 60 秒刷新。F5 立即刷新。

A 股和美股来自腾讯财经，涨跌幅相对昨收，行情可能延迟。加密货币的 USD 和 USDT 交易对分别使用 [Coinbase](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-stats) 和 [Binance](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)，涨跌幅按 24 小时统计。走势来自本次运行期间的实际取价。网络失败时，已有报价会标为「缓存」。

## 本地开发

前端使用 HTML、CSS 和原生 JavaScript。Electron 主进程负责托盘、窗口、行情请求和本地自选，渲染进程通过 preload 暴露的接口调用这些功能。

安装 Node.js 22.12 或更新版本后，在仓库目录中运行。

```powershell
npm ci
npm start
```

应用代码在 `app/`，打包脚本在 `scripts/`。

## Windows x64 打包

在 Windows PowerShell 或 PowerShell 中，从仓库根目录运行：

```powershell
.\scripts\Pack.ps1
```

脚本根据 `package.json` 下载固定版本的 Electron，按 `scripts/electron-runtime.sha256` 校验下载文件，并在 `dist/` 输出 Windows 便携版 ZIP 和 `SHA256SUMS.txt`。也可用 `-RuntimeZip <路径>` 复用已下载的官方运行时 ZIP。升级 Electron 时，同步更新 `package-lock.json` 和运行时校验文件。

## GitHub Actions

[Windows 打包工作流](.github/workflows/windows.yml)在分支推送、Pull Request、手动触发或版本标签推送时打包。运行成功后，可在 **Actions → 对应运行 → Artifacts** 下载 `MarketFloat-windows-x64`。

推送与 `package.json` 一致的版本标签（如 `v2.0.0`）后，工作流会把 Windows ZIP 和 SHA-256 文件上传到该版本的 **Releases**。工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`。

首次上传时，在 GitHub 创建空仓库，把下面的 `OWNER` 和 `REPO` 替换为实际值，然后在本地仓库目录中运行：

```powershell
git remote add origin https://github.com/OWNER/REPO.git
git push -u origin main
git push origin v2.0.0
```

如果通过 `git clone MarketFloat.bundle` 恢复仓库，使用 `git remote set-url origin https://github.com/OWNER/REPO.git` 替代上面的 `git remote add`。

当前仓库已有本地 `v2.0.0` 标签。如果只需要 CI 构建，推送分支即可。后续发版时，用 `npm version patch` 更新版本并创建新标签，随后推送分支和该标签。
