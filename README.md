# 乒乓助手（chenlongpingpang.github.io）

乒乓球选手战绩、年度积分与双方胜率查询的纯前端 SPA（Vue 3 + Vite），数据实时取自开球网（kaiqiuwang.cc）公开接口。

功能：
- **查询选手战绩**：搜索选手 → 个人场次、积分走势、年度积分分析（峰值 / 大败 / 修正）
- **单打交手分档**：按对手当前积分分档查看胜负分布，可导出带样式 Excel
- **双方胜率预测**：当前积分 Elo + 历史交手 + 局分加权的混合模型
- **积分预估计算**：按开球网分差规则逐盘推演积分变化

## ⚠️ 背景：开球网接口鉴权收紧

开球网的选手搜索（`/user/lists`）、战绩（`/User/getGames`）、赛事详情（`/enter/detail`）接口已收紧鉴权：**无 token 的直接请求统一返回错误码 102**（公共接口如城市列表不受影响）。因此纯前端直连已无法查询，需要一层"静默登录 + 携带 token 转发"的代理。

本仓库已内置两套代理实现，任选其一部署即可恢复全部查询功能。

## 部署方案（二选一）

### 方案 A：Cloudflare Pages（推荐，一个站点同时托管前端和代理）

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages，连接本仓库；
2. 构建配置：
   - 构建命令：`cd frontend && npm ci && npm run build`
   - 输出目录：`frontend/dist`
   - 框架预设：None
3. 在项目 Settings → Variables 配置环境变量：

   | 变量 | 说明 |
   |---|---|
   | `KQ_ACCOUNT` | 开球网登录账号 |
   | `KQ_PASSWORD` | 开球网登录密码 |
   | `KQ_OPEN_ID` | 开球网 OpenID |
   | `KQ_UPSTREAM` | 可选，上游基址，默认 `https://kaiqiuwang.cc/xcx/public/index.php/api` |
   | `VITE_KQ_PROXY_BASE` | 前端构建时注入，填你的 Pages 域名，如 `https://pingpang.pages.dev` |

4. 部署完成后，根目录的 `_worker.js` 会自动处理白名单内的开球网请求（登录 → 带 token 转发 → 102 时重登重试），其余请求回退到静态资源。

### 方案 B：Vercel

1. 在 [Vercel](https://vercel.com) Import 本仓库（构建配置见 `vercel.json`）；
2. 在 Project Settings → Environment Variables 配置同样的 `KQ_ACCOUNT` / `KQ_PASSWORD` / `KQ_OPEN_ID`（可选 `KQ_UPSTREAM`）；
3. 构建时设置 `VITE_KQ_PROXY_BASE` 为你的 Vercel 域名（如 `https://pingpang.vercel.app`）；
4. `vercel/api/proxy.js` 会通过 `vercel.json` 的 rewrites 接管 `/user/lists`、`/User/getGames`、`/enter/detail` 请求。

### 保持 GitHub Pages（可选）

仓库仍保留 GitHub Actions 自动部署（`.github/workflows/deploy.yml`）。若继续用 GitHub Pages 托管前端，需要在仓库 Settings → Secrets and variables → Actions 新增仓库变量 `VITE_KQ_PROXY_BASE`（填上面任一个代理地址），构建产物即会优先走代理；不配置则保持直连开球网（会撞 102）。

## 本地开发

```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

可选：在 `frontend/.env.local` 写入 `VITE_KQ_PROXY_BASE=你的代理地址` 进行联调。

## 说明

- 代理仅转发白名单内的三个开球网路径，避免被滥用；
- 账号凭据只作为平台环境变量注入，不写入代码仓库；
- token 在代理进程内缓存 30 分钟，失效（返回 102）时自动重登重试。
