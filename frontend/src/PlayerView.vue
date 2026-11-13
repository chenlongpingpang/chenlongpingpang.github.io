<!-- 选手详情：输入 uid/姓名 → 资料 / 比赛统计（全部·单打·双打）/ 积分趋势 / 交手记录 -->
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
          placeholder="uid 或姓名，如 404523 / 郭永帅"
          :disabled="loading"
        >
        <button :disabled="loading">{{ loading ? '查询中' : '查询' }}</button>
      </form>
      <p class="pv-tip">uid 可在官方 App 选手资料页看到；首次查询约 5-10 秒，之后走本地缓存秒开</p>
      <p v-if="error" class="pv-error">{{ error }}</p>
    </section>

    <section v-if="candidates.length" class="pv-candidates">
      <p class="pv-cand-title">找到 {{ candidates.length }} 位选手，点击查看战绩</p>
      <button
        v-for="user in candidates"
        :key="user.uid"
        type="button"
        class="pv-cand"
        @click="chooseCandidate(user)"
      >
        <span class="pv-cand-name">{{ user.realname || user.username2 || '未命名' }}</span>
        <span class="pv-cand-meta">
          ID {{ user.uid }}
          <span v-if="user.resideprovince"> · {{ user.resideprovince }}{{ user.residecity }}</span>
          <span v-if="user.score"> · 积分 {{ user.score }}</span>
        </span>
      </button>
    </section>

    <section v-if="loading" class="loading-card pv-loading">
      <span class="ball"></span>
      <div>
        <strong>正在拉取选手数据</strong>
        <p>{{ loadingText }}</p>
      </div>
    </section>

    <template v-if="bundle">
      <section class="summary">
        <div class="player">
          <div class="profile-avatar">
            <span>{{ (profile.name || '?').slice(0, 1) }}</span>
            <img :src="avatarUrl(bundle.uid)" alt="" @error="$event.currentTarget.style.display = 'none'">
          </div>
          <h2>{{ profile.name || `用户 ${bundle.uid}` }}<small v-if="profile.nickname && profile.nickname !== profile.name">{{ profile.nickname }}</small></h2>
          <p>ID {{ bundle.uid }}</p>
        </div>

        <div class="score-overview">
          <div><span>当前积分</span><strong>{{ show(profile.score) }}</strong></div>
          <button type="button" class="annual-score" @click="openAnnual">
            <span>年度积分 <i>?</i></span><strong>{{ show(profile.yearMaxScore) }}</strong>
          </button>
          <div><span>历史最高</span><strong>{{ show(profile.maxScore) }}</strong></div>
        </div>

        <div class="scope-bar">
          <span>比赛统计</span>
          <div class="scope-tabs" aria-label="统计时间范围">
            <button :class="{ active: statScope === 'all' }" @click="setScope('all')">全部</button>
            <button :class="{ active: statScope === 'year' }" @click="setScope('year')">近一年</button>
            <button :class="{ active: statScope === 'recent40' }" @click="setScope('recent40')">近40场</button>
          </div>
        </div>
        <div class="stats-head"><span>类型</span><span>总数</span><span>胜场</span><span>败场</span></div>
        <div v-for="row in statRows" :key="row.label" class="stats-row">
          <strong>{{ row.label }}</strong>
          <b>{{ row.total }}</b>
          <b>{{ row.wins }}</b>
          <b>{{ row.losses }}</b>
        </div>

        <div v-if="trendChart" class="score-trend">
          <div class="trend-heading">
            <h3>{{ selfName }}{{ scopeLabel }}单打积分趋势</h3>
            <span>{{ trendChart.recordCount }} 场</span>
          </div>
          <svg
            :viewBox="`0 0 ${trendChart.width} ${trendChart.height}`"
            role="img"
            :aria-label="`${selfName}单打积分趋势`"
          >
            <g class="trend-grid">
              <g v-for="tick in trendChart.yTicks" :key="tick.value">
                <line :x1="trendChart.left" :x2="trendChart.width - trendChart.right" :y1="tick.y" :y2="tick.y" />
                <text :x="trendChart.left - 7" :y="tick.y + 4" text-anchor="end">{{ tick.value }}</text>
              </g>
            </g>
            <line
              class="trend-axis"
              :x1="trendChart.left"
              :x2="trendChart.left"
              :y1="trendChart.top"
              :y2="trendChart.height - trendChart.bottom"
            />
            <polyline class="trend-line" :points="trendChart.points" />
            <g class="trend-dates">
              <g v-for="tick in trendChart.xTicks" :key="`${tick.date}-${tick.x}`">
                <line :x1="tick.x" :x2="tick.x" :y1="trendChart.height - trendChart.bottom" :y2="trendChart.height - trendChart.bottom + 5" />
                <text :x="tick.x" :y="trendChart.height - 19" text-anchor="middle">
                  <tspan :x="tick.x">{{ String(tick.date).slice(0, 4) }}</tspan>
                  <tspan :x="tick.x" dy="9">{{ String(tick.date).slice(5) }}</tspan>
                </text>
              </g>
            </g>
            <g v-if="trendChart.maxPoint !== trendChart.currentPoint" class="trend-mark">
              <circle :cx="trendChart.maxPoint.x" :cy="trendChart.maxPoint.y" r="3" />
              <text :x="trendChart.maxPoint.x" :y="trendChart.maxPoint.y - 8" text-anchor="middle">{{ trendChart.maxPoint.score }}</text>
            </g>
            <g v-if="trendChart.minPoint !== trendChart.currentPoint" class="trend-mark">
              <circle :cx="trendChart.minPoint.x" :cy="trendChart.minPoint.y" r="3" />
              <text :x="trendChart.minPoint.x" :y="trendChart.minPoint.y + 15" text-anchor="middle">{{ trendChart.minPoint.score }}</text>
            </g>
            <g class="trend-mark current">
              <circle :cx="trendChart.currentPoint.x" :cy="trendChart.currentPoint.y" r="3" />
              <text :x="trendChart.currentPoint.x + 6" :y="trendChart.currentPoint.y + 4">{{ trendChart.currentPoint.score }}</text>
            </g>
          </svg>
        </div>
      </section>

      <section class="records">
        <div class="section-head">
          <h2>交手记录</h2>
          <span>{{ loading ? `已加载 ${scopedRecords.length} 场` : `共 ${scopedRecords.length} 场` }}</span>
        </div>

        <div v-if="visibleRecords.length" class="table-wrap">
          <table>
            <thead><tr><th style="width:10%">序号</th><th style="width:24%">我方</th><th style="width:26%">敌方</th><th style="width:16%">比分</th><th style="width:12%">变化</th><th style="width:12%">日期</th></tr></thead>
            <tbody>
              <tr v-for="(record, index) in visibleRecords" :key="record.gameId || `${record.date}-${record.oppUid}-${index}`">
                <td>{{ (page - 1) * pageSize + index + 1 }}</td>
                <td>{{ teamName(record.selfName || selfName, record.teammateName) }}</td>
                <td><strong>{{ teamName(record.opponentName, record.opponentTeammateName) }}</strong></td>
                <td><strong class="score">{{ record.scoreLine }}</strong></td>
                <td :class="{ positive: String(record.scoreChange).startsWith('+'), negative: String(record.scoreChange).startsWith('-') }">{{ record.scoreChange || '-' }}</td>
                <td>{{ record.date || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">没有查询到该时间范围内的交手记录</div>

        <div v-if="totalPages > 1" class="pager">
          <button :disabled="page === 1" @click="changePage(page - 1)">上一页</button>
          <span>{{ page }} / {{ totalPages }}</span>
          <button :disabled="page === totalPages" @click="changePage(page + 1)">下一页</button>
        </div>
      </section>

      <div v-if="annualScoreOpen" class="dialog-backdrop" @click.self="annualScoreOpen = false">
        <section class="annual-dialog" role="dialog" aria-modal="true" aria-label="年度积分计算说明">
          <button class="dialog-close" aria-label="关闭" @click="annualScoreOpen = false">×</button>

          <template v-if="annualDetail === 'overview'">
            <h2>年度积分怎么算？</h2>
            <p class="annual-formula">年度最高 + 大额输分调整 − 参赛扣减 + 官方修正</p>
            <div v-if="annualAnalysis" class="formula-grid">
              <button class="metric-help" type="button" @click="annualDetail = 'peak'">近一年单打最高 <i>?</i></button>
              <b>{{ annualAnalysis.peak ?? '-' }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'loss'">大额输分调整 <i>?</i></button>
              <b>{{ annualAnalysis.adjustment ?? '人工审核' }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'deduction'">参赛扣减 <i>?</i></button>
              <b>−{{ annualAnalysis.deduction }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'correction'">官方修正 <i>?</i></button>
              <b>{{ annualAnalysis.correction ?? '-' }}</b>
              <span>官网年度积分</span><strong>{{ profile.yearMaxScore || '-' }}</strong>
            </div>
          </template>

          <template v-else-if="annualDetail === 'peak'">
            <button class="dialog-back" type="button" @click="annualDetail = 'overview'">‹ 返回年度积分</button>
            <h2>近一年单打最高</h2>
            <p v-if="annualAnalysis?.peakRecord" class="detail-intro">
              <span>比赛日期：{{ annualAnalysis.peakRecord.date }}</span>
              <span>比赛名称：{{ eventTitleMap.get(annualAnalysis.peakRecord.eventId) || '—' }}</span>
            </p>
            <div v-if="annualAnalysis?.peakEventRecords.length" class="table-wrap annual-record-table peak-event-table">
              <table>
                <thead><tr><th>序号</th><th>我方</th><th>对手</th><th>比分</th><th>变化</th><th>实时积分</th></tr></thead>
                <tbody>
                  <tr
                    v-for="record in annualAnalysis.peakEventRecords"
                    :key="record.gameId"
                    :class="{ 'peak-score-row': record.gameId === annualAnalysis.peakRecord.gameId }"
                  >
                    <td>{{ record.overallIndex }}</td>
                    <td>{{ teamName(record.selfName || selfName, record.teammateName) }}</td>
                    <td><strong>{{ teamName(record.opponentName, record.opponentTeammateName) }}</strong></td>
                    <td><strong class="score">{{ record.scoreLine }}</strong></td>
                    <td>{{ record.scoreChange }}</td>
                    <td>{{ record.after }}<small v-if="record.gameId === annualAnalysis.peakRecord.gameId">最高</small></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="annual-note">当前数据不足，无法定位产生最高积分的比赛。</p>
          </template>

          <template v-else-if="annualDetail === 'loss'">
            <button class="dialog-back" type="button" @click="annualDetail = 'overview'">‹ 返回年度积分</button>
            <h2>大额输分调整</h2>
            <p class="detail-intro">近一年单打掉分 ≥35 的场次</p>
            <div v-if="annualAnalysis?.largeLosses.length" class="table-wrap annual-record-table">
              <table>
                <thead><tr><th>序号</th><th>我方</th><th>敌方</th><th>比分</th><th>变化</th><th>日期</th></tr></thead>
                <tbody>
                  <tr v-for="record in annualAnalysis.largeLosses" :key="record.gameId">
                    <td>{{ record.overallIndex }}</td>
                    <td>{{ teamName(record.selfName || selfName, record.teammateName) }}</td>
                    <td><strong>{{ teamName(record.opponentName, record.opponentTeammateName) }}</strong></td>
                    <td><strong class="score">{{ record.scoreLine }}</strong></td>
                    <td>{{ record.scoreChange }}</td>
                    <td>{{ record.date }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="annual-note">当前没有大额输分比赛。</p>
          </template>

          <template v-else-if="annualDetail === 'deduction'">
            <button class="dialog-back" type="button" @click="annualDetail = 'overview'">‹ 返回年度积分</button>
            <h2>参赛扣减</h2>
            <div class="deduction-axis" aria-label="参赛盘数扣减数轴">
              <div class="deduction-values">
                <span :class="{ active: annualAnalysis?.deduction === 0 }">0</span>
                <span :class="{ active: annualAnalysis?.deduction === 50 }">-50</span>
                <span :class="{ active: annualAnalysis?.deduction === 60 }">-60</span>
                <span :class="{ active: annualAnalysis?.deduction === 70 }">-70</span>
                <span :class="{ active: annualAnalysis?.deduction === 80 }">-80</span>
                <span :class="{ active: annualAnalysis?.deduction === 90 }">-90</span>
                <span :class="{ active: annualAnalysis?.deduction === 100 }">-100</span>
              </div>
              <div class="deduction-track"><i v-for="tick in 8" :key="tick"></i></div>
              <div class="deduction-labels">
                <span>0</span><span>10</span><span>30</span><span>120</span>
                <span>240</span><span>360</span><span>480</span><span>+</span>
              </div>
              <small>参赛盘数</small>
            </div>
            <p class="detail-intro">当前统计 {{ annualAnalysis?.count || 0 }} 场单打（已结算积分），参赛扣减为 {{ annualAnalysis?.deduction ? `-${annualAnalysis.deduction}` : 0 }} 分。</p>
          </template>

          <template v-else>
            <button class="dialog-back" type="button" @click="annualDetail = 'overview'">‹ 返回年度积分</button>
            <h2>官方修正</h2>
            <p class="detail-intro">根据获得荣誉、惩罚等情况调整，具体规则未知。本界面采用反推的形式，根据官网年度积分与其他已知项目的差额计算官方修正。</p>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { fetchUpstream } from './api.js'

const uidInput = ref('')
const loading = ref(false)
const loadingText = ref('正在登录并读取积分流水…')
const error = ref('')
const bundle = ref(null)
const candidates = ref([])
const page = ref(1)
const statScope = ref('all')
const annualScoreOpen = ref(false)
const annualDetail = ref('overview')
const pageSize = 20

const profile = computed(() => bundle.value?.profile || {})
const matches = computed(() => bundle.value?.matches || [])
const fallbackCurve = computed(() => bundle.value?.curve || [])
const selfName = computed(() => profile.value.name || `用户 ${bundle.value?.uid || ''}`)

const oneYearCutoff = computed(() => {
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 1)
  return [
    cutoff.getFullYear(),
    String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0')
  ].join('-')
})

const scopeLabel = computed(() => statScope.value === 'year' ? '近一年' : statScope.value === 'recent40' ? '近40场' : '全部')

const scopedRecords = computed(() => {
  if (statScope.value === 'year') {
    return matches.value.filter(record => String(record.date || '') >= oneYearCutoff.value)
  }
  if (statScope.value === 'recent40') {
    return [...matches.value]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 40)
  }
  return matches.value
})

function setScope(scope) {
  statScope.value = scope
  page.value = 1
}

watch(statScope, () => { page.value = 1 })

const totalPages = computed(() => Math.max(1, Math.ceil(scopedRecords.value.length / pageSize)))
const visibleRecords = computed(() => {
  const start = (page.value - 1) * pageSize
  return scopedRecords.value.slice(start, start + pageSize)
})

function numberValue(value) {
  const text = String(value ?? '').replace('+', '').trim()
  if (!text || text === '-') return null
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function isSettledScoreChange(value) {
  return numberValue(value) !== null
}

function buildStatRow(label, records) {
  return {
    label,
    total: records.length,
    wins: records.filter(record => record.outcome === 'win').length,
    losses: records.filter(record => record.outcome === 'loss').length
  }
}

const statRows = computed(() => [
  buildStatRow('全部', scopedRecords.value),
  buildStatRow('单打', scopedRecords.value.filter(record => !record.doubles)),
  buildStatRow('双打', scopedRecords.value.filter(record => record.doubles))
])

const trendChart = computed(() => {
  if (!bundle.value) return null
  const records = scopedRecords.value.filter(record => !record.doubles && isSettledScoreChange(record.scoreChange))
  let running = numberValue(profile.value.score)

  let series = []
  if (running !== null && records.length) {
    const reversedTrace = records.map(record => {
      const delta = numberValue(record.scoreChange)
      const after = running
      const before = running - delta
      running = before
      return { date: record.date, before, after }
    })
    const chronological = [...reversedTrace].reverse()
    series = [
      { date: chronological[0].date, score: chronological[0].before },
      ...chronological.map(record => ({ date: record.date, score: record.after }))
    ]
  } else if (fallbackCurve.value.length >= 2) {
    series = fallbackCurve.value.map(p => ({ date: p.date, score: Number(p.score) }))
  } else {
    return null
  }

  const width = 360
  const height = 218
  const left = 42
  const right = 30
  const top = 34
  const bottom = 34
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const scores = series.map(point => point.score)
  const rawMin = Math.min(...scores)
  const rawMax = Math.max(...scores)
  const yMin = Math.floor((rawMin - 25) / 50) * 50
  const yMax = Math.ceil((rawMax + 25) / 50) * 50
  const yRange = Math.max(50, yMax - yMin)
  const points = series.map((point, index) => ({
    ...point,
    x: left + (series.length === 1 ? 0 : index / (series.length - 1)) * plotWidth,
    y: top + ((yMax - point.score) / yRange) * plotHeight
  }))
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = Math.round(yMax - (yRange * index) / 4)
    return { value, y: top + (plotHeight * index) / 4 }
  })
  const tickIndexes = [...new Set(
    Array.from({ length: Math.min(5, series.length) }, (_, index) =>
      Math.round((index * (series.length - 1)) / Math.max(1, Math.min(5, series.length) - 1))
    )
  )]
  const xTicks = tickIndexes.map(index => points[index])
  const maxPoint = points.find(point => point.score === rawMax)
  const minPoint = points.find(point => point.score === rawMin)
  const currentPoint = points.at(-1)

  return {
    width, height, left, right, top, bottom,
    points: points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    yTicks, xTicks, maxPoint, minPoint, currentPoint,
    recordCount: records.length
  }
})

const eventTitleMap = computed(() => {
  const map = new Map()
  for (const record of matches.value) {
    if (record.eventId && record.title) map.set(record.eventId, record.title)
  }
  return map
})

const annualAnalysis = computed(() => {
  if (!bundle.value) return null
  const rows = matches.value
    .filter(record => !record.doubles && String(record.date || '') >= oneYearCutoff.value && isSettledScoreChange(record.scoreChange))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))

  let running = numberValue(profile.value.score)
  const reconstructed = rows.map(record => {
    const delta = numberValue(record.scoreChange)
    const after = running
    const before = running !== null && delta !== null ? running - delta : running
    if (before !== null) running = before
    return { ...record, delta, before, after }
  })

  const peakValues = reconstructed.flatMap(row => [row.before, row.after]).filter(Number.isFinite)
  if (numberValue(profile.value.score) !== null) peakValues.push(numberValue(profile.value.score))
  let peak = peakValues.length ? Math.max(...peakValues) : null
  const maximum = numberValue(profile.value.maxScore)
  if (peak !== null && maximum !== null) peak = Math.min(peak, maximum)

  const largeLosses = reconstructed.filter(row => row.delta !== null && row.delta <= -35)
  const ratio = largeLosses.length ? reconstructed.length / largeLosses.length : Infinity
  const coefficient = largeLosses.length === 0 || ratio >= 40 ? 0
    : ratio > 30 ? 0.2 : ratio > 20 ? 0.4 : ratio > 10 ? 0.6 : null
  const lossTotal = largeLosses.reduce((sum, row) => sum + row.delta, 0)
  const adjustment = coefficient === null ? null : -(coefficient * lossTotal)

  const count = reconstructed.length
  const deduction = count >= 480 ? 100 : count >= 360 ? 90 : count >= 240 ? 80
    : count >= 120 ? 70 : count >= 30 ? 60 : count >= 10 ? 50 : 0

  const official = numberValue(profile.value.yearMaxScore)
  const correction = official !== null && peak !== null && adjustment !== null
    ? official - peak - adjustment + deduction
    : null

  const peakRecord = reconstructed.find(record => record.after === peak && record.delta >= 0)
    || reconstructed.find(record => record.before === peak)
    || null
  const recordPositions = new Map(matches.value.map((record, index) => [record.gameId, index + 1]))
  const peakEventRecords = peakRecord
    ? reconstructed
      .filter(record => peakRecord.eventId ? record.eventId === peakRecord.eventId : record.date === peakRecord.date)
      .sort((a, b) => Number(a.gameId) - Number(b.gameId))
      .map(record => ({ ...record, overallIndex: recordPositions.get(record.gameId) || '-' }))
    : []

  return {
    peak,
    peakRecord,
    peakEventRecords,
    adjustment,
    deduction,
    correction,
    count,
    largeLossCount: largeLosses.length,
    largeLosses: largeLosses.map(record => ({
      ...record,
      overallIndex: recordPositions.get(record.gameId) || '-'
    }))
  }
})

function openAnnual() {
  annualDetail.value = 'overview'
  annualScoreOpen.value = true
}

function show(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : '-'
}

function avatarUrl(userId) {
  const padded = String(userId || '').padStart(8, '0')
  return `https://oss.kaiqiu.cc/avatar/000/${padded.slice(2, 4)}/${padded.slice(4, 6)}/${padded.slice(6, 8)}_avatar_big.jpg`
}

function teamName(primary, teammate) {
  return teammate ? `${primary || '-'} / ${teammate}` : (primary || '-')
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

async function loadPlayer(uid) {
  loading.value = true
  error.value = ''
  loadingText.value = '正在登录并读取积分流水…'
  const timer = setTimeout(() => {
    loadingText.value = '正在拉取逐场战绩，首次较慢，请稍候…'
  }, 1500)
  try {
    const res = await fetchUpstream('/player', { uid })
    bundle.value = res.data
    page.value = 1
    statScope.value = 'all'
  } catch (err) {
    error.value = err.message
    bundle.value = null
  } finally {
    clearTimeout(timer)
    loading.value = false
  }
}

async function searchByName(keyword) {
  loading.value = true
  error.value = ''
  candidates.value = []
  try {
    const res = await fetchUpstream('/user/lists', { key: keyword, page: 1 })
    const rows = Array.isArray(res?.data?.data) ? res.data.data : []
    if (!rows.length) {
      error.value = `未找到“${keyword}”相关选手，换个名字或直接输入 uid`
      return
    }
    if (rows.length === 1) {
      await loadPlayer(String(rows[0].uid))
    } else {
      candidates.value = rows.slice(0, 20)
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function query() {
  const raw = String(uidInput.value || '').trim()
  if (!raw) {
    error.value = '请输入 uid 或姓名，例如 404523 或 郭永帅'
    return
  }
  candidates.value = []
  const uid = parseUid(raw)
  if (uid) {
    await loadPlayer(uid)
  } else {
    await searchByName(raw)
  }
}

async function chooseCandidate(user) {
  candidates.value = []
  uidInput.value = user.realname || user.username2 || ''
  await loadPlayer(String(user.uid))
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

.pv-candidates { margin: 14px 18px 0; display: flex; flex-direction: column; gap: 8px; }
.pv-cand-title { margin: 0 0 2px; font-size: 13px; color: #666; }
.pv-cand { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border: 1px solid #e3eef5; border-radius: 10px; background: #fff; text-align: left; }
.pv-cand:active { background: #f0f8fc; }
.pv-cand-name { font-size: 15px; font-weight: 700; color: #222; }
.pv-cand-meta { font-size: 12px; color: #888; }

.pv-loading { margin-top: 14px; }

.positive { color: var(--blue); }
.negative { color: #c9553d; }
</style>
