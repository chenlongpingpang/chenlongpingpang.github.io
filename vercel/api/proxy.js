/**
 * 乒乓助手 · 开球网鉴权代理（Vercel Serverless Function）
 *
 * 与仓库根目录 _worker.js（Cloudflare 版）逻辑一致：静默登录换取 token，
 * 携带 token / user_id 转发白名单内的查询请求，102 时强制重登重试一次。
 *
 * 部署为 Vercel：
 *   1. 导入本仓库，框架预设选择 Other（构建命令见 vercel.json）；
 *   2. 在 Project Settings → Environment Variables 配置：
 *        KQ_ACCOUNT  开球网登录账号
 *        KQ_PASSWORD 开球网登录密码
 *        KQ_OPEN_ID  开球网 OpenID
 *        KQ_UPSTREAM （可选）上游基址，默认 https://kaiqiuwang.cc/xcx/public/index.php/api
 *   3. 构建时设置 VITE_KQ_PROXY_BASE 为你的 Vercel 域名（如 https://pingpang.vercel.app），
 *      前端会优先走本代理。
 */

const DEFAULT_UPSTREAM = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const TOKEN_TTL = 30 * 60 * 1000

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

function jsonResponse(res, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  Object.entries(corsHeaders()).forEach(([key, value]) => res.setHeader(key, value))
  res.status(200).json(payload)
}

async function login() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  if (!process.env.KQ_ACCOUNT || !process.env.KQ_PASSWORD || !process.env.KQ_OPEN_ID) {
    throw new Error('代理未配置开球网静默登录环境变量（KQ_ACCOUNT / KQ_PASSWORD / KQ_OPEN_ID）')
  }
  const upstream = (process.env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
  const body = new URLSearchParams()
  body.set('account', process.env.KQ_ACCOUNT)
  body.set('password', process.env.KQ_PASSWORD)
  body.set('open_id', process.env.KQ_OPEN_ID)
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, token, user_id')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.status(204).end()
    return
  }

  const url = new URL(req.url, 'http://local')
  const path = url.pathname
  if (!ALLOWED_PATHS.some((allowed) => path.startsWith(allowed))) {
    jsonResponse(res, { code: 0, msg: '路径不在代理白名单内', data: null })
    return
  }

  const upstream = (process.env.KQ_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '')
  const target = `${upstream}${path}${url.search}`

  let auth
  try {
    auth = await login()
  } catch (error) {
    jsonResponse(res, { code: 0, msg: error.message, data: null })
    return
  }

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
    ? await new Promise((resolve) => {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => resolve(raw || undefined))
      })
    : undefined

  const response = await fetchUpstream(target, req.method, auth, body)
  const data = await response.json().catch(() => ({ code: 0, msg: '上游返回非 JSON 响应', data: null }))

  if (data?.code !== 1 && String(data?.msg || '').includes('102')) {
    clearAuth()
    let retryAuth = null
    try {
      retryAuth = await login()
    } catch {
      // 重登失败时保留原始响应
    }
    if (retryAuth) {
      const retry = await fetchUpstream(target, req.method, retryAuth, body)
      const retryData = await retry.json().catch(() => ({ code: 0, msg: '上游返回非 JSON 响应', data: null }))
      jsonResponse(res, retryData)
      return
    }
  }

  jsonResponse(res, data)
}
