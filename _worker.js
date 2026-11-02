/**
 * 乒乓助手 · 开球网鉴权代理（Cloudflare Pages / Workers）
 *
 * 背景：开球网（kaiqiuwang.cc）的选手搜索 / 战绩 / 赛事详情接口已收紧鉴权，
 * 无 token 的直接请求返回错误码 102。本代理负责：
 *   1. 静默登录（POST /user/login）换取 token；
 *   2. 携带 token / user_id 转发白名单内的查询请求；
 *   3. token 失效（返回 102）时强制重登重试一次；
 *   4. 其余路径回退到 Pages 静态资源（env.ASSETS），实现"一个站点同时托管前端与代理"。
 *
 * 部署为 Cloudflare Pages：
 *   构建命令：cd frontend && npm ci && npm run build
 *   输出目录：frontend/dist
 *   然后在项目 Settings → Variables 配置环境变量：
 *     KQ_ACCOUNT  开球网登录账号
 *     KQ_PASSWORD 开球网登录密码
 *     KQ_OPEN_ID  开球网 OpenID
 *     KQ_UPSTREAM （可选）上游基址，默认 https://kaiqiuwang.cc/xcx/public/index.php/api
 *   前端构建时设置 VITE_KQ_PROXY_BASE 为 Pages 域名，例如 https://pingpang.pages.dev
 */

const DEFAULT_UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000 // token 内存缓存 30 分钟

// 允许代理转发的开球网 API 路径（白名单，防止代理被滥用）
const ALLOWED_PATHS = ['/user/lists', '/User/getGames', '/enter/detail']

let cachedAuth = null // { token, userId, expiresAt }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, token, user_id',
    'Access-Control-Max-Age': '86400'
  }
}

function jsonResponse(payload, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  })
}

async function login(env) {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  if (!env.KQ_ACCOUNT || !env.KQ_PASSWORD || !env.KQ_OPEN_ID) {
    throw new Error('代理未配置开球网静默登录环境变量（KQ_ACCOUNT / KQ_PASSWORD / KQ_OPEN_ID）')
  }
  const upstream = (env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
  const body = new URLSearchParams()
  body.set('account', env.KQ_ACCOUNT)
  body.set('password', env.KQ_PASSWORD)
  body.set('open_id', env.KQ_OPEN_ID)
  const response = await fetch(`${upstream}/user/login`, {
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
  return cachedAuth
}

function clearAuth() {
  cachedAuth = null
}

async function fetchUpstream(target, method, auth, body) {
  const headers = { Accept: 'application/json' }
  if (auth?.token) headers.token = auth.token
  if (auth?.userId) headers.user_id = auth.userId
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  return fetch(target, { method, headers, body })
}

async function proxyRequest(request, env) {
  const url = new URL(request.url)
  const upstream = (env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
  const target = `${upstream}${url.pathname}${url.search}`

  let auth
  try {
    auth = await login(env)
  } catch (error) {
    return jsonResponse({ code: 0, msg: error.message, data: null }, corsHeaders())
  }

  const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
    ? await request.text().catch(() => '')
    : undefined

  const response = await fetchUpstream(target, request.method, auth, body)
  const data = await response.json().catch(() => ({ code: 0, msg: '上游返回非 JSON 响应', data: null }))

  // token 疑似失效（业务错误 102）：清缓存重登一次再试
  if (data?.code !== 1 && String(data?.msg || '').includes('102')) {
    clearAuth()
    let retryAuth = null
    try {
      retryAuth = await login(env)
    } catch {
      // 重登失败时保留原始响应
    }
    if (retryAuth) {
      const retry = await fetchUpstream(target, request.method, retryAuth, body)
      const retryData = await retry.json().catch(() => ({ code: 0, msg: '上游返回非 JSON 响应', data: null }))
      return jsonResponse(retryData, corsHeaders())
    }
  }

  return jsonResponse(data, corsHeaders())
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    if (ALLOWED_PATHS.some((path) => url.pathname.startsWith(path))) {
      return proxyRequest(request, env)
    }
    // 其余请求回退到 Pages 静态资源（前端 SPA）
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response('Not Found', { status: 404 })
  }
}
