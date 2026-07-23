# 乒乓龙 · 用户交手战绩查询

一个使用 Vue 3 + Vite 构建的纯静态查询页面。输入选手姓名或昵称，选择正确用户后，浏览器会直接读取开球网公开接口，逐页汇总该用户的比赛记录。

## 环境要求

- Node.js 18+
- npm 9+

## 启动

```bash
cd frontend
npm install
npm run dev
```

浏览器访问 <http://localhost:5173>。

## 配置

页面默认访问公开接口 `https://kaiqiuwang.cc/xcx/public/index.php/api`。如需覆盖，可在构建时设置 `VITE_KQ_BASE_URL`。

## 构建静态文件

```bash
cd frontend
npm run build
```

构建结果位于 `frontend/dist`，可直接部署到任意静态网站托管服务。页面运行时需要联网读取开球网数据。

## GitHub Pages

项目已包含 `.github/workflows/deploy.yml`。推送到 GitHub 的 `main` 分支后：

1. 打开仓库的 `Settings → Pages`
2. 将 `Build and deployment → Source` 设置为 `GitHub Actions`
3. 等待 `Actions` 中的部署任务完成

之后每次推送到 `main` 分支都会自动重新构建并发布。
