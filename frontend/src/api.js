// 前端通过同域 /api 代理访问开球网，由 Worker/Serverless 自动加 token 和签名
// 这样避免浏览器 CORS 对自定义 header（token）的限制

const API_BASE = '/api'

let cachedAuth = null

export async function fetchUpstream(path, params, signal) {
  const url = new URL(`${API_BASE}${path}`, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    })
  }
  const response = await fetch(url, { signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.code !== 1) {
    throw new Error(data.msg || '接口请求失败，请稍后重试')
  }
  return data
}
