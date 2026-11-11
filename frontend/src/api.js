import md5 from 'blueimp-md5'

// 直连开球网 API（CORS 已开放），前端自动登录 + 自动签名
const upstreamBase = 'https://kaiqiuwang.cc/xcx/public/index.php/api'
const KQ_ACCOUNT = '拢'
const KQ_PASSWORD = 'longlong'
const KQ_OPEN_ID = 'o9ocC5XXUWJmxYDB3pZUDb2CwW5U'
const SIGN_SECRET = 'e8b7a4e1-06d3-4e0b-95cf-9f0450072389'
const SIGNED_PATHS = ['/user/lists', '/user/getgames']
const WX_UA = 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c3a) NetType/WIFI Language/zh_CN'
const WX_REFERER = 'https://servicewechat.com/wxff09fb0e92aa456a/552/page-frame.html'

let cachedAuth = null

export async function loginKq() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth
  const body = new URLSearchParams({ account: KQ_ACCOUNT, password: KQ_PASSWORD, open_id: KQ_OPEN_ID })
  const res = await fetch(`${upstreamBase}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json().catch(() => ({}))
  const ui = data?.data?.userinfo
  if (data?.code !== 1 || !ui?.token) throw new Error(data?.msg || '开球网登录失败')
  cachedAuth = { token: ui.token, userId: String(ui.user_id || ui.id || ''), expiresAt: Date.now() + 30 * 60 * 1000 }
  return cachedAuth
}

function signRequest() {
  const ts = String(Date.now())
  return { timestamp: ts, token: md5(SIGN_SECRET + ts) }
}

export async function fetchUpstream(path, params, signal) {
  const auth = await loginKq()
  const url = new URL(`${upstreamBase}${path}`)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    })
  }
  const needSign = SIGNED_PATHS.some(p => path.toLowerCase() === p)
  if (needSign) {
    const { timestamp, token } = signRequest()
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('token', token)
  }
  const headers = {
    'Accept': 'application/json',
    'token': auth.token,
    'user_id': auth.userId,
    'XX-Device-Type': 'wxapp',
    'User-Agent': WX_UA,
    'Referer': WX_REFERER
  }
  const response = await fetch(url, { signal, headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.code !== 1) {
    throw new Error(data.msg || '开球网接口请求失败，请稍后重试')
  }
  return data
}
