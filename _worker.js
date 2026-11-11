/**
 * 乒乓助手 · 开球网鉴权代理（Cloudflare Pages / Workers）
 *
 * 前端调 /api/<开球网路径>，Worker 自动：
 *   1. 登录拿 token（内存缓存 30 分钟）
 *   2. 对 /user/lists、/user/getgames 自动加 MD5 签名
 *   3. 带 token / user_id / 微信 UA 转发到开球网
 *
 * 环境变量（Cloudflare Pages → Settings → Variables）：
 *   KQ_ACCOUNT  开球网登录账号
 *   KQ_PASSWORD 开球网登录密码
 *   KQ_OPEN_ID  开球网 OpenID
 */

const UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000
const SIGN_SECRET = 'e8b7a4e1-06d3-4e0b-95cf-9f0450072389'
const SIGNED_PATHS = ['/user/lists', '/user/getgames']
const WX_UA = 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c3a) NetType/WIFI Language/zh_CN'
const WX_REFERER = 'https://servicewechat.com/wxff09fb0e92aa456a/552/page-frame.html'

let cachedAuth = null

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  }
}

function json(data, extra) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra }
  })
}

async function md5hex(s) {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function login(env) {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  if (!env.KQ_ACCOUNT) throw new Error('未配置 KQ_ACCOUNT')
  const body = new URLSearchParams({
    account: env.KQ_ACCOUNT,
    password: env.KQ_PASSWORD,
    open_id: env.KQ_OPEN_ID
  })
  const r = await fetch(`${UPSTREAM}/user/login`, {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() })
    }

    // 只代理 /api/* 路径
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return new Response('Not Found', { status: 404 })
    }

    // 去掉 /api 前缀
    const kqPath = url.pathname.replace(/^\/api/, '')
    const needSign = SIGNED_PATHS.some(p => kqPath.toLowerCase() === p)

    let auth
    try {
      auth = await login(env)
    } catch (e) {
      return json({ code: 0, msg: e.message, data: null }, cors())
    }

    // 构造上游 URL
    let target = `${UPSTREAM}${kqPath}${url.search}`
    const headers = {
      'Accept': 'application/json',
      'token': auth.token,
      'user_id': auth.userId,
      'XX-Device-Type': 'wxapp',
      'User-Agent': WX_UA,
      'Referer': WX_REFERER
    }

    const isPost = request.method === 'POST'
    let body = null
    if (isPost) {
      body = await request.text().catch(() => '')
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }

    // 加签名
    if (needSign) {
      const ts = String(Date.now())
      const sign = await md5hex(SIGN_SECRET + ts)
      if (isPost) {
        body = body ? `${body}&timestamp=${ts}&token=${sign}` : `timestamp=${ts}&token=${sign}`
      } else {
        target += (url.search ? '&' : '?') + `timestamp=${ts}&token=${sign}`
      }
    }

    const resp = await fetch(target, { method: request.method, headers, body })
    const data = await resp.json().catch(() => ({ code: 0, msg: '上游返回非 JSON', data: null }))

    // 102 重登重试
    if (data?.code !== 1 && String(data?.msg || '').includes('102')) {
      cachedAuth = null
      try {
        auth = await login(env)
        headers.token = auth.token
        headers.user_id = auth.userId
        const retry = await fetch(target, { method: request.method, headers, body })
        const retryData = await retry.json().catch(() => ({}))
        return json(retryData, cors())
      } catch {}
    }

    return json(data, cors())
  }
}
