/**
 * 乒乓助手 · 开球网鉴权代理（Vercel Serverless Function）
 *
 * 前端调 /api/<开球网路径>，本函数自动：
 *   1. 登录拿 token（内存缓存 30 分钟）
 *   2. 对 /user/lists、/user/getgames 自动加 MD5 签名
 *   3. 带 token / user_id / 微信 UA 转发到开球网
 *
 * 环境变量（Vercel Project Settings → Environment Variables）：
 *   KQ_ACCOUNT  开球网登录账号
 *   KQ_PASSWORD 开球网登录密码
 *   KQ_OPEN_ID  开球网 OpenID
 */

import crypto from 'crypto'

const DEFAULT_UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000
const SIGN_SECRET = 'e8b7a4e1-06d3-4e0b-95cf-9f0450072389'
const SIGNED_PATHS = ['/user/lists', '/user/getgames']
const WX_UA = 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c3a) NetType/WIFI Language/zh_CN'
const WX_REFERER = 'https://servicewechat.com/wxff09fb0e92aa456a/552/page-frame.html'

let cachedAuth = null

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

async function login() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  if (!process.env.KQ_ACCOUNT) throw new Error('未配置 KQ_ACCOUNT')
  const upstream = (process.env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
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
  // 去掉 /api 前缀
  const kqPath = url.pathname.replace(/^\/api/, '')
  const needSign = SIGNED_PATHS.some(p => kqPath.toLowerCase() === p)

  let auth
  try {
    auth = await login()
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).json({ code: 0, msg: e.message, data: null })
    return
  }

  const upstream = DEFAULT_UPSTREAM
  let target = `${upstream}${kqPath}${url.search}`
  const headers = {
    'Accept': 'application/json',
    'token': auth.token,
    'user_id': auth.userId,
    'XX-Device-Type': 'wxapp',
    'User-Agent': WX_UA,
    'Referer': WX_REFERER
  }

  let body = null
  if (req.method === 'POST') {
    body = await new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => resolve(raw || null))
    })
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  // 加签名
  if (needSign) {
    const ts = String(Date.now())
    const sign = md5(SIGN_SECRET + ts)
    if (req.method === 'POST' && body) {
      body = `${body}&timestamp=${ts}&token=${sign}`
    } else {
      target += (url.search ? '&' : '?') + `timestamp=${ts}&token=${sign}`
    }
  }

  const resp = await fetch(target, { method: req.method, headers, body })
  const data = await resp.json().catch(() => ({ code: 0, msg: '上游返回非 JSON', data: null }))

  // 102 重登重试
  if (data?.code !== 1 && String(data?.msg || '').includes('102')) {
    cachedAuth = null
    try {
      auth = await login()
      headers.token = auth.token
      headers.user_id = auth.userId
      const retry = await fetch(target, { method: req.method, headers, body })
      const retryData = await retry.json().catch(() => ({}))
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.status(200).json(retryData)
      return
    } catch {}
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json(data)
}
