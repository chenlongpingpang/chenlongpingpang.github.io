// 前端托管在 GitHub Pages（chenlongpingpang.github.io），
// API 请求跨域调 Vercel Serverless 后端（自动加 token 和签名）
const API_BASE = 'https://chenlongpingpang-github-io-frontend.vercel.app/api'

export async function fetchUpstream(path, params, signal) {
  const url = new URL(`${API_BASE}${path}`)
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
