/**
 * 乒乓助手 · 本地开球网鉴权代理（Node.js 版）
 *
 * 职责：
 *   1. 静默登录（POST /user/login）换取 token，缓存 30 分钟；
 *   2. 透明白名单转发（兼容页面里直接请求上游路径的场景）；
 *   3. 聚合接口 GET /api/player?uid=  ：一次返回选手资料、积分曲线、逐场对局、交手分档。
 *
 * 为什么需要聚合：
 *   /user/lists（按名字搜索）与 /User/getGames（逐场战绩）已被上游加了客户端签名校验，
 *   第三方无法调用；但「按赛事维度查对局」的 /Match/getResult 仍然开放。
 *   因此这里用「积分流水（含 eventid/itemid）→ 逐赛事拉取对局」的方式重建战绩，
 *   全部在服务端并发完成，前端只发一个请求；结果落盘缓存，二次查询秒开。
 *
 * 用法：
 *   1. proxy/.env 填 KQ_ACCOUNT / KQ_PASSWORD；
 *   2. node proxy/server.mjs；
 *   3. frontend/.env.local 里 VITE_KQ_PROXY_BASE=http://127.0.0.1:8787
 */

import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULT_UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000
const BUNDLE_TTL = 6 * 60 * 60 * 1000 // 整份选手数据缓存 6 小时
const PROFILE_TTL = 3 * 24 * 60 * 60 * 1000 // 单个选手资料缓存 3 天（对手积分常用）
const CONCURRENCY = 14
const ALLOWED_PATHS = ['/user/lists', '/User/getGames', '/user/getgames', '/enter/detail']
const PORT = Number(process.env.PORT || 8787)

// 开球网小程序客户端签名密钥（逆向自 client-*.js）
// 算法：sign = md5(SECRET + timestamp_ms)
// 只对 /user/lists 和 /user/getgames 两个接口强制校验
const SIGN_SECRET = 'e8b7a4e1-06d3-4e0b-95cf-9f0450072389'
const SIGNED_PATHS = ['/user/lists', '/user/getgames']
const WX_UA = 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c3a) NetType/WIFI Language/zh_CN'
const WX_REFERER = 'https://servicewechat.com/wxff09fb0e92aa456a/552/page-frame.html'

function signRequest() {
  const ts = String(Date.now())
  const sign = createHash('md5').update(SIGN_SECRET + ts, 'utf8').digest('hex')
  return { timestamp: ts, token: sign }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(here, 'cache')

function loadEnvFile(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 1) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(path.join(here, '.env'))

let cachedAuth = null

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, token, user_id',
  'Access-Control-Max-Age': '86400'
}

function upstreamBase() {
  return (process.env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
}

/* ---------------- 缓存 ---------------- */

function cachePath(kind, key) {
  return path.join(CACHE_DIR, kind, `${String(key).replace(/[^\w-]/g, '_')}.json`)
}

function cacheRead(kind, key, ttl) {
  const file = cachePath(kind, key)
  if (!existsSync(file)) return null
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8'))
    if (!entry?.t || Date.now() - entry.t > ttl) return null
    return entry.v
  } catch {
    return null
  }
}

function cacheWrite(kind, key, value) {
  try {
    const dir = path.join(CACHE_DIR, kind)
    mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath(kind, key), JSON.stringify({ t: Date.now(), v: value }))
  } catch (error) {
    console.warn(`[proxy] 缓存写入失败：${error.message}`)
  }
}

/* ---------------- 上游调用 ---------------- */

async function login() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  const { KQ_ACCOUNT, KQ_PASSWORD, KQ_OPEN_ID } = process.env
  if (!KQ_ACCOUNT || !KQ_PASSWORD) {
    throw new Error('代理未配置开球网登录账号（KQ_ACCOUNT / KQ_PASSWORD）')
  }
  const body = new URLSearchParams({
    account: KQ_ACCOUNT,
    password: KQ_PASSWORD,
    open_id: KQ_OPEN_ID || ''
  })
  const response = await fetch(`${upstreamBase()}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await response.json().catch(() => ({}))
  const userinfo = data?.data?.userinfo
  if (data?.code !== 1 || !userinfo?.token) {
    throw new Error(data?.msg || '开球网静默登录失败')
  }
  cachedAuth = {
    token: userinfo.token,
    userId: String(userinfo.user_id || userinfo.id || ''),
    expiresAt: Date.now() + TOKEN_TTL
  }
  console.log('[proxy] 登录成功，token 已缓存 30 分钟')
  return cachedAuth
}

async function requestUpstream(pathWithQuery, { method = 'GET', body, auth } = {}) {
  // 解析路径（去掉 query），判断是否需要客户端签名
  const pathOnly = pathWithQuery.split('?')[0]
  const needSign = SIGNED_PATHS.some(p => pathOnly.toLowerCase() === p)

  const headers = {
    Accept: 'application/json',
    'XX-Device-Type': 'wxapp',
    'User-Agent': WX_UA,
    Referer: WX_REFERER
  }
  if (auth?.token) headers.token = auth.token
  if (auth?.userId) headers.user_id = auth.userId

  let finalUrl = `${upstreamBase()}${pathWithQuery}`
  let finalBody = body

  if (needSign) {
    const { timestamp, token } = signRequest()
    if (method === 'GET') {
      const sep = pathWithQuery.includes('?') ? '&' : '?'
      finalUrl = `${upstreamBase()}${pathWithQuery}${sep}timestamp=${timestamp}&token=${token}`
    } else {
      // POST body 已经是 urlencoded 字符串
      const suffix = `timestamp=${timestamp}&token=${token}`
      finalBody = body ? `${body}&${suffix}` : suffix
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  const response = await fetch(finalUrl, { method, headers, body: finalBody })
  return response.json().catch(() => ({ code: 0, msg: '上游返回非 JSON 响应', data: null }))
}

/** 带 token 的上游 GET；遇 102（token 失效）自动重登重试一次 */
async function apiGet(pathWithQuery) {
  const auth = await login()
  let data = await requestUpstream(pathWithQuery, { auth })
  if (data?.code !== 1 && String(data?.msg || '').includes('102')) {
    cachedAuth = null
    const retryAuth = await login()
    data = await requestUpstream(pathWithQuery, { auth: retryAuth })
  }
  return data
}

/** 限并发批处理 */
async function pool(items, worker, limit = CONCURRENCY) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        out[index] = await worker(items[index], index)
      } catch {
        out[index] = null
      }
    }
  })
  await Promise.all(runners)
  return out
}

/* ---------------- 数据整形 ---------------- */

function formatDate(raw) {
  const text = String(raw || '').replace(/\D/g, '')
  if (text.length !== 8) return String(raw || '')
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

function scoreOfProfile(profile) {
  const value = Number(profile?.score)
  return Number.isFinite(value) && value > 0 ? value : null
}

async function getProfile(uid) {
  const cached = cacheRead('profiles', uid, PROFILE_TTL)
  if (cached) return cached
  const res = await apiGet(`/User/adv_profile?uid=${uid}`)
  if (res?.code !== 1 || !res.data) return null
  cacheWrite('profiles', uid, res.data)
  return res.data
}

const TIERS = [
  { label: '2000+', min: 2000, max: Infinity },
  { label: '1900-1999', min: 1900, max: 1999 },
  { label: '1800-1899', min: 1800, max: 1899 },
  { label: '1700-1799', min: 1700, max: 1799 },
  { label: '1600-1699', min: 1600, max: 1699 },
  { label: '1500-1599', min: 1500, max: 1599 },
  { label: '1400-1499', min: 1400, max: 1499 },
  { label: '1400 以下', min: -Infinity, max: 1399 },
  { label: '无积分', min: null, max: null }
]

function buildTiers(matches) {
  const buckets = TIERS.map((tier) => ({ ...tier, total: 0, wins: 0, losses: 0, oppUids: new Set() }))
  for (const match of matches) {
    const score = match.oppRating
    let bucket = buckets[buckets.length - 1]
    if (Number.isFinite(score)) {
      bucket = buckets.find((tier) => tier.min !== null && score >= tier.min && score <= tier.max) || bucket
    }
    bucket.total += 1
    bucket.oppUids.add(match.oppUid)
    if (match.win) bucket.wins += 1
    else bucket.losses += 1
  }
  return buckets
    .filter((bucket) => bucket.total > 0)
    .map((bucket) => ({
      label: bucket.label,
      total: bucket.total,
      wins: bucket.wins,
      losses: bucket.losses,
      opponents: bucket.oppUids.size,
      winRate: bucket.total ? Number(((bucket.wins / bucket.total) * 100).toFixed(1)) : 0
    }))
}

async function fetchAllGames(uid) {
  const all = []
  let page = 1
  // 最多翻 50 页保护
  while (page <= 50) {
    const res = await apiGet(`/user/getgames?uid=${uid}&page=${page}`)
    if (res?.code !== 1) break
    const list = Array.isArray(res.data?.data) ? res.data.data : []
    if (!list.length) break
    all.push(...list)
    // 每页 10 条，不足一页说明没了
    if (list.length < 10) break
    page++
  }
  return all
}

async function buildPlayer(uid) {
  const startedAt = Date.now()

  const [profile, scoresRes] = await Promise.all([
    getProfile(uid),
    apiGet(`/User/getUserScores?uid=${uid}`)
  ])

  const events = Array.isArray(scoresRes?.data) ? scoresRes.data : []
  if (!profile && !events.length) {
    return { error: '没有查到该 uid 的数据，请确认 uid 是否正确' }
  }

  const seenEvent = new Set()
  const uniqueEvents = []
  for (const event of events) {
    const key = `${event.eventid}:${event.itemid}`
    if (seenEvent.has(key)) continue
    seenEvent.add(key)
    uniqueEvents.push({
      eventid: String(event.eventid || ''),
      itemid: String(event.itemid || ''),
      date: formatDate(event.dateline),
      rawDate: String(event.dateline || ''),
      score: Number(event.postscore),
      title: event.title || '',
      city: [event.province, event.city].filter(Boolean).join('·'),
      location: event.location || ''
    })
  }

  // 逐赛事拉取对局（14 并发）
  const results = await pool(uniqueEvents, async (event) => {
    if (!event.eventid || !event.itemid) return null
    const res = await apiGet(`/Match/getResult?eventid=${event.eventid}&itemid=${event.itemid}`)
    if (res?.code !== 1) return null
    return res.data?.ttgames?.[event.itemid] || null
  })

  const matches = []
  const seenGame = new Set()
  results.forEach((rounds, index) => {
    const event = uniqueEvents[index]
    if (!Array.isArray(rounds)) return
    for (const round of rounds) {
      const roundName = round?.roundname || ''
      for (const game of round?.games || []) {
        if (!game) continue
        if (String(game.flag) === '1') continue // 轮空
        const isFirst = String(game.uid1) === String(uid)
        const isSecond = String(game.uid2) === String(uid)
        if (!isFirst && !isSecond) continue
        const opponentUid = isFirst ? String(game.uid2) : String(game.uid1)
        if (!opponentUid || opponentUid === '0') continue
        const myScore = Number(String(isFirst ? game.result1 : game.result2).replace(/[^\d]/g, '') || '')
        const oppScoreText = String(isFirst ? game.result2 : game.result1).replace(/[^\d]/g, '')
        if (!Number.isFinite(myScore) || !oppScoreText) continue
        const oppScore = Number(oppScoreText)
        if (!Number.isFinite(oppScore)) continue
        const dedupeKey = [event.eventid, event.itemid, roundName, game.uid1, game.uid2, myScore, oppScore].join('|')
        if (seenGame.has(dedupeKey)) continue
        seenGame.add(dedupeKey)
        matches.push({
          date: event.date,
          rawDate: event.rawDate,
          title: event.title,
          round: roundName,
          oppUid: opponentUid,
          oppName: isFirst ? game.username2 || '' : game.username1 || '',
          myScore,
          oppScore,
          win: myScore > oppScore,
          oppRating: null
        })
      }
    }
  })

  // 补对手积分（用于分档），带缓存
  const opponentUids = [...new Set(matches.map((m) => m.oppUid))]
  const opponentProfiles = await pool(opponentUids, (oppUid) => getProfile(oppUid))
  const scoreMap = new Map()
  opponentUids.forEach((oppUid, index) => {
    scoreMap.set(oppUid, scoreOfProfile(opponentProfiles[index]))
  })
  for (const match of matches) {
    match.oppRating = scoreMap.get(match.oppUid) ?? null
  }

  matches.sort((a, b) => (a.rawDate < b.rawDate ? 1 : a.rawDate > b.rawDate ? -1 : 0))

  const wins = matches.filter((m) => m.win).length
  const losses = matches.length - wins

  const curve = uniqueEvents
    .filter((event) => Number.isFinite(event.score))
    .sort((a, b) => (a.rawDate < b.rawDate ? -1 : a.rawDate > b.rawDate ? 1 : 0))
    .map((event) => ({ date: event.date, score: event.score, title: event.title }))

  return {
    uid: String(uid),
    profile: {
      name: profile?.realname || profile?.username || '',
      nickname: profile?.username || '',
      score: Number.isFinite(Number(profile?.score)) && Number(profile?.score) > 0 ? Number(profile.score) : null,
      maxScore: Number(profile?.maxscore) || null,
      yearMaxScore: Number(profile?.maxScoreTheYear) || null,
      last12MaxScore: Number(profile?.maxscore12month) || null,
      win: Number(profile?.win) || null,
      lose: Number(profile?.lose) || null,
      total: Number(profile?.total) || null,
      rate: Number(profile?.total) > 0 ? ((Number(profile.win) / Number(profile.total)) * 100).toFixed(1) + '%' : '',
      rank: profile?.rank || '',
      province: profile?.province || '',
      city: profile?.city || '',
      age: profile?.age || '',
      sex: profile?.sex || '',
      qiupai: profile?.qiupai || '',
      brand: profile?.brand || ''
    },
    curve,
    matches,
    tiers: buildTiers(matches),
    stats: {
      matches: matches.length,
      wins,
      losses,
      winRate: matches.length ? Number(((wins / matches.length) * 100).toFixed(1)) : 0,
      opponents: opponentUids.length,
      events: uniqueEvents.length,
      careerTotal: Number(profile?.total) || null,
      careerWin: Number(profile?.win) || null,
      careerLose: Number(profile?.lose) || null
    },
    meta: {
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      fromCache: false
    }
  }
}

async function cachedPlayer(uid) {
  const cached = cacheRead('players', uid, BUNDLE_TTL)
  if (cached) {
    return { ...cached, meta: { ...cached.meta, fromCache: true, elapsedMs: 0 } }
  }
  const bundle = await buildPlayer(uid)
  if (bundle && !bundle.error) cacheWrite('players', uid, bundle)
  return bundle
}

/* ---------------- HTTP ---------------- */

function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return undefined
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8') || undefined
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }

  // 聚合接口
  if (url.pathname === '/api/player') {
    const uid = String(url.searchParams.get('uid') || '').replace(/\D/g, '')
    if (!uid) {
      sendJson(res, { code: 0, msg: '缺少 uid 参数', data: null })
      return
    }
    try {
      const bundle = await cachedPlayer(uid)
      if (!bundle) {
        sendJson(res, { code: 0, msg: '查询失败，请稍后重试', data: null })
        return
      }
      if (bundle.error) {
        sendJson(res, { code: 0, msg: bundle.error, data: null })
        return
      }
      console.log(`[proxy] player ${uid} 用时 ${bundle.meta.elapsedMs}ms${bundle.meta.fromCache ? '（缓存）' : ''}`)
      sendJson(res, { code: 1, msg: 'OK', data: bundle })
    } catch (error) {
      sendJson(res, { code: 0, msg: `查询失败：${error.message}`, data: null })
    }
    return
  }

  // 透明转发（保留兼容）
  if (!ALLOWED_PATHS.some((p) => url.pathname.startsWith(p))) {
    sendJson(res, { code: 0, msg: '路径不在代理白名单内', data: null })
    return
  }

  try {
    const auth = await login()
    const body = await readBody(req)
    const target = `${url.pathname}${url.search}`
    const data = await requestUpstream(target, { method: req.method, body, auth })
    sendJson(res, data)
  } catch (error) {
    sendJson(res, { code: 0, msg: `转发失败：${error.message}`, data: null })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] 监听到 http://127.0.0.1:${PORT}`)
  if (!process.env.KQ_ACCOUNT || !process.env.KQ_PASSWORD) {
    console.log('[proxy] 提示：proxy/.env 尚未填写开球网账号密码，查询会返回未配置提示')
  }
})
