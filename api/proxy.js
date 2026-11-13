/**
 * 乒乓助手 · 开球网聚合代理（Vercel Serverless Function）
 *
 * 路由：
 *   GET  /api/player?uid=xxx   聚合返回选手资料 / 积分曲线 / 全部对局 / 统计
 *   GET  /api/<开球网路径>      透传（自动登录、签名、带微信 header）
 *
 * 聚合策略：
 *   - adv_profile  拿选手资料（已纳入签名）
 *   - getUserScores 拿积分流水（积分曲线 + 赛事标题）
 *   - user/getgames 全量翻页拿全部逐场对局（含失败页重试）
 *
 * 环境变量（Vercel Project Settings → Environment Variables）：
 *   KQ_ACCOUNT  开球网登录账号
 *   KQ_PASSWORD 开球网登录密码
 *   KQ_OPEN_ID  开球网 OpenID
 */

import crypto from 'crypto'

const DEFAULT_UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000
const CONCURRENCY = 18
const MAX_GAME_PAGE = 150
const SIGN_SECRET = 'e8b7a4e1-06d3-4e0b-95cf-9f0450072389'
const SIGNED_PATHS = ['/user/lists', '/user/getgames', '/user/adv_profile']
const WX_UA = 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c3a) NetType/WIFI Language/zh_CN'
const WX_REFERER = 'https://servicewechat.com/wxff09fb0e92aa456a/552/page-frame.html'

let cachedAuth = null

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function login() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  if (!process.env.KQ_ACCOUNT) throw new Error('未配置 KQ_ACCOUNT')
  const upstream = DEFAULT_UPSTREAM.replace(/\/$/, '')
  const body = new URLSearchParams({
    account: process.env.KQ_ACCOUNT,
    password: process.env.KQ_PASSWORD,
    open_id: process.env.KQ_OPEN_ID
  })
  const r = await fetch(`${upstream}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await r.json().catch(() => ({}))
  const ui = data?.data?.userinfo
  if (data?.code !== 1 || !ui?.token) throw new Error(data?.msg || '开球网登录失败')
  cachedAuth = { token: ui.token, userId: String(ui.user_id || ui.id || ''), expiresAt: Date.now() + TOKEN_TTL }
  return cachedAuth
}

async function requestUpstream(pathWithQuery, { method = 'GET', body, auth } = {}) {
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

  let finalUrl = `${DEFAULT_UPSTREAM}${pathWithQuery}`
  let finalBody = body

  if (needSign) {
    const ts = String(Date.now())
    const sign = md5(SIGN_SECRET + ts)
    if (method === 'GET') {
      const sep = pathWithQuery.includes('?') ? '&' : '?'
      finalUrl = `${finalUrl}${sep}timestamp=${ts}&token=${sign}`
    } else {
      const suffix = `timestamp=${ts}&token=${sign}`
      finalBody = body ? `${body}&${suffix}` : suffix
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  const resp = await fetch(finalUrl, { method, headers, body: finalBody })
  return resp.json().catch(() => ({ code: 0, msg: '上游返回非 JSON', data: null }))
}

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

async function pool(items, worker, limit = CONCURRENCY) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try { out[index] = await worker(items[index], index) } catch { out[index] = null }
    }
  })
  await Promise.all(runners)
  return out
}

function formatDate(raw) {
  const text = String(raw || '').replace(/\D/g, '')
  if (text.length !== 8) return String(raw || '')
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

/* ---------------- 聚合：选手整包 ---------------- */

async function getProfile(uid) {
  const res = await apiGet(`/User/adv_profile?uid=${uid}`)
  if (res?.code !== 1 || !res.data) return null
  return res.data
}

/** 拉取单页逐场战绩；code!==1 视为失败（可重试），空数组表示已到底 */
async function fetchGamesPage(uid, page) {
  const res = await apiGet(`/user/getgames?uid=${uid}&page=${page}`)
  if (res?.code !== 1) return null
  return Array.isArray(res?.data?.data) ? res.data.data : []
}

/** 全量翻页，失败页两轮重试；解析为标准对局数组 */
async function fetchAllGames(uid, titleMap) {
  const failed = []
  const all = []
  let cursor = 1

  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const page = cursor++
      if (page > MAX_GAME_PAGE) return
      let rows = null
      for (let attempt = 0; attempt < 2; attempt++) {
        rows = await fetchGamesPage(uid, page)
        if (rows !== null) break
        await sleep(300 * (attempt + 1))
      }
      if (rows === null) { failed.push(page); continue }
      if (rows.length) all.push(...rows)
    }
  })
  await Promise.all(runners)

  // 失败页二次小并发重试
  if (failed.length) {
    const retryOut = await pool(failed, async (page) => {
      let rows = null
      for (let attempt = 0; attempt < 2; attempt++) {
        rows = await fetchGamesPage(uid, page)
        if (rows !== null) break
        await sleep(300)
      }
      return rows || []
    }, 6)
    retryOut.forEach((rows) => rows && all.push(...rows))
  }

  const matches = []
  const seenGame = new Set()
  let selfName = ''
  for (const g of all) {
    if (!g || String(g.flag) === '1') continue
    const isFirst = String(g.uid1) === String(uid)
    const isSecond = String(g.uid2) === String(uid)
    if (!isFirst && !isSecond) continue
    const oppUid = isFirst ? String(g.uid2) : String(g.uid1)
    if (!oppUid || oppUid === '0') continue
    const myName = isFirst ? g.username1 : g.username2
    if (!selfName && myName) selfName = myName
    const myScore = Number(String(isFirst ? g.result1 : g.result2).replace(/[^\d]/g, '') || '')
    const oppScoreText = String(isFirst ? g.result2 : g.result1).replace(/[^\d]/g, '')
    if (!Number.isFinite(myScore) || !oppScoreText) continue
    const oppScore = Number(oppScoreText)
    if (!Number.isFinite(oppScore)) continue
    const dedupeKey = [g.gameid, g.uid1, g.uid2, myScore, oppScore].join('|')
    if (seenGame.has(dedupeKey)) continue
    seenGame.add(dedupeKey)
    const rawDate = String(g.dateline || '')
    matches.push({
      date: formatDate(rawDate),
      rawDate,
      title: titleMap.get(String(g.eventid || '')) || '',
      round: '',
      oppUid,
      oppName: isFirst ? g.username2 || '' : g.username1 || '',
      myScore,
      oppScore,
      win: myScore > oppScore,
      oppRating: null
    })
  }

  matches.sort((a, b) => (a.rawDate < b.rawDate ? 1 : a.rawDate > b.rawDate ? -1 : 0))
  return { matches, selfName }
}

async function buildPlayer(uid) {
  const startedAt = Date.now()

  const [profile, scoresRes] = await Promise.all([
    getProfile(uid).catch(() => null),
    apiGet(`/User/getUserScores?uid=${uid}`)
  ])

  const events = Array.isArray(scoresRes?.data) ? scoresRes.data : []
  if (!profile && !events.length) {
    return { error: '没有查到该 uid 的数据，请确认 uid 是否正确' }
  }

  const seenEvent = new Set()
  const uniqueEvents = []
  const titleMap = new Map()
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
      title: event.title || ''
    })
    if (event.eventid) titleMap.set(String(event.eventid), event.title || '')
  }

  const { matches, selfName: gamesSelfName } = await fetchAllGames(uid, titleMap)

  const wins = matches.filter((m) => m.win).length
  const losses = matches.length - wins
  const opponentUids = [...new Set(matches.map((m) => m.oppUid))]

  const curve = uniqueEvents
    .filter((event) => Number.isFinite(event.score))
    .sort((a, b) => (a.rawDate < b.rawDate ? -1 : a.rawDate > b.rawDate ? 1 : 0))
    .map((event) => ({ date: event.date, score: event.score, title: event.title }))

  const scoreOf = (p) => {
    const v = Number(p?.score)
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const latestScore = curve.length ? curve[curve.length - 1].score : null
  const selfName = profile?.realname || profile?.username || gamesSelfName || ''

  return {
    uid: String(uid),
    profile: {
      name: profile?.realname || profile?.username || gamesSelfName || '',
      nickname: profile?.username || gamesSelfName || '',
      score: scoreOf(profile) ?? latestScore,
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
    meta: { generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, fromCache: false }
  }
}

/* ---------------- HTTP ---------------- */

function sendJson(res, payload, status = 200) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(status).json(payload)
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.status(204).end()
    return
  }

  const url = new URL(req.url, 'http://local')
  const kqPath = url.pathname.replace(/^\/api/, '')

  // 聚合接口
  if (kqPath === '/player') {
    const uid = String(url.searchParams.get('uid') || '').replace(/\D/g, '')
    if (!uid) return sendJson(res, { code: 0, msg: '缺少 uid 参数', data: null })
    try {
      const bundle = await buildPlayer(uid)
      if (bundle.error) return sendJson(res, { code: 0, msg: bundle.error, data: null })
      return sendJson(res, { code: 1, msg: 'OK', data: bundle })
    } catch (error) {
      return sendJson(res, { code: 0, msg: `查询失败：${error.message}`, data: null })
    }
  }

  // 透传（搜索 / 逐场战绩等）
  let auth
  try {
    auth = await login()
  } catch (e) {
    return sendJson(res, { code: 0, msg: e.message, data: null })
  }

  let body = null
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    body = await new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => resolve(raw || null))
    })
  }

  const data = await requestUpstream(kqPath + url.search, { method: req.method, body, auth })
  sendJson(res, data)
}
