# 个人跨市场资产工作台

移动端资产看板与 Node.js 实时数据服务，覆盖支付宝基金、BIT 美股账户、币安资产、美股指数和 USD/CNY。

## 云端部署

运行环境：Node.js 18+

```bash
npm install
npm start
```

服务使用平台提供的 `PORT` 环境变量，默认端口为 3458。

## 必填环境变量

```text
BIT_ACCESS_KEY=
BIT_SECRET_KEY=
BINANCE_API_KEY=
BINANCE_SECRET_KEY=
```

可选：当托管网络需要代理时，设置 `HTTPS_PROXY` 或 `HTTP_PROXY`。不要设置本机 `127.0.0.1` 代理地址到云端。

## 数据刷新

- 启动后无缓存时立即刷新一次。
- 服务每 15 分钟自动刷新一次。
- `POST /api/refresh` 可手动刷新。
- `GET /api/live-data` 返回带 `dataVersion` 的最新数据，并禁止响应缓存。
- 指数和汇率优先使用可选 `westock-data`，云端自动回退腾讯公开行情接口；无需 WorkBuddy 本机路径。

## API

- `GET /api/status`
- `GET /api/live-data`
- `POST /api/refresh`

## 安全

`.env` 与 `data/keys.json` 已加入 `.gitignore`。密钥只在托管平台的环境变量设置中配置，不能提交到仓库。
