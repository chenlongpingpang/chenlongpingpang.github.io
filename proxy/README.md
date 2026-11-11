# 本地代理（proxy/）

开球网小程序客户端对 `/user/lists`（按名字搜人）和 `/user/getgames`（逐场战绩）两个接口加了客户端签名校验，第三方直接调用会返回 `code 102`。

签名算法已逆向：
- 密钥：`e8b7a4e1-06d3-4e0b-95cf-9f0450072389`
- 算法：`sign = md5(密钥 + 毫秒时间戳)`
- 请求时在 query/body 末尾加 `timestamp=<毫秒>&token=<sign>`，同时带小程序 UA 和 Referer

代理已自动为这两个接口加签名，直接透传可用。聚合接口 `/api/player` 走的是按赛事维度重建战绩的方案（`/User/getUserScores` + `/Match/getResult`），数据更全。

## 接口

### `GET /api/player?uid=404523`

一次返回该选手的全部数据（前端只发这一个请求）：

```jsonc
{
  "code": 1,
  "data": {
    "uid": "404523",
    "profile": {          // 来自 /User/adv_profile
      "name": "郭永帅", "score": 1819,
      "yearMaxScore": 1858, "maxScore": 1928,
      "win": 832, "lose": 363, "total": 1195, "rate": "69.6%",
      "province": "天津", "city": "武清", "qiupai": "蝴蝶Butterfly"
    },
    "curve":   [ { "date": "2025-09-27", "score": 1804, "title": "…" } ],   // 积分曲线
    "matches": [ { "date": "2026-10-25", "title": "…", "round": "1/8决赛",
                   "oppUid": "…", "oppName": "云洪祥", "oppRating": 1822,
                   "myScore": 0, "oppScore": 2, "win": false } ],          // 逐场对局
    "tiers":   [ { "label": "1800-1899", "total": 32, "wins": 25,
                   "losses": 7, "winRate": 78.1, "opponents": 27 } ],      // 交手分档
    "stats":   { "matches": 75, "wins": 53, "losses": 22, "winRate": 70.7,
                 "opponents": 67, "events": 38, "careerTotal": 1195 },
    "meta":    { "elapsedMs": 2700, "fromCache": false }
  }
}
```

### 透传接口

| 路径 | 说明 |
|---|---|
| `GET /user/lists?key=名字&page=1` | 按名字搜人（自动签名） |
| `GET /user/getgames?uid=xxx&page=1` | 逐场战绩（自动签名，分页） |
| `GET /enter/detail?id=xxx` | 赛事详情 |

### 性能

- 冷启动：约 2.7 秒（38 个赛事 × `getResult` + 对手资料，服务端并发 14）。
- 命中缓存：0 秒。
- 缓存策略（`proxy/cache/`，已 gitignore）：整份选手数据 6 小时；单个选手资料 3 天。

## 启动

```bash
# 1. 凭据（proxy/.env）
KQ_ACCOUNT=开球网用户名
KQ_PASSWORD=密码
KQ_OPEN_ID=小程序 open_id（从抓包或登录响应拿）

# 2. 代理
node proxy/server.mjs  # http://127.0.0.1:8787

# 3. 前端（frontend/.env.local 已配 VITE_KQ_PROXY_BASE）
cd frontend && npm run dev
```

## 自检

```bash
curl "http://127.0.0.1:8787/api/player?uid=404523"
curl "http://127.0.0.1:8787/user/lists?key=郭永帅"
```

## 已知边界

- 只能覆盖**有积分流水**的赛事，未计分的友谊赛不在内。
- 逐场对局依赖 `getResult` 返回的分组/淘汰赛数据，个别赛事若上游未录入则缺失。
- 对手积分取查询时的最新值，不是交手当时的积分。
