<script setup>
import { computed, ref, watch } from 'vue'

const keyword = ref('')
const loading = ref(false)
const searchingUsers = ref(false)
const error = ref('')
const result = ref(null)
const selectedUser = ref(null)
const candidates = ref([])
const candidatesTruncated = ref(false)
const hasSearchedUsers = ref(false)
const page = ref(1)
const statScope = ref('all')
const annualScoreOpen = ref(false)
const annualDetail = ref('overview')
const eventTitles = ref({})
const loadingProgress = ref({ pages: 0, records: 0, resumed: false, nextPage: 1 })
const pageSize = 20
const upstreamBase = (import.meta.env.VITE_KQ_BASE_URL || 'https://kaiqiuwang.cc/xcx/public/index.php/api').replace(/\/$/, '')
const maxRecordPages = 500
const maxCandidates = 50
const recordBatchSize = 5
const recordRetryAttempts = 3
const completeCacheLifetime = 6 * 60 * 60 * 1000
let activeRecordController = null
let cacheDatabasePromise = null

const versusKeywords = ref(['', ''])
const versusCandidates = ref([[], []])
const versusSelected = ref([null, null])
const versusSearching = ref([false, false])
const versusLoading = ref(false)
const versusError = ref('')
const versusGames = ref([])
const versusRecentGames = ref([])
const versusProgress = ref({ pages: 0, records: 0, complete: false })
let versusController = null

function recentAverageScore(user, games) {
  const current = numberValue(user?.score)
  if (current === null) return null
  const records = summarizeGames(String(user.uid), games, false, user).records
    .filter(record => !record.doubles && isSettledScoreChange(record.scoreChange))
    .slice(0, 10)
  if (!records.length) return null
  let running = current
  const scores = records.map(record => {
    const after = running
    running -= numberValue(record.scoreChange)
    return after
  })
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
}

const versusPrediction = computed(() => {
  const [playerA, playerB] = versusSelected.value
  if (!playerA || !playerB) return null
  const uidA = String(playerA.uid)
  const uidB = String(playerB.uid)
  const directGames = versusGames.value.filter(game => {
    const left = [game.uid1, game.uid11].map(String)
    const right = [game.uid2, game.uid22].map(String)
    const doubles = (game.uid11 && String(game.uid11) !== '0')
      || (game.uid22 && String(game.uid22) !== '0')
    return !doubles && (
      (left.includes(uidA) && right.includes(uidB))
      || (left.includes(uidB) && right.includes(uidA))
    )
  })
  let winsA = 0
  let winsB = 0
  const records = directGames.map(game => {
    const aOnLeft = String(game.uid1) === uidA
    const scoreA = Number(aOnLeft ? game.result1 : game.result2) || 0
    const scoreB = Number(aOnLeft ? game.result2 : game.result1) || 0
    if (scoreA > scoreB) winsA += 1
    else if (scoreB > scoreA) winsB += 1
    return {
      gameId: String(game.gameid || ''),
      date: game.dateline || '',
      playerA: playerName(aOnLeft ? game.username1 : game.username2) || playerA.realname || playerA.username2,
      playerB: playerName(aOnLeft ? game.username2 : game.username1) || playerB.realname || playerB.username2,
      scoreLine: `${scoreA}:${scoreB}`,
      winner: scoreA > scoreB ? 'A' : scoreA < scoreB ? 'B' : ''
    }
  })
  const total = records.length
  const scoreA = numberValue(playerA.score)
  const scoreB = numberValue(playerB.score)
  const recentAverageA = recentAverageScore(playerA, versusGames.value)
  const recentAverageB = recentAverageScore(playerB, versusRecentGames.value)
  const strengthA = scoreA !== null && recentAverageA !== null ? (scoreA + recentAverageA) / 2 : scoreA ?? recentAverageA
  const strengthB = scoreB !== null && recentAverageB !== null ? (scoreB + recentAverageB) / 2 : scoreB ?? recentAverageB
  const ratingProbabilityA = strengthA !== null && strengthB !== null
    ? 1 / (1 + 10 ** ((strengthB - strengthA) / 400))
    : 0.5
  const historyProbabilityA = total ? winsA / total : ratingProbabilityA
  const historyWeight = total / (total + 10)
  const finalA = ratingProbabilityA * (1 - historyWeight) + historyProbabilityA * historyWeight
  const percentageA = Math.round(finalA * 100)
  const gamesWonA = records.reduce((sum, record) => sum + Number(record.scoreLine.split(':')[0] || 0), 0)
  const gamesWonB = records.reduce((sum, record) => sum + Number(record.scoreLine.split(':')[1] || 0), 0)
  const scoreSummary = [...records.reduce((summary, record) => {
    summary.set(record.scoreLine, (summary.get(record.scoreLine) || 0) + 1)
    return summary
  }, new Map())].map(([score, count]) => `${score}${count > 1 ? `（${count}次）` : ''}`).join('、')
  const nameA = playerA.realname || playerA.username2 || '选手A'
  const nameB = playerB.realname || playerB.username2 || '选手B'
  const recentDescription = recentAverageA !== null && recentAverageB !== null
    ? `${nameA}近10场单打的实时积分平均为${recentAverageA}分，${nameB}为${recentAverageB}分`
    : '当前读取到的已结算单打不足10场，近期平均积分按已读取场次计算'
  const historyDescription = total
    ? `两人历史单打交手${total}次，${nameA}赢${winsA}次、${nameB}赢${winsB}次；按每局累计，${nameA}赢${gamesWonA}局、${nameB}赢${gamesWonB}局，比分记录为${scoreSummary}`
    : '目前没有查到两人的直接单打记录，因此主要参考当前积分与近期积分表现'
  const reasoningText = `${nameA}当前${scoreA ?? '暂无'}分，${nameB}当前${scoreB ?? '暂无'}分；${recentDescription}。${historyDescription}。综合双方当前水平、近期状态和直接交手表现，预测${nameA}胜率约为${percentageA}%，${nameB}约为${100 - percentageA}%。`

  return {
    records,
    total,
    winsA,
    winsB,
    scoreA,
    scoreB,
    recentAverageA,
    recentAverageB,
    ratingProbabilityA,
    historyProbabilityA,
    historyWeight,
    percentageA,
    percentageB: 100 - percentageA,
    reasoningText
  }
})

const oneYearCutoff = computed(() => {
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 1)
  return [
    cutoff.getFullYear(),
    String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0')
  ].join('-')
})
const scopedRecords = computed(() => {
  const records = result.value?.records || []
  return statScope.value === 'year'
    ? records.filter(record => String(record.date || '') >= oneYearCutoff.value)
    : records
})
const totalPages = computed(() => Math.max(1, Math.ceil(scopedRecords.value.length / pageSize)))
const visibleRecords = computed(() => {
  const start = (page.value - 1) * pageSize
  return scopedRecords.value.slice(start, start + pageSize)
})
const statRows = computed(() => [
  buildStatRow('全部', scopedRecords.value),
  buildStatRow('单打', scopedRecords.value.filter(record => !record.doubles)),
  buildStatRow('双打', scopedRecords.value.filter(record => record.doubles))
])
const trendChart = computed(() => {
  if (!result.value) return null
  const records = scopedRecords.value.filter(record =>
    !record.doubles && isSettledScoreChange(record.scoreChange)
  )
  let running = numberValue(result.value.currentScore)
  if (running === null || !records.length) return null

  const reversedTrace = records.map(record => {
    const delta = numberValue(record.scoreChange)
    const after = running
    const before = running - delta
    running = before
    return { date: record.date, before, after }
  })
  const chronological = [...reversedTrace].reverse()
  const series = [
    { date: chronological[0].date, score: chronological[0].before },
    ...chronological.map(record => ({ date: record.date, score: record.after }))
  ]
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
    width,
    height,
    left,
    right,
    top,
    bottom,
    plotWidth,
    plotHeight,
    points: points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    yTicks,
    xTicks,
    maxPoint,
    minPoint,
    currentPoint,
    recordCount: records.length
  }
})
const annualAnalysis = computed(() => {
  if (!result.value) return null
  const rows = result.value.records
    .filter(record =>
      !record.doubles &&
      String(record.date || '') >= oneYearCutoff.value &&
      isSettledScoreChange(record.scoreChange)
    )
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))
  let running = numberValue(result.value.currentScore)
  const reconstructed = rows.map(record => {
    const delta = numberValue(record.scoreChange)
    const after = running
    const before = running !== null && delta !== null ? running - delta : running
    if (before !== null) running = before
    return { ...record, delta, before, after }
  })
  const peakValues = reconstructed.flatMap(row => [row.before, row.after]).filter(Number.isFinite)
  if (numberValue(result.value.currentScore) !== null) peakValues.push(numberValue(result.value.currentScore))
  let peak = peakValues.length ? Math.max(...peakValues) : null
  const maximum = numberValue(result.value.maxScore)
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
  const official = numberValue(result.value.annualScore)
  const correction = official !== null && peak !== null && adjustment !== null
    ? official - peak - adjustment + deduction
    : null
  const peakRecord = reconstructed.find(record => record.after === peak && record.delta >= 0)
    || reconstructed.find(record => record.before === peak)
    || null
  const recordPositions = new Map(
    result.value.records.map((record, index) => [record.gameId, index + 1])
  )
  const peakEventRecords = peakRecord
    ? reconstructed
      .filter(record => peakRecord.eventId
        ? record.eventId === peakRecord.eventId
        : record.date === peakRecord.date)
      .sort((left, right) => Number(left.gameId) - Number(right.gameId))
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

watch(statScope, () => {
  page.value = 1
})

async function fetchUpstream(path, params, signal) {
  const url = new URL(`${upstreamBase}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const response = await fetch(url, { signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.code !== 1) {
    throw new Error(data.msg || '开球网接口请求失败，请稍后重试')
  }
  return data
}

function openCacheDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('当前浏览器不支持断点缓存'))
  if (cacheDatabasePromise) return cacheDatabasePromise
  cacheDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('match-history-cache', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('queries')) {
        request.result.createObjectStore('queries', { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return cacheDatabasePromise
}

async function readQueryCache(userId) {
  try {
    const database = await openCacheDatabase()
    return await new Promise((resolve, reject) => {
      const request = database.transaction('queries').objectStore('queries').get(String(userId))
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  }
}

async function writeQueryCache(payload) {
  try {
    const database = await openCacheDatabase()
    await new Promise((resolve, reject) => {
      const request = database.transaction('queries', 'readwrite').objectStore('queries').put(payload)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    // 缓存不可用时仍可继续在线查询
  }
}

function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('查询已取消', 'AbortError'))
    }, { once: true })
  })
}

async function fetchRecordPage(userId, recordPage, signal) {
  let lastError
  for (let attempt = 1; attempt <= recordRetryAttempts; attempt += 1) {
    try {
      return await fetchUpstream('/User/getGames', { uid: userId, page: recordPage }, signal)
    } catch (requestError) {
      if (requestError.name === 'AbortError') throw requestError
      lastError = requestError
      if (attempt < recordRetryAttempts) await waitForRetry(attempt * 600, signal)
    }
  }
  throw lastError
}

async function showAnnualDetail(detail) {
  annualDetail.value = detail
  if (detail !== 'peak') return
  const eventId = annualAnalysis.value?.peakRecord?.eventId
  if (!eventId || eventTitles.value[eventId]) return
  try {
    const response = await fetchUpstream('/enter/detail', {
      id: eventId,
      lat: 34.7466,
      lng: 113.6254
    })
    eventTitles.value = {
      ...eventTitles.value,
      [eventId]: response?.data?.detail?.title || `赛事 ${eventId}`
    }
  } catch {
    eventTitles.value = { ...eventTitles.value, [eventId]: `赛事 ${eventId}` }
  }
}

async function searchVersusUser(side) {
  const value = versusKeywords.value[side].trim()
  if (!value || value.length > 30) {
    versusError.value = '请输入 1 到 30 个字符的姓名或昵称'
    return
  }
  const searching = [...versusSearching.value]
  searching[side] = true
  versusSearching.value = searching
  versusError.value = ''
  const selected = [...versusSelected.value]
  selected[side] = null
  versusSelected.value = selected
  versusGames.value = []
  versusRecentGames.value = []

  try {
    const users = new Map()
    for (let searchPage = 1; users.size < maxCandidates; searchPage += 1) {
      const response = await fetchUpstream('/user/lists', { key: value, page: searchPage })
      const rows = Array.isArray(response?.data?.data) ? response.data.data : []
      rows.forEach(user => {
        if (user?.uid && users.size < maxCandidates) users.set(String(user.uid), user)
      })
      const lastPage = Number(response?.data?.last_page || searchPage)
      if (!rows.length || searchPage >= lastPage) break
    }
    const candidatesBySide = [...versusCandidates.value]
    candidatesBySide[side] = [...users.values()]
    versusCandidates.value = candidatesBySide
  } catch (requestError) {
    versusError.value = requestError.message || '无法读取选手信息，请稍后重试'
  } finally {
    const finished = [...versusSearching.value]
    finished[side] = false
    versusSearching.value = finished
  }
}

function chooseVersusUser(side, user) {
  const other = versusSelected.value[side === 0 ? 1 : 0]
  if (other && String(other.uid) === String(user.uid)) {
    versusError.value = '请选择两名不同的选手'
    return
  }
  const selected = [...versusSelected.value]
  selected[side] = user
  versusSelected.value = selected
  const candidatesBySide = [...versusCandidates.value]
  candidatesBySide[side] = []
  versusCandidates.value = candidatesBySide
  versusGames.value = []
  versusRecentGames.value = []
  versusError.value = ''
  if (selected[0] && selected[1]) loadVersusHistory()
}

function resetVersusSide(side) {
  versusController?.abort()
  versusLoading.value = false
  const selected = [...versusSelected.value]
  selected[side] = null
  versusSelected.value = selected
  versusGames.value = []
  versusRecentGames.value = []
  versusError.value = ''
}

async function loadRecentHistory(user, signal) {
  const cached = await readQueryCache(user.uid)
  if (cached?.games?.length) {
    const settledSingles = summarizeGames(String(user.uid), cached.games, false, user).records
      .filter(record => !record.doubles && isSettledScoreChange(record.scoreChange))
    if (settledSingles.length >= 10 || cached.complete) return cached.games
  }
  const games = new Map()
  for (let recordPage = 1; recordPage <= 10; recordPage += 1) {
    const response = await fetchRecordPage(user.uid, recordPage, signal)
    const rows = Array.isArray(response?.data?.data) ? response.data.data : []
    rows.forEach((game, index) => games.set(String(game.gameid || `${recordPage}-${index}`), game))
    const settledSingles = summarizeGames(String(user.uid), [...games.values()], false, user).records
      .filter(record => !record.doubles && isSettledScoreChange(record.scoreChange))
    if (!rows.length || settledSingles.length >= 10) break
  }
  return [...games.values()]
}

async function loadVersusHistory() {
  const sourceUser = versusSelected.value[0]
  const otherUser = versusSelected.value[1]
  if (!sourceUser || !otherUser) return
  versusController?.abort()
  versusController = new AbortController()
  const { signal } = versusController
  const games = new Map()
  let startPage = 1
  versusLoading.value = true
  versusError.value = ''
  versusProgress.value = { pages: 0, records: 0, complete: false }
  const recentHistoryPromise = loadRecentHistory(otherUser, signal).then(gamesForRecent => {
    versusRecentGames.value = gamesForRecent
  }).catch(() => {
    versusRecentGames.value = []
  })

  try {
    const cached = await readQueryCache(sourceUser.uid)
    if (cached?.games?.length) {
      cached.games.forEach((game, index) => {
        games.set(String(game.gameid || `cached-${index}`), game)
      })
      versusGames.value = [...games.values()]
      startPage = cached.complete ? maxRecordPages + 1 : Math.max(1, Number(cached.nextPage) || 1)
      versusProgress.value = {
        pages: Math.max(0, startPage - 1),
        records: games.size,
        complete: Boolean(cached.complete)
      }
      if (cached.complete && Date.now() - Number(cached.updatedAt || 0) < completeCacheLifetime) {
        await recentHistoryPromise
        return
      }
      if (cached.complete) {
        games.clear()
        startPage = 1
      }
    }

    for (let batchStart = startPage; batchStart <= maxRecordPages; batchStart += recordBatchSize) {
      const batchPages = Array.from(
        { length: Math.min(recordBatchSize, maxRecordPages - batchStart + 1) },
        (_, index) => batchStart + index
      )
      const responses = await Promise.allSettled(
        batchPages.map(recordPage => fetchRecordPage(sourceUser.uid, recordPage, signal))
      )
      let reachedEnd = false
      const failedPages = []
      responses.forEach((settled, index) => {
        if (settled.status === 'rejected') {
          failedPages.push(batchPages[index])
          return
        }
        const rows = Array.isArray(settled.value?.data?.data) ? settled.value.data.data : []
        if (!rows.length) reachedEnd = true
        rows.forEach((game, rowIndex) => {
          games.set(String(game.gameid || `${batchPages[index]}-${rowIndex}`), game)
        })
      })
      const nextPage = failedPages.length ? Math.min(...failedPages) : batchPages.at(-1) + 1
      versusGames.value = [...games.values()]
      versusProgress.value = {
        pages: batchPages.at(-1),
        records: games.size,
        complete: reachedEnd && !failedPages.length
      }
      await writeQueryCache({
        userId: String(sourceUser.uid),
        user: sourceUser,
        games: [...games.values()],
        nextPage,
        complete: reachedEnd && !failedPages.length,
        updatedAt: Date.now()
      })
      if (failedPages.length) {
        throw new Error(`第 ${failedPages.join('、')} 页读取失败，已保存进度，可点击继续读取`)
      }
      if (reachedEnd) break
    }
    await recentHistoryPromise
  } catch (requestError) {
    if (requestError.name !== 'AbortError') {
      versusError.value = requestError.message || '读取历史战绩失败，请稍后重试'
    }
  } finally {
    if (versusController?.signal === signal) {
      versusLoading.value = false
      versusController = null
    }
  }
}

async function searchUsers() {
  const value = keyword.value.trim()
  if (!value || value.length > 30) {
    error.value = '请输入 1 到 30 个字符的姓名或昵称'
    return
  }

  activeRecordController?.abort()
  loading.value = false
  searchingUsers.value = true
  error.value = ''
  result.value = null
  selectedUser.value = null
  candidates.value = []
  candidatesTruncated.value = false
  hasSearchedUsers.value = false
  page.value = 1

  try {
    const users = new Map()
    let hasMore = false

    for (let searchPage = 1; users.size < maxCandidates; searchPage += 1) {
      const response = await fetchUpstream('/user/lists', { key: value, page: searchPage })
      const rows = Array.isArray(response?.data?.data) ? response.data.data : []
      rows.forEach(user => {
        if (user?.uid && users.size < maxCandidates) users.set(String(user.uid), user)
      })

      const lastPage = Number(response?.data?.last_page || searchPage)
      if (!rows.length || searchPage >= lastPage) break
      if (users.size >= maxCandidates) hasMore = true
    }

    candidates.value = [...users.values()]
    candidatesTruncated.value = hasMore
    hasSearchedUsers.value = true
  } catch (requestError) {
    error.value = requestError.message || '无法读取开球网数据，请检查网络后重试'
  } finally {
    searchingUsers.value = false
  }
}

async function selectUser(user) {
  selectedUser.value = user
  activeRecordController?.abort()
  activeRecordController = new AbortController()
  const { signal } = activeRecordController
  loading.value = true
  error.value = ''
  result.value = null
  candidates.value = []
  hasSearchedUsers.value = false
  page.value = 1
  statScope.value = 'all'
  loadingProgress.value = { pages: 0, records: 0, resumed: false, nextPage: 1 }

  try {
    const games = new Map()
    let truncated = false
    let completed = false
    let startPage = 1
    const cached = await readQueryCache(user.uid)

    if (cached?.games?.length) {
      cached.games.forEach((game, index) => {
        games.set(String(game.gameid || `cached-${index}`), game)
      })
      startPage = Math.max(1, Number(cached.nextPage) || 1)
      loadingProgress.value = {
        pages: Math.max(0, startPage - 1),
        records: games.size,
        resumed: !cached.complete,
        nextPage: startPage
      }
      result.value = summarizeGames(String(user.uid), [...games.values()], false, user)

      if (cached.complete && Date.now() - Number(cached.updatedAt || 0) < completeCacheLifetime) {
        return
      }
      if (cached.complete) {
        games.clear()
        startPage = 1
      }
    }

    for (let batchStart = startPage; batchStart <= maxRecordPages; batchStart += recordBatchSize) {
      const batchPages = Array.from(
        { length: Math.min(recordBatchSize, maxRecordPages - batchStart + 1) },
        (_, index) => batchStart + index
      )
      const responses = await Promise.allSettled(batchPages.map(recordPage =>
        fetchRecordPage(user.uid, recordPage, signal)
      ))
      let reachedEnd = false
      const failedPages = []

      responses.forEach((settled, responseIndex) => {
        if (settled.status === 'rejected') {
          failedPages.push(batchPages[responseIndex])
          return
        }
        const response = settled.value
        const rows = Array.isArray(response?.data?.data) ? response.data.data : []
        if (!rows.length) reachedEnd = true
        rows.forEach((game, index) => {
          const sourcePage = batchPages[responseIndex]
          games.set(String(game.gameid || `${sourcePage}-${index}`), game)
        })
      })

      const nextPage = failedPages.length ? Math.min(...failedPages) : batchPages.at(-1) + 1
      loadingProgress.value = {
        pages: batchPages.at(-1),
        records: games.size,
        resumed: loadingProgress.value.resumed,
        nextPage
      }
      result.value = summarizeGames(
        String(user.uid),
        [...games.values()],
        false,
        user
      )
      await writeQueryCache({
        userId: String(user.uid),
        user,
        games: [...games.values()],
        nextPage,
        complete: reachedEnd && !failedPages.length,
        updatedAt: Date.now()
      })

      if (signal.aborted) throw new DOMException('查询已取消', 'AbortError')
      if (failedPages.length) {
        throw new Error(`第 ${failedPages.join('、')} 页暂时读取失败，已保存进度；重新选择该用户可继续`)
      }
      if (reachedEnd) {
        completed = true
        break
      }
      if (batchPages.at(-1) === maxRecordPages) truncated = true
    }

    result.value = summarizeGames(
      String(user.uid),
      [...games.values()],
      truncated,
      user
    )
    if (completed) {
      await writeQueryCache({
        userId: String(user.uid),
        user,
        games: [...games.values()],
        nextPage: loadingProgress.value.pages + 1,
        complete: true,
        updatedAt: Date.now()
      })
    }
  } catch (requestError) {
    if (requestError.name !== 'AbortError') {
      error.value = requestError.message || '无法读取开球网数据，请检查网络后重试'
    }
  } finally {
    if (activeRecordController?.signal === signal) {
      loading.value = false
      activeRecordController = null
    }
  }
}

function buildStatRow(label, records) {
  return {
    label,
    total: records.length,
    wins: records.filter(record => record.outcome === 'win').length,
    losses: records.filter(record => record.outcome === 'loss').length
  }
}

function numberValue(value) {
  const text = String(value ?? '').replace('+', '').trim()
  if (!text || text === '-') return null
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function isSettledScoreChange(value) {
  return numberValue(value) !== null
}

function avatarUrl(userId) {
  const padded = String(userId || '').padStart(8, '0')
  return `https://oss.kaiqiu.cc/avatar/000/${padded.slice(2, 4)}/${padded.slice(4, 6)}/${padded.slice(6, 8)}_avatar_big.jpg`
}

function playerName(value) {
  const name = String(value ?? '').trim()
  return name && name !== '0' ? name : ''
}

function summarizeGames(userId, games, truncated, user) {
  let wins = 0
  let losses = 0
  let draws = 0
  let userName = user.realname || user.username2 || ''

  const records = games.map(game => {
    const first = userId === String(game.uid1 || '') || userId === String(game.uid11 || '')
    const teammatePosition = userId === String(first ? game.uid11 : game.uid22)
    const selfResult = Number(first ? game.result1 : game.result2) || 0
    const opponentResult = Number(first ? game.result2 : game.result1) || 0
    const primaryName = playerName(first ? game.username1 : game.username2)
    const secondaryName = playerName(first ? game.username11 : game.username22)
    const selfName = teammatePosition ? secondaryName : primaryName
    const teammateName = teammatePosition ? primaryName : secondaryName
    const outcome = selfResult > opponentResult ? 'win' : selfResult < opponentResult ? 'loss' : 'draw'

    if (!userName && selfName) userName = selfName
    if (outcome === 'win') wins += 1
    else if (outcome === 'loss') losses += 1
    else draws += 1

    return {
      gameId: String(game.gameid || ''),
      eventId: String(game.eventid || ''),
      date: game.dateline || '',
      selfName: selfName || '',
      teammateName: teammateName || '',
      opponentName: playerName(first ? game.username2 : game.username1),
      opponentTeammateName: playerName(first ? game.username22 : game.username11),
      scoreLine: `${selfResult}:${opponentResult}`,
      scoreChange: first ? game.score1 : game.score2,
      outcome,
      doubles: (game.uid11 && String(game.uid11) !== '0') || (game.uid22 && String(game.uid22) !== '0')
    }
  })

  return {
    userId,
    userName,
    nickname: user.username2 || '',
    currentScore: user.score || '',
    maxScore: user.maxscore || '',
    annualScore: user.maxScoreTheYear || '',
    total: records.length,
    wins,
    losses,
    draws,
    truncated,
    records
  }
}

function location(user) {
  return [user.resideprovince, user.residecity].filter(Boolean).join(' · ') || '地区未知'
}

function teamName(primary, teammate) {
  return teammate ? `${primary || '-'} / ${teammate}` : (primary || '-')
}

function changePage(next) {
  page.value = Math.min(totalPages.value, Math.max(1, next))
  document.querySelector('.records')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <main>
    <section class="hero">
      <h1>查询选手战绩</h1>

      <form class="search" @submit.prevent="searchUsers">
        <div class="search-row">
          <input id="keyword" v-model="keyword" type="search" autocomplete="off" placeholder="请输入姓名或昵称" :disabled="searchingUsers">
          <button :disabled="searchingUsers">{{ searchingUsers ? '搜索中…' : '查询' }}</button>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </form>
    </section>

      <section v-if="candidates.length" class="candidates">
      <div class="section-head candidate-head">
        <h2>选择选手</h2>
        <span>找到 {{ candidates.length }} 位</span>
      </div>
      <div class="candidate-grid">
        <button v-for="user in candidates" :key="user.uid" class="candidate" @click="selectUser(user)">
          <span class="avatar">
            <span>{{ (user.realname || user.username2 || '?').slice(0, 1) }}</span>
            <img :src="avatarUrl(user.uid)" alt="" @error="$event.currentTarget.style.display = 'none'">
          </span>
          <span class="candidate-info">
            <strong>{{ user.realname || '未填写姓名' }}</strong>
            <small>昵称：{{ user.username2 || '未填写' }}</small>
            <small>{{ location(user) }} · ID {{ user.uid }}</small>
          </span>
          <span class="candidate-score">{{ user.score || '-' }}<small>积分</small></span>
        </button>
      </div>
      <p v-if="candidatesTruncated" class="candidate-tip">结果较多，仅展示前 50 位，请输入更完整的姓名或昵称缩小范围。</p>
      </section>

      <section v-else-if="hasSearchedUsers && !searchingUsers && !result && !error" class="empty candidates-empty">
      没有找到匹配的选手，请尝试其他姓名或昵称
      </section>

      <section v-if="loading" class="loading-card">
      <span class="ball"></span>
      <div>
        <strong>{{ loadingProgress.records ? `已读取 ${loadingProgress.records} 场，继续加载中` : `正在读取 ${keyword} 的战绩` }}</strong>
        <p>{{ loadingProgress.resumed ? `已从缓存恢复，将从第 ${loadingProgress.pages + 1} 页继续` : '每批完成即展示，失败会自动重试并保存进度。' }}</p>
      </div>
      </section>

      <template v-if="result">
      <section v-if="error && selectedUser && !loading" class="resume-card">
        <div>
          <strong>第 {{ loadingProgress.nextPage }} 页读取失败</strong>
          <p>已读取的 {{ loadingProgress.records }} 场不会丢失。</p>
        </div>
        <button type="button" @click="selectUser(selectedUser)">继续加载</button>
      </section>

      <section class="summary">
        <div class="player">
          <div class="profile-avatar">
            <span>{{ (result.userName || '?').slice(0, 1) }}</span>
            <img :src="avatarUrl(result.userId)" alt="" @error="$event.currentTarget.style.display = 'none'">
          </div>
          <h2>{{ result.userName || `用户 ${result.userId}` }}<small v-if="result.nickname && result.nickname !== result.userName">{{ result.nickname }}</small></h2>
          <p>ID {{ result.userId }}</p>
        </div>
        <div class="score-overview">
          <div><span>当前积分</span><strong>{{ result.currentScore || '-' }}</strong></div>
          <button type="button" class="annual-score" @click="annualDetail = 'overview'; annualScoreOpen = true">
            <span>年度积分 <i>?</i></span><strong>{{ result.annualScore || '-' }}</strong>
          </button>
          <div><span>历史最高</span><strong>{{ result.maxScore || '-' }}</strong></div>
        </div>
        <div class="scope-bar">
          <span>比赛统计</span>
          <div class="scope-tabs" aria-label="统计时间范围">
            <button :class="{ active: statScope === 'all' }" @click="statScope = 'all'">全部</button>
            <button :class="{ active: statScope === 'year' }" @click="statScope = 'year'">近一年</button>
          </div>
        </div>
        <div class="stats-head"><span>类型</span><span>总数</span><span>胜场</span><span>败场</span></div>
        <div v-for="row in statRows" :key="row.label" class="stats-row">
          <strong>{{ row.label }}</strong>
          <b>{{ row.total }}</b>
          <b class="positive">{{ row.wins }}</b>
          <b class="negative">{{ row.losses }}</b>
        </div>
        <div v-if="trendChart" class="score-trend">
          <div class="trend-heading">
            <h3>{{ result.userName }}{{ statScope === 'year' ? '近一年' : '全部' }}单打积分趋势</h3>
            <span>{{ trendChart.recordCount }} 场{{ loading ? ' · 加载中' : '' }}</span>
          </div>
          <svg
            :viewBox="`0 0 ${trendChart.width} ${trendChart.height}`"
            role="img"
            :aria-label="`${result.userName}${statScope === 'year' ? '近一年' : '全部'}单打积分趋势`"
          >
            <g class="trend-grid">
              <g v-for="tick in trendChart.yTicks" :key="tick.value">
                <line
                  :x1="trendChart.left"
                  :x2="trendChart.width - trendChart.right"
                  :y1="tick.y"
                  :y2="tick.y"
                />
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
                <line
                  :x1="tick.x"
                  :x2="tick.x"
                  :y1="trendChart.height - trendChart.bottom"
                  :y2="trendChart.height - trendChart.bottom + 5"
                />
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
        <p class="updated-at">数据更新于 {{ new Date().toLocaleDateString('zh-CN') }}</p>
      </section>

      <div v-if="annualScoreOpen" class="dialog-backdrop" @click.self="annualScoreOpen = false">
        <section class="annual-dialog" role="dialog" aria-modal="true" aria-label="年度积分计算说明">
          <button class="dialog-close" aria-label="关闭" @click="annualScoreOpen = false">×</button>

          <template v-if="annualDetail === 'overview'">
            <h2>年度积分怎么算？</h2>
            <p class="annual-formula">年度最高 + 大额输分调整 − 参赛扣减 + 官方修正</p>
            <div v-if="annualAnalysis" class="formula-grid">
              <button class="metric-help" type="button" @click="showAnnualDetail('peak')">近一年单打最高 <i>?</i></button>
              <b>{{ annualAnalysis.peak ?? '-' }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'loss'">大额输分调整 <i>?</i></button>
              <b>{{ annualAnalysis.adjustment ?? '人工审核' }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'deduction'">参赛扣减 <i>?</i></button>
              <b>−{{ annualAnalysis.deduction }}</b>
              <button class="metric-help" type="button" @click="annualDetail = 'correction'">官方修正 <i>?</i></button>
              <b>{{ annualAnalysis.correction ?? '-' }}</b>
              <span>官网年度积分</span><strong>{{ result.annualScore || '-' }}</strong>
            </div>
          </template>

          <template v-else-if="annualDetail === 'peak'">
            <button class="dialog-back" type="button" @click="annualDetail = 'overview'">‹ 返回年度积分</button>
            <h2>近一年单打最高</h2>
            <p v-if="annualAnalysis?.peakRecord" class="detail-intro">
              <span>比赛日期：{{ annualAnalysis.peakRecord.date }}</span>
              <span>比赛名称：{{ eventTitles[annualAnalysis.peakRecord.eventId] || '加载中…' }}</span>
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
                    <td>{{ teamName(record.selfName || result.userName, record.teammateName) }}</td>
                    <td>
                      <strong>{{ teamName(record.opponentName, record.opponentTeammateName) }}</strong>
                      <small v-if="record.gameId === annualAnalysis.peakRecord.gameId">最高</small>
                    </td>
                    <td><strong class="score">{{ record.scoreLine }}</strong></td>
                    <td>{{ record.scoreChange }}</td>
                    <td>{{ record.after }}</td>
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
                    <td>{{ teamName(record.selfName || result.userName, record.teammateName) }}</td>
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
              <div class="deduction-track">
                <i v-for="tick in 8" :key="tick"></i>
              </div>
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

      <p v-if="result.truncated" class="warning">记录超过页面读取上限，当前展示的是已读取部分。</p>

      <section class="records">
        <div class="section-head">
          <h2>交手记录</h2>
          <span>{{ loading ? `已加载 ${scopedRecords.length} 场` : `共 ${scopedRecords.length} 场` }}</span>
        </div>

        <div v-if="visibleRecords.length" class="table-wrap">
          <table>
            <thead><tr><th>序号</th><th>我方</th><th>敌方</th><th>比分</th><th>变化</th><th>日期</th></tr></thead>
            <tbody>
              <tr v-for="(record, index) in visibleRecords" :key="record.gameId">
                <td>{{ (page - 1) * pageSize + index + 1 }}</td>
                <td>{{ teamName(record.selfName || result.userName, record.teammateName) }}</td>
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
    </template>

      <section class="versus-hero">
        <h1>双方胜率预测</h1>
        <p>输入两名选手，预测单打胜率</p>
      </section>

      <section class="versus-selectors">
        <div v-for="side in [0, 1]" :key="side" class="versus-side">
          <div class="versus-side-title">
            <b>{{ side === 0 ? '选手 A' : '选手 B' }}</b>
            <button
              v-if="versusSelected[side]"
              type="button"
              @click="resetVersusSide(side)"
            >重选</button>
          </div>
          <div v-if="versusSelected[side]" class="selected-player">
            <span class="avatar">
              <span>{{ (versusSelected[side].realname || versusSelected[side].username2 || '?').slice(0, 1) }}</span>
              <img :src="avatarUrl(versusSelected[side].uid)" alt="" @error="$event.currentTarget.style.display = 'none'">
            </span>
            <span>
              <strong>{{ versusSelected[side].realname || '未填写姓名' }}</strong>
              <small>{{ versusSelected[side].username2 || '未填写昵称' }} · {{ versusSelected[side].score || '-' }} 分</small>
            </span>
          </div>
          <form v-else class="search versus-search" @submit.prevent="searchVersusUser(side)">
            <div class="search-row">
              <input
                v-model="versusKeywords[side]"
                type="search"
                autocomplete="off"
                placeholder="输入姓名或昵称"
                :disabled="versusSearching[side]"
              >
              <button :disabled="versusSearching[side]">{{ versusSearching[side] ? '搜索中' : '查询' }}</button>
            </div>
          </form>
          <div v-if="versusCandidates[side].length" class="candidate-grid compact-candidates">
            <button
              v-for="user in versusCandidates[side]"
              :key="user.uid"
              class="candidate"
              type="button"
              @click="chooseVersusUser(side, user)"
            >
              <span class="avatar">
                <span>{{ (user.realname || user.username2 || '?').slice(0, 1) }}</span>
                <img :src="avatarUrl(user.uid)" alt="" @error="$event.currentTarget.style.display = 'none'">
              </span>
              <span class="candidate-info">
                <strong>{{ user.realname || '未填写姓名' }}</strong>
                <small>{{ user.username2 || '未填写昵称' }} · ID {{ user.uid }}</small>
              </span>
              <span class="candidate-score">{{ user.score || '-' }}<small>积分</small></span>
            </button>
          </div>
        </div>
        <p v-if="versusError" class="error versus-error">{{ versusError }}</p>
      </section>

      <section v-if="versusLoading" class="loading-card">
        <span class="ball"></span>
        <div>
          <strong>已读取 {{ versusProgress.records }} 场，正在查找直接交手</strong>
          <p>预测结果会随着历史数据加载动态更新</p>
        </div>
      </section>

      <section v-if="versusPrediction" class="prediction">
        <div class="prediction-title">
          <h2>预测结果</h2>
          <span>{{ versusLoading ? '加载中' : '统计完成' }}</span>
        </div>
        <div class="probability-names">
          <strong>{{ versusSelected[0].realname || versusSelected[0].username2 }}</strong>
          <b>VS</b>
          <strong>{{ versusSelected[1].realname || versusSelected[1].username2 }}</strong>
        </div>
        <div class="probability-values">
          <strong>{{ versusPrediction.percentageA }}%</strong>
          <strong>{{ versusPrediction.percentageB }}%</strong>
        </div>
        <div class="probability-bar">
          <i :style="{ width: `${versusPrediction.percentageA}%` }"></i>
        </div>

        <h3>预测过程</h3>
        <p class="prediction-reasoning">{{ versusPrediction.reasoningText }}</p>

        <div class="section-head direct-head">
          <h2>历史单打交手</h2>
          <span>共 {{ versusPrediction.total }} 场</span>
        </div>
        <div v-if="versusPrediction.records.length" class="table-wrap versus-table">
          <table>
            <thead><tr><th>序号</th><th>选手 A</th><th>选手 B</th><th>比分</th><th>日期</th></tr></thead>
            <tbody>
              <tr v-for="(record, index) in versusPrediction.records" :key="record.gameId">
                <td>{{ index + 1 }}</td>
                <td :class="{ winner: record.winner === 'A' }">{{ record.playerA }}</td>
                <td :class="{ winner: record.winner === 'B' }">{{ record.playerB }}</td>
                <td><strong>{{ record.scoreLine }}</strong></td>
                <td>{{ record.date || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">当前没有查询到双方直接单打记录</div>
        <button v-if="versusError && !versusLoading" class="continue-button" type="button" @click="loadVersusHistory">继续读取</button>
      </section>
  </main>
</template>
