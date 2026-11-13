<!-- 选手详情（合并版）：输入 uid → 资料 / 积分曲线 / 交手分档 / 交手记录 -->
<template>
  <div class="pv">
    <section class="pv-hero">
      <h1>乒乓助手</h1>
      <p class="pv-sub">输入 uid，查看积分曲线与交手记录</p>
      <form class="pv-search" @submit.prevent="query">
        <input
          v-model="uidInput"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          placeholder="uid 或选手主页链接，如 404523"
          :disabled="loading"
        >
        <button :disabled="loading">{{ loading ? '查询中' : '查询' }}</button>
      </form>
      <p class="pv-tip">uid 可在官方 App 选手资料页看到；首次查询约 5-10 秒，之后走本地缓存秒开</p>
      <p v-if="error" class="pv-error">{{ error }}</p>
    </section>

    <section v-if="loading" class="loading-card pv-loading">
      <span class="ball"></span>
      <div>
        <strong>正在拉取选手数据</strong>
        <p>{{ loadingText }}</p>
      </div>
    </section>

    <template v-if="bundle">
      <section class="pv-profile">
        <div class="pv-avatar">
          <span>{{ (profile.name || '?').slice(0, 1) }}</span>
          <img :src="avatarUrl(bundle.uid)" alt="" @error="$event.currentTarget.style.display = 'none'">
        </div>
        <h2>{{ profile.name || `用户 ${bundle.uid}` }}<small v-if="profile.nickname && profile.nickname !== profile.name">{{ profile.nickname }}</small></h2>
        <p class="pv-meta">
          ID {{ bundle.uid }}
          <span v-if="region"> · {{ region }}</span>
          <span v-if="profile.qiupai"> · {{ profile.qiupai }}</span>
        </p>
        <div class="score-overview">
          <div><span>当前积分</span><strong>{{ show(profile.score) }}</strong></div>
          <div><span>年度最高</span><strong>{{ show(profile.yearMaxScore) }}</strong></div>
          <div><span>历史最高</span><strong>{{ show(profile.maxScore) }}</strong></div>
        </div>
        <p v-if="profile.total" class="pv-career">生涯 {{ profile.total }} 场 · {{ profile.win }} 胜 {{ profile.lose }} 负 {{ profile.rate ? `· 胜率 ${profile.rate}` : '' }}</p>
      </section>

      <section class="pv-stats">
        <div><span>收录场次</span><b>{{ stats.matches }}</b></div>
        <div><span>胜</span><b class="up">{{ stats.wins }}</b></div>
        <div><span>负</span><b class="down">{{ stats.losses }}</b></div>
        <div><span>胜率</span><b>{{ stats.winRate }}%</b></div>
        <div><span>对手</span><b>{{ stats.opponents }}</b></div>
        <div><span>赛事</span><b>{{ stats.events }}</b></div>
      </section>

      <section v-if="chart" class="score-trend">
        <div class="trend-heading">
          <h3>{{ selfName }}单打积分趋势</h3>
          <span>{{ curve.length }} 个赛点</span>
        </div>
        <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" aria-label="积分趋势">
          <g class="trend-grid">
            <g v-for="tick in chart.yTicks" :key="tick.value">
              <line :x1="chart.left" :x2="chart.width - chart.right" :y1="tick.y" :y2="tick.y" />
              <text :x="chart.left - 6" :y="tick.y + 3" text-anchor="end">{{ tick.value }}</text>
            </g>
          </g>
          <path class="trend-line" :d="chart.path" />
          <g class="trend-mark">
            <circle v-for="(point, index) in chart.points" :key="index" :cx="point.x" :cy="point.y" :r="index === chart.points.length - 1 ? 3.6 : 2.2" />
          </g>
          <g class="trend-dates">
            <text :x="chart.left" :y="chart.height - 8" text-anchor="start">{{ chart.firstLabel }}</text>
            <text :x="chart.width - chart.right" :y="chart.height - 8" text-anchor="end">{{ chart.lastLabel }}</text>
          </g>
        </svg>
      </section>

      <section v-if="matches.length" class="tier-results">
        <div class="section-head">
          <h2>单打交手分档</h2>
          <span>按对手当前实时积分分档</span>
        </div>
        <div class="tier-toolbar">
          <span>共 {{ stats.opponents }} 位对手</span>
          <button type="button" @click="downloadTierExcel">下载 Excel</button>
        </div>
        <div class="tier-legend"><span class="red">从未战胜</span><span class="yellow">胜率≤50%</span><span class="green">胜率&gt;50%</span></div>
        <div v-for="band in tierBands" :key="band.label" class="tier-band">
          <div class="tier-band-title"><strong>{{ band.label }}</strong><span>{{ band.opponents.length }} 人</span></div>
          <div v-if="band.opponents.length" class="tier-opponents">
            <span v-for="opponent in band.opponents" :key="opponent.uid" :class="['tier-opponent', tierColor(opponent)]">
              {{ opponent.name }}（{{ opponent.score || '未知' }}） <b>{{ opponent.wins }}/{{ opponent.losses }}</b>
            </span>
          </div>
          <div v-else class="tier-empty">—</div>
        </div>
      </section>

      <section class="records">
        <div class="section-head">
          <h2>交手记录</h2>
          <span>共 {{ matches.length }} 场</span>
        </div>

        <div v-if="visibleMatches.length" class="table-wrap">
          <table>
            <thead><tr><th style="width: 10%">序号</th><th style="width: 20%">我方</th><th style="width: 28%">敌方</th><th style="width: 16%">比分</th><th style="width: 26%">日期</th></tr></thead>
            <tbody>
              <tr v-for="(match, index) in visibleMatches" :key="`${match.date}-${match.oppUid}-${index}`">
                <td>{{ (page - 1) * pageSize + index + 1 }}</td>
                <td>{{ selfName }}</td>
                <td><strong>{{ match.oppName || `用户 ${match.oppUid}` }}</strong></td>
                <td><strong class="score">{{ match.myScore }}:{{ match.oppScore }}</strong></td>
                <td>{{ match.date || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">该选手暂无有积分记录的赛事对局</div>

        <div v-if="totalPages > 1" class="pager">
          <button :disabled="page === 1" @click="changePage(page - 1)">上一页</button>
          <span>{{ page }} / {{ totalPages }}</span>
          <button :disabled="page === totalPages" @click="changePage(page + 1)">下一页</button>
        </div>
      </section>

      <p class="pv-note">
        数据来自开球网积分赛记录：{{ stats.events }} 场赛事<span v-if="coverage">（{{ coverage }}）</span>、{{ matches.length }} 场对局，
        不含未计分的友谊赛、双打和团体赛；对手积分取自查询时的最新值。
        <span v-if="bundle.meta.fromCache">本页来自本地缓存。</span>
      </p>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { fetchUpstream } from './api.js'

const uidInput = ref('')
const loading = ref(false)
const loadingText = ref('正在登录并读取积分流水…')
const error = ref('')
const bundle = ref(null)
const page = ref(1)
const pageSize = 20

const profile = computed(() => bundle.value?.profile || {})
const stats = computed(() => bundle.value?.stats || {})
const curve = computed(() => bundle.value?.curve || [])
const matches = computed(() => bundle.value?.matches || [])
const selfName = computed(() => profile.value.name || `用户 ${bundle.value?.uid || ''}`)
const coverage = computed(() => {
  const points = curve.value
  if (!points.length) return ''
  return `${points[0].date} ~ ${points[points.length - 1].date}`
})

const region = computed(() => {
  const value = [profile.value.province, profile.value.city].filter(Boolean).join(' ')
  return value && value !== '0' ? value : ''
})

const totalPages = computed(() => Math.max(1, Math.ceil(matches.value.length / pageSize)))
const visibleMatches = computed(() => {
  const start = (page.value - 1) * pageSize
  return matches.value.slice(start, start + pageSize)
})

function show(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : '-'
}

function avatarUrl(userId) {
  const padded = String(userId || '').padStart(8, '0')
  return `https://oss.kaiqiu.cc/avatar/000/${padded.slice(2, 4)}/${padded.slice(4, 6)}/${padded.slice(6, 8)}_avatar_big.jpg`
}

function parseUid(value) {
  const text = String(value || '')
  const match = text.match(/[?&]uid=(\d+)/i) || text.match(/(\d{3,})/)
  return match ? match[1] : ''
}

function changePage(next) {
  page.value = Math.min(totalPages.value, Math.max(1, next))
  document.querySelector('.records')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* ---------- 分档：50 分一档，列出每位对手及其胜负 ---------- */

const tierBands = computed(() => {
  const bands = [{ label: '2000以上', min: 2000, max: Infinity }]
  for (let upper = 2000; upper > 600; upper -= 50) {
    bands.push({ label: `${upper - 50}-${upper}`, min: upper - 50, max: upper })
  }
  bands.push({ label: '600以下', min: -Infinity, max: 600 })
  bands.push({ label: '实时积分未知', min: null, max: null })

  const byOpponent = new Map()
  for (const match of matches.value) {
    const entry = byOpponent.get(match.oppUid) || {
      uid: match.oppUid,
      name: match.oppName || `用户 ${match.oppUid}`,
      score: null,
      wins: 0,
      losses: 0,
      games: 0
    }
    entry.games += 1
    if (match.win) entry.wins += 1
    else entry.losses += 1
    if (Number(match.oppRating) > 0) entry.score = Number(match.oppRating)
    byOpponent.set(match.oppUid, entry)
  }

  return bands.map((band) => {
    const opponents = [...byOpponent.values()].filter((opponent) => {
      if (band.min === null) return !opponent.score
      if (!opponent.score) return false
      return opponent.score >= band.min && opponent.score <= band.max
    })
    opponents.sort((a, b) => b.games - a.games || (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name, 'zh-CN'))
    return { ...band, opponents }
  })
})

function tierWinRate(opponent) {
  const decided = opponent.wins + opponent.losses
  return decided ? opponent.wins / decided : 0
}

function tierColor(opponent) {
  if (!opponent.wins) return 'red'
  return tierWinRate(opponent) <= 0.5 ? 'yellow' : 'green'
}

async function downloadTierExcel() {
  if (!matches.value.length) return
  try {
    const module = await import('xlsx-js-style')
    const XLSX = module.default || module
    const groups = tierBands.value
    const maxItems = Math.max(...groups.map((group) => group.opponents.length), 1)
    const rows = groups.map((group) => [
      group.label,
      ...group.opponents.map((opponent) => `${opponent.name}（${opponent.score || '未知'}） ${opponent.wins}/${opponent.losses}`),
      ...Array(Math.max(0, maxItems - group.opponents.length)).fill('')
    ])
    const sheet = XLSX.utils.aoa_to_sheet([
      ['积分段', ...Array.from({ length: maxItems }, (_, index) => `对手${index + 1}`)],
      ...rows
    ])
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, '交手分档')
    XLSX.writeFile(book, `${selfName.value}-交手分档.xlsx`)
  } catch (err) {
    error.value = `导出失败：${err.message}`
  }
}

/* ---------- 积分曲线 ---------- */

const chart = computed(() => {
  const points = curve.value
  if (points.length < 2) return null
  const width = 520
  const height = 196
  const left = 40
  const right = 14
  const top = 16
  const bottom = 26
  const values = points.map((p) => Number(p.score))
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (max - min < 20) {
    min -= 10
    max += 10
  }
  const pad = Math.round((max - min) * 0.08)
  min -= pad
  max += pad
  const span = max - min || 1
  const plotW = width - left - right
  const plotH = height - top - bottom
  const xOf = (index) => left + (index * plotW) / (points.length - 1)
  const yOf = (value) => top + plotH - ((value - min) / span) * plotH
  const mapped = points.map((p, index) => ({ x: xOf(index), y: yOf(Number(p.score)), score: Number(p.score) }))
  const pathD = mapped.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const value = Math.round(min + (span * index) / 3)
    return { value, y: yOf(value) }
  })
  return {
    width,
    height,
    left,
    right,
    points: mapped,
    path: pathD,
    yTicks,
    firstLabel: points[0].date,
    lastLabel: points[points.length - 1].date
  }
})

async function query() {
  const uid = parseUid(uidInput.value)
  if (!uid) {
    error.value = '请输入数字 uid，例如 404523'
    return
  }
  loading.value = true
  error.value = ''
  loadingText.value = '正在登录并读取积分流水…'
  const timer = setTimeout(() => {
    loadingText.value = '正在拉取逐场战绩，首次较慢，请稍候…'
  }, 1500)
  try {
    // 后端一次性聚合：资料 + 积分曲线 + 逐场对局 + 统计
    const res = await fetchUpstream('/player', { uid })
    bundle.value = res.data
    page.value = 1
  } catch (err) {
    error.value = err.message
    bundle.value = null
  } finally {
    clearTimeout(timer)
    loading.value = false
  }
}
</script>

<style scoped>
.pv { min-height: 100dvh; background: #fff; }

.pv-hero { padding: calc(24px + var(--safe-top)) 18px 20px; color: #fff; background: var(--blue); }
.pv-hero h1 { margin: 0 0 8px; font-size: 30px; text-align: left; }
.pv-sub { margin: 0 0 16px; font-size: 13px; opacity: .92; }
.pv-search { display: grid; grid-template-columns: minmax(0, 1fr) 78px; }
.pv-search input { width: 100%; min-width: 0; min-height: 46px; padding: 0 13px; border: 0; color: #444; font-size: 15px; outline: 0; }
.pv-search button { min-height: 46px; border: 0; color: var(--blue); background: #e8f7fd; font-weight: 700; font-size: 14px; }
.pv-search button:disabled { opacity: .6; }
.pv-tip { margin: 9px 0 0; font-size: 11px; line-height: 1.6; opacity: .85; }
.pv-error { margin: 10px 0 0; padding: 8px; color: #8c2020; background: #fff; font-size: 13px; }

.pv-loading { margin-top: 14px; }

.pv-profile { padding: 22px 16px 16px; color: #fff; background: var(--blue); text-align: center; }
.pv-avatar { position: relative; width: 96px; height: 96px; margin: 0 auto 12px; border: 8px solid #fff; border-radius: 50%; display: grid; place-items: center; overflow: hidden; background: #8fd5ef; font-size: 26px; font-weight: 700; }
.pv-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.pv-profile h2 { margin: 0; font-size: 26px; }
.pv-profile h2 small { margin-left: 6px; font-size: 13px; font-weight: 500; opacity: .85; }
.pv-meta { margin: 5px 0 0; font-size: 12px; opacity: .9; }
.pv-career { margin: 0 0 4px; font-size: 12px; opacity: .9; }

.pv-stats { padding: 14px 8px; display: grid; grid-template-columns: repeat(6, 1fr); border-bottom: 1px solid #eee; }
.pv-stats > div { min-width: 0; text-align: center; }
.pv-stats span { display: block; color: #999; font-size: 10px; }
.pv-stats b { display: block; margin-top: 5px; color: #444; font-size: 18px; }
.pv-stats b.up { color: var(--blue); }
.pv-stats b.down { color: #c9553d; }

.pv-note { margin: 14px 14px 30px; color: #aaa; font-size: 11px; line-height: 1.7; }
</style>
