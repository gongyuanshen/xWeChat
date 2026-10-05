/* WeChatDataAnalysis export UI, recovered from the bundled wce_integrity.pyd.
 * Adapted for independent xwechat exports: no signature or brand verification.
 * See sources.json for provenance. Existing UI behavior is retained. */
(() => {
  const updateDprVar = () => {
    try {
      document.documentElement.style.setProperty('--dpr', '1')
    } catch {}
  }

  const hideJsMissingBanner = () => {
    try {
      const el = document.getElementById('wceJsMissing')
      if (el) el.style.display = 'none'
    } catch {}
  }

  const initSessionSearch = () => {
    const input = document.getElementById('sessionSearchInput')
    if (!input) return

    const clearBtn = document.getElementById('sessionSearchClear')
    const items = Array.from(document.querySelectorAll('[data-wce-session-item=\"1\"]'))

    const apply = () => {
      const q = String(input.value || '').trim().toLowerCase()
      try { if (clearBtn) clearBtn.style.display = q ? '' : 'none' } catch {}

      items.forEach((el) => {
        if (!el) return
        const isActive = String(el.getAttribute('aria-current') || '') === 'page'
        const name = String(el.getAttribute('data-wce-session-name') || '').toLowerCase()
        const username = String(el.getAttribute('data-wce-session-username') || '').toLowerCase()
        const show = !q || isActive || name.includes(q) || username.includes(q)
        try { el.style.display = show ? '' : 'none' } catch {}
      })
    }

    input.addEventListener('input', apply)
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        try { input.value = '' } catch {}
        try { input.focus() } catch {}
        apply()
      })
    }
    apply()
  }

  const initVoicePlayback = () => {
    let activeAudio = null
    let activeIcon = null

    const stopAudio = (audio, icon) => {
      if (!audio) return
      try { audio.pause() } catch {}
      try { audio.currentTime = 0 } catch {}
      try { if (icon) icon.classList.remove('voice-playing') } catch {}
    }

    const bindAudioEnd = (audio) => {
      if (!audio) return
      try {
        if (audio.dataset && audio.dataset.wceVoiceBound === '1') return
        if (audio.dataset) audio.dataset.wceVoiceBound = '1'
      } catch {}

      try {
        audio.addEventListener('ended', () => {
          try {
            const wrapper = audio.closest('.wechat-voice-wrapper') || audio.parentElement
            const icon = wrapper ? wrapper.querySelector('.wechat-voice-icon') : null
            if (icon) icon.classList.remove('voice-playing')
          } catch {}

          if (activeAudio === audio) {
            activeAudio = null
            activeIcon = null
          }
        })
      } catch {}
    }

    document.addEventListener('click', (ev) => {
      const target = ev && ev.target

      const quoteBtn = target && target.closest ? target.closest('[data-wce-quote-voice-btn=\"1\"]') : null
      if (quoteBtn) {
        if (quoteBtn.hasAttribute && quoteBtn.hasAttribute('disabled')) return

        const wrapper = quoteBtn.closest ? (quoteBtn.closest('[data-wce-quote-voice-wrapper=\"1\"]') || quoteBtn.parentElement) : quoteBtn.parentElement
        if (!wrapper) return

        const audio = wrapper.querySelector ? (wrapper.querySelector('audio[data-wce-quote-voice-audio=\"1\"]') || wrapper.querySelector('audio')) : null
        if (!audio) return

        bindAudioEnd(audio)

        const icon = (quoteBtn.querySelector && quoteBtn.querySelector('.wechat-voice-icon')) || (wrapper.querySelector && wrapper.querySelector('.wechat-voice-icon'))

        if (activeAudio && activeAudio !== audio) stopAudio(activeAudio, activeIcon)

        const isPlaying = !audio.paused && !audio.ended
        if (activeAudio === audio && isPlaying) {
          stopAudio(audio, icon)
          activeAudio = null
          activeIcon = null
          return
        }

        activeAudio = audio
        activeIcon = icon
        try { if (icon) icon.classList.add('voice-playing') } catch {}
        try {
          const p = audio.play()
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              stopAudio(audio, icon)
              if (activeAudio === audio) {
                activeAudio = null
                activeIcon = null
              }
            })
          }
        } catch {
          stopAudio(audio, icon)
          if (activeAudio === audio) {
            activeAudio = null
            activeIcon = null
          }
        }
        return
      }

      const bubble = target && target.closest ? target.closest('.wechat-voice-bubble') : null
      if (!bubble) return

      const wrapper = bubble.closest('.wechat-voice-wrapper') || bubble.parentElement
      if (!wrapper) return

      const audio = wrapper.querySelector('audio')
      if (!audio) return

      bindAudioEnd(audio)

      const icon = bubble.querySelector('.wechat-voice-icon') || wrapper.querySelector('.wechat-voice-icon')

      if (activeAudio && activeAudio !== audio) stopAudio(activeAudio, activeIcon)

      const isPlaying = !audio.paused && !audio.ended
      if (activeAudio === audio && isPlaying) {
        stopAudio(audio, icon)
        activeAudio = null
        activeIcon = null
        return
      }

      activeAudio = audio
      activeIcon = icon
      try { if (icon) icon.classList.add('voice-playing') } catch {}
      try {
        const p = audio.play()
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            stopAudio(audio, icon)
            if (activeAudio === audio) {
              activeAudio = null
              activeIcon = null
            }
          })
        }
      } catch {
        stopAudio(audio, icon)
        if (activeAudio === audio) {
          activeAudio = null
          activeIcon = null
        }
      }
    })
  }

  const updateVisibleTimeDividers = () => {
    const list = document.getElementById('wceMessageList') || document.getElementById('messageContainer')
    if (!list) return

    let currentDivider = null
    let groupHasVisibleMessage = false

    const flush = () => {
      if (!currentDivider) return
      try { currentDivider.style.display = groupHasVisibleMessage ? '' : 'none' } catch {}
    }

    const children = Array.from(list.children || [])
    children.forEach((el) => {
      if (!el) return
      if (String(el.getAttribute && el.getAttribute('data-wce-time-divider') || '') === '1') {
        flush()
        currentDivider = el
        groupHasVisibleMessage = false
        return
      }
      if (el.hasAttribute && el.hasAttribute('data-render-type')) {
        const visible = String(el.style && el.style.display || '') !== 'none'
        if (visible) groupHasVisibleMessage = true
      }
    })
    flush()
  }

  const applyMessageTypeFilter = () => {
    const select = document.getElementById('messageTypeFilter')
    if (!select) return
    const selected = String(select.value || 'all')
    const nodes = document.querySelectorAll('[data-render-type]')
    nodes.forEach((el) => {
      const rt = String(el.getAttribute('data-render-type') || 'text')
      const show = selected === 'all' ? true : rt === selected
      el.style.display = show ? '' : 'none'
    })
    try { updateVisibleTimeDividers() } catch {}
  }

  const scrollToBottom = () => {
    const container = document.getElementById('messageContainer')
    if (!container) return
    container.scrollTop = container.scrollHeight
  }

  const updateSessionMessageCount = () => {
    const el = document.getElementById('sessionMessageCount')
    const container = document.getElementById('messageContainer')
    if (!el || !container) return
    const items = container.querySelectorAll('[data-render-type]')
    el.textContent = String(items.length)
  }

  const ensureAllMessagePagesLoaded = async (statusEl) => {
    try {
      const loadedAll = typeof window.__WCE_ARE_ALL_PAGES_LOADED__ === 'function' ? window.__WCE_ARE_ALL_PAGES_LOADED__() : true
      const loader = window.__WCE_LOAD_ALL_PAGES__
      if (loadedAll || typeof loader !== 'function') return true
      if (statusEl) statusEl.textContent = '加载分页…'
      const ok = await loader()
      try { applyMessageTypeFilter() } catch {}
      try { updateSessionMessageCount() } catch {}
      if (!ok && statusEl) statusEl.textContent = '分页加载失败'
      return !!ok
    } catch {
      if (statusEl) statusEl.textContent = '分页加载失败'
      return false
    }
  }

  const getVisibleMessageNodes = () => {
    const list = document.getElementById('wceMessageList') || document.getElementById('messageContainer')
    if (!list) return []
    return Array.from(list.querySelectorAll('[data-render-type]') || []).filter((el) => {
      try { return String(el.style && el.style.display || '') !== 'none' } catch { return true }
    })
  }

  const scrollToMessageNode = (el) => {
    if (!el) return
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {
      try { el.scrollIntoView(true) } catch {}
    }
  }

  const clearSearchMarks = () => {
    try {
      document.querySelectorAll('.wce-search-hit,.wce-search-current').forEach((el) => {
        try {
          el.classList.remove('wce-search-hit')
          el.classList.remove('wce-search-current')
        } catch {}
      })
    } catch {}
  }

  const initMessageSearchAndDateJump = () => {
    const searchInput = document.getElementById('wceMessageSearchInput')
    const searchBtn = document.getElementById('wceMessageSearchBtn')
    const prevBtn = document.getElementById('wceMessageSearchPrev')
    const nextBtn = document.getElementById('wceMessageSearchNext')
    const searchStatus = document.getElementById('wceMessageSearchStatus')
    const dateInput = document.getElementById('wceDateJumpInput')
    const dateBtn = document.getElementById('wceDateJumpBtn')
    const dateStatus = document.getElementById('wceDateJumpStatus')
    const state = { query: '', hits: [], index: -1 }

    const setSearchStatus = (text) => {
      try { if (searchStatus) searchStatus.textContent = String(text || '') } catch {}
    }
    const setDateStatus = (text) => {
      try { if (dateStatus) dateStatus.textContent = String(text || '') } catch {}
    }
    const updateSearchButtons = () => {
      const disabled = !state.hits.length
      try { if (prevBtn) prevBtn.disabled = disabled } catch {}
      try { if (nextBtn) nextBtn.disabled = disabled } catch {}
    }

    const focusSearchHit = (idx) => {
      if (!state.hits.length) {
        updateSearchButtons()
        return
      }
      state.index = ((idx % state.hits.length) + state.hits.length) % state.hits.length
      state.hits.forEach((el, i) => {
        try {
          el.classList.toggle('wce-search-current', i === state.index)
          el.classList.add('wce-search-hit')
        } catch {}
      })
      const current = state.hits[state.index]
      scrollToMessageNode(current)
      setSearchStatus(`${state.index + 1}/${state.hits.length}`)
      updateSearchButtons()
    }

    const runSearch = async () => {
      const q = String(searchInput ? searchInput.value : '').trim().toLowerCase()
      clearSearchMarks()
      state.query = q
      state.hits = []
      state.index = -1
      updateSearchButtons()
      if (!q) {
        setSearchStatus('')
        return
      }
      await ensureAllMessagePagesLoaded(searchStatus)
      const nodes = getVisibleMessageNodes()
      state.hits = nodes.filter((el) => String(el.textContent || '').toLowerCase().includes(q))
      if (!state.hits.length) {
        setSearchStatus('无结果')
        return
      }
      focusSearchHit(0)
    }

    const jumpDate = async () => {
      const target = String(dateInput ? dateInput.value : '').trim()
      if (!target) {
        setDateStatus('')
        return
      }
      await ensureAllMessagePagesLoaded(dateStatus)
      const nodes = getVisibleMessageNodes()
      let exact = null
      let nearest = null
      for (const el of nodes) {
        const d = String(el.getAttribute('data-wce-date') || '').trim()
        if (!d) continue
        if (d === target) {
          exact = el
          break
        }
        if (!nearest && d > target) nearest = el
      }
      const found = exact || nearest
      if (!found) {
        setDateStatus('无消息')
        return
      }
      try {
        found.classList.add('wce-date-located')
        setTimeout(() => {
          try { found.classList.remove('wce-date-located') } catch {}
        }, 1400)
      } catch {}
      scrollToMessageNode(found)
      setDateStatus(exact ? '已定位' : '最近之后')
    }

    if (searchBtn) searchBtn.addEventListener('click', () => { runSearch() })
    if (searchInput) {
      searchInput.addEventListener('keydown', (ev) => {
        if (String(ev?.key || '') !== 'Enter') return
        try { ev.preventDefault() } catch {}
        runSearch()
      })
      searchInput.addEventListener('input', () => {
        if (!String(searchInput.value || '').trim()) {
          clearSearchMarks()
          state.query = ''
          state.hits = []
          state.index = -1
          setSearchStatus('')
          updateSearchButtons()
        }
      })
    }
    if (prevBtn) prevBtn.addEventListener('click', () => focusSearchHit(state.index - 1))
    if (nextBtn) nextBtn.addEventListener('click', () => focusSearchHit(state.index + 1))
    if (dateBtn) dateBtn.addEventListener('click', () => { jumpDate() })
    if (dateInput) {
      dateInput.addEventListener('keydown', (ev) => {
        if (String(ev?.key || '') !== 'Enter') return
        try { ev.preventDefault() } catch {}
        jumpDate()
      })
    }

    updateSearchButtons()
  }

  const safeJsonParse = (text) => {
    try { return JSON.parse(String(text || '')) } catch { return null }
  }

  const readMediaIndex = () => {
    const el = document.getElementById('wceMediaIndex')
    const obj = safeJsonParse(el ? el.textContent : '')
    if (!obj || typeof obj !== 'object') return {}
    return obj
  }

  const readPageMeta = () => {
    const el = document.getElementById('wcePageMeta')
    const obj = safeJsonParse(el ? el.textContent : '')
    if (!obj || typeof obj !== 'object') return null
    return obj
  }

  const initPagedMessageLoading = () => {
    const meta = readPageMeta()
    if (!meta) return

    const totalPages = Number(meta.totalPages || 0)
    if (!Number.isFinite(totalPages) || totalPages <= 1) return

    const initialPage = Number(meta.initialPage || totalPages || 1)
    const padWidth = Number(meta.padWidth || 0) || 0
    const prefix = String(meta.pageFilePrefix || 'pages/page-')
    const suffix = String(meta.pageFileSuffix || '.js')

    const container = document.getElementById('messageContainer')
    const list = document.getElementById('wceMessageList') || container
    const pager = document.getElementById('wcePager')
    const btn = document.getElementById('wceLoadPrevBtn')
    const status = document.getElementById('wceLoadPrevStatus')
    if (!container || !list || !pager || !btn) return

    try { pager.style.display = '' } catch {}

    const loaded = new Set()
    loaded.add(initialPage)
    let nextPage = initialPage - 1
    let loading = false
    const pendingPageLoads = new Map()

    const setStatus = (text) => {
      try { if (status) status.textContent = String(text || '') } catch {}
    }

    const updateUi = (overrideText) => {
      if (overrideText != null) {
        setStatus(overrideText)
        try { btn.disabled = false } catch {}
        return
      }
      if (nextPage < 1) {
        setStatus('已到底')
        try { btn.disabled = true } catch {}
        return
      }
      if (loading) {
        setStatus('加载中...')
        try { btn.disabled = true } catch {}
        return
      }
      setStatus('点击加载更早消息')
      try { btn.disabled = false } catch {}
    }

    const settlePageLoad = (pageNo, ok, errorText) => {
      const n = Number(pageNo)
      const pending = pendingPageLoads.get(n)
      if (pending) {
        try { pendingPageLoads.delete(n) } catch {}
        try { clearTimeout(pending.timer) } catch {}
      }
      loading = false
      if (ok) updateUi()
      else updateUi(errorText || '加载失败，可重试')
      if (pending) {
        try { pending.resolve(!!ok) } catch {}
      }
    }

    const pageSrc = (n) => {
      const num = padWidth > 0 ? String(n).padStart(padWidth, '0') : String(n)
      return prefix + num + suffix
    }

    window.__WCE_PAGE_QUEUE__ = window.__WCE_PAGE_QUEUE__ || []
    window.__WCE_PAGE_LOADED__ = (pageNo, html, seal) => {
      const n = Number(pageNo)
      if (!Number.isFinite(n) || n < 1) {
        settlePageLoad(n, false, '分页数据无效，可重试')
        return
      }
      if (loaded.has(n)) {
        settlePageLoad(n, true)
        return
      }
      let inserted = false
      try {
        const prevH = container.scrollHeight
        const prevTop = container.scrollTop
        list.insertAdjacentHTML('afterbegin', String(html || ''))
        inserted = true
        const newH = container.scrollHeight
        container.scrollTop = prevTop + (newH - prevH)
      } catch {
        try {
          list.insertAdjacentHTML('afterbegin', String(html || ''))
          inserted = true
        } catch {}
      }
      if (!inserted) {
        settlePageLoad(n, false, '分页渲染失败，可重试')
        return
      }

      loaded.add(n)
      nextPage = n - 1
      try { applyMessageTypeFilter() } catch {}
      try { updateSessionMessageCount() } catch {}
      settlePageLoad(n, true)
    }

    // Flush any queued pages (should be rare, but keeps behavior robust).
    try {
      const q = window.__WCE_PAGE_QUEUE__
      if (Array.isArray(q) && q.length) {
        const items = q.slice(0)
        q.length = 0
        items.forEach((it) => {
          try {
            if (it && it.length >= 2) window.__WCE_PAGE_LOADED__(it[0], it[1], it[2])
          } catch {}
        })
      }
    } catch {}

    // Historical pages are loaded on demand; ZIP checksums are verified by the importer.
    const requestLoadPage = (pageNumber) => new Promise((resolve) => {
      const n = Number(pageNumber)
      if (!Number.isFinite(n) || n < 1) {
        resolve(false)
        return
      }
      if (loaded.has(n)) {
        resolve(true)
        return
      }
      if (loading) {
        const wait = () => {
          if (!loading) requestLoadPage(n).then(resolve)
          else setTimeout(wait, 60)
        }
        wait()
        return
      }

      loading = true
      updateUi()
      const pending = { resolve, timer: 0 }
      pendingPageLoads.set(n, pending)
      pending.timer = setTimeout(() => {
        if (pendingPageLoads.has(n)) settlePageLoad(n, false, '加载超时，可重试')
      }, 15000)

      const s = document.createElement('script')
      s.async = true
      s.src = pageSrc(n)
      s.onerror = () => {
        settlePageLoad(n, false, '加载失败，可重试')
      }
      s.onload = () => {
        setTimeout(() => {
          if (pendingPageLoads.has(n)) settlePageLoad(n, false, '分页脚本未响应，可重试')
        }, 0)
      }
      try { document.body.appendChild(s) } catch {
        settlePageLoad(n, false, '加载失败，可重试')
      }
    })

    const requestLoad = () => {
      if (loading) return
      if (nextPage < 1) return
      requestLoadPage(nextPage)
    }

    window.__WCE_LOAD_ALL_PAGES__ = async () => {
      while (nextPage >= 1) {
        const ok = await requestLoadPage(nextPage)
        if (!ok) return false
      }
      return true
    }
    window.__WCE_ARE_ALL_PAGES_LOADED__ = () => nextPage < 1

    btn.addEventListener('click', () => requestLoad())

    let lastScrollAt = 0
    container.addEventListener('scroll', () => {
      const now = Date.now()
      if (now - lastScrollAt < 200) return
      lastScrollAt = now
      if (container.scrollTop < 120) requestLoad()
    })

    updateUi()
  }

  const isMaybeMd5 = (value) => /^[0-9a-f]{32}$/i.test(String(value || '').trim())
  const pickFirstMd5 = (...values) => {
    for (const v of values) {
      const s = String(v || '').trim()
      if (isMaybeMd5(s)) return s.toLowerCase()
    }
    return ''
  }

  const normalizeChatHistoryUrl = (value) => String(value || '').trim().replace(/\s+/g, '')

  const decodeBase64Utf8 = (b64) => {
    try {
      const bin = atob(String(b64 || ''))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      }
      let out = ''
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
      return out
    } catch {
      return ''
    }
  }

  const resolveMediaMd5 = (index, kind, md5) => {
    const key = String(md5 || '').trim().toLowerCase()
    if (!key) return ''
    const mapNames = {
      preview: ['images', 'emojis', 'videoThumbs'],
      image: ['images', 'videoThumbs'],
      emoji: ['emojis', 'images'],
      video: ['videos'],
      videoThumb: ['videoThumbs', 'images'],
      file: ['files'],
    }
    const maps = (mapNames[String(kind || '')] || []).map((name) => index && index[name])
    for (const m of maps) {
      try {
        if (m && m[key]) return String(m[key] || '')
      } catch {}
    }
    return ''
  }

  const resolveServerMd5 = (index, serverId) => {
    const key = String(serverId || '').trim()
    if (!key) return ''
    try {
      const v = index && index.serverMd5 && index.serverMd5[key]
      return isMaybeMd5(v) ? String(v || '').trim().toLowerCase() : ''
    } catch {}
    return ''
  }

  const resolveRemoteAny = (index, ...urls) => {
    for (const u0 of urls) {
      const u = normalizeChatHistoryUrl(u0)
      if (!u) continue
      try {
        const local = index && index.remote && index.remote[u]
        if (local) return String(local || '')
      } catch {}
    }
    return ''
  }

  const parseChatHistoryRecord = (recordItemXml) => {
    const xml = String(recordItemXml || '').trim()
    if (!xml) return { info: null, items: [] }

    const normalized = xml
      .replace(/&#x20;/g, ' ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, '&amp;')

    let doc
    try {
      doc = new DOMParser().parseFromString(normalized, 'text/xml')
    } catch {
      return { info: null, items: [] }
    }

    const parserErrors = doc.getElementsByTagName('parsererror')
    if (parserErrors && parserErrors.length) return { info: null, items: [] }

    const getText = (node, tag) => {
      try {
        if (!node) return ''
        const els = Array.from(node.getElementsByTagName(tag) || [])
        const direct = els.find((el) => el && el.parentNode === node)
        const el = direct || els[0]
        return String(el?.textContent || '').trim()
      } catch {
        return ''
      }
    }

    const getDirectChildXml = (node, tag) => {
      try {
        if (!node) return ''
        const children = Array.from(node.children || [])
        const el = children.find((c) => String(c?.tagName || '').toLowerCase() === String(tag || '').toLowerCase())
        if (!el) return ''

        const raw = String(el.textContent || '').trim()
        if (raw && raw.startsWith('<') && raw.endsWith('>')) return raw

        if (typeof XMLSerializer !== 'undefined') {
          return new XMLSerializer().serializeToString(el)
        }
      } catch {}
      return ''
    }

    const getAnyXml = (node, tag) => {
      try {
        if (!node) return ''
        const els = Array.from(node.getElementsByTagName(tag) || [])
        const direct = els.find((el) => el && el.parentNode === node)
        const el = direct || els[0]
        if (!el) return ''

        const raw = String(el.textContent || '').trim()
        if (raw && raw.startsWith('<') && raw.endsWith('>')) return raw
        if (typeof XMLSerializer !== 'undefined') return new XMLSerializer().serializeToString(el)
      } catch {}
      return ''
    }

    const sameTag = (el, tag) => String(el?.tagName || '').toLowerCase() === String(tag || '').toLowerCase()

    const closestAncestorByTag = (node, tag) => {
      const lower = String(tag || '').toLowerCase()
      let cur = node
      while (cur) {
        if (cur.nodeType === 1 && String(cur.tagName || '').toLowerCase() === lower) return cur
        cur = cur.parentNode
      }
      return null
    }

    const root = doc?.documentElement
    const isChatRoom = String(getText(root, 'isChatRoom') || '').trim() === '1'
    const title = getText(root, 'title')
    const desc = getText(root, 'desc') || getText(root, 'info')

    const datalist = (() => {
      try {
        const all = Array.from(doc.getElementsByTagName('datalist') || [])
        const top = root ? all.find((el) => closestAncestorByTag(el, 'recorditem') === root) : null
        return top || all[0] || null
      } catch {
        return null
      }
    })()

    const itemNodes = (() => {
      if (datalist) return Array.from(datalist.children || []).filter((el) => sameTag(el, 'dataitem'))
      return Array.from(root?.children || []).filter((el) => sameTag(el, 'dataitem'))
    })()

    const parsed = itemNodes.map((node, idx) => {
      const datatype = String(node.getAttribute('datatype') || getText(node, 'datatype') || '').trim()
      const dataid = String(node.getAttribute('dataid') || getText(node, 'dataid') || '').trim() || String(idx)

      const sourcename = getText(node, 'sourcename')
      const sourcetime = getText(node, 'sourcetime')
      const sourceheadurl = normalizeChatHistoryUrl(getText(node, 'sourceheadurl'))
      const datatitle = getText(node, 'datatitle')
      const datadesc = getText(node, 'datadesc')
      const link = normalizeChatHistoryUrl(getText(node, 'link') || getText(node, 'dataurl') || getText(node, 'url'))
      const datafmt = getText(node, 'datafmt')
      const duration = getText(node, 'duration')

      const fullmd5 = getText(node, 'fullmd5')
      const thumbfullmd5 = getText(node, 'thumbfullmd5')
      const md5 = getText(node, 'md5') || getText(node, 'emoticonmd5') || getText(node, 'emojimd5') || getText(node, 'emojiMd5')
      const cdnthumbmd5 = getText(node, 'cdnthumbmd5')
      const cdnurlstring = normalizeChatHistoryUrl(getText(node, 'cdnurlstring'))
      const encrypturlstring = normalizeChatHistoryUrl(getText(node, 'encrypturlstring'))
      const externurl = normalizeChatHistoryUrl(getText(node, 'externurl'))
      const aeskey = getText(node, 'aeskey')
      const fromnewmsgid = getText(node, 'fromnewmsgid')
      const srcMsgLocalid = getText(node, 'srcMsgLocalid')
      const srcMsgCreateTime = getText(node, 'srcMsgCreateTime')
      const nestedRecordItem = (
        getAnyXml(node, 'recorditem')
        || getDirectChildXml(node, 'recorditem')
        || getText(node, 'recorditem')
        || getAnyXml(node, 'recordxml')
        || getDirectChildXml(node, 'recordxml')
        || getText(node, 'recordxml')
      )

      let content = datatitle || datadesc
      if (!content) {
        if (datatype === '4') content = '[视频]'
        else if (datatype === '2' || datatype === '3') content = '[图片]'
        else if (datatype === '47' || datatype === '37') content = '[表情]'
        else if (datatype) content = `[消息 ${datatype}]`
        else content = '[消息]'
      }

      const fmt = String(datafmt || '').trim().toLowerCase().replace(/^\./, '')
      const imageFormats = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'])

      let renderType = 'text'
      if (datatype === '17') {
        renderType = 'chatHistory'
      } else if (datatype === '8') {
        renderType = 'file'
      } else if (datatype === '4' || fmt === 'mp4') {
        renderType = 'video'
      } else if (datatype === '5' || link) {
        renderType = 'link'
      } else if (datatype === '47' || datatype === '37') {
        renderType = 'emoji'
      } else if (
        datatype === '2'
        || datatype === '3'
        || imageFormats.has(fmt)
        || (datatype !== '1' && isMaybeMd5(fullmd5))
      ) {
        renderType = 'image'
      } else if (isMaybeMd5(md5) && /表情/.test(String(content || ''))) {
        renderType = 'emoji'
      }

      let outTitle = ''
      let outUrl = ''
      let recordItem = ''
      if (renderType === 'chatHistory') {
        outTitle = datatitle || content || '聊天记录'
        content = datadesc || ''
        recordItem = nestedRecordItem
      } else if (renderType === 'file') {
        outTitle = datatitle || content || '文件'
      } else if (renderType === 'link') {
        outTitle = datatitle || content || ''
        outUrl = link || externurl || ''
        // datadesc can be an invisible filler; only keep as description when meaningful.
        const cleanDesc = String(datadesc || '').replace(/[\\u3164\\u2800]/g, '').trim()
        const cleanTitle = String(outTitle || '').replace(/[\\u3164\\u2800]/g, '').trim()
        if (!cleanDesc || (cleanTitle && cleanDesc === cleanTitle)) content = ''
        else content = String(datadesc || '').trim()
      }

      return {
        id: dataid,
        datatype,
        sourcename,
        sourcetime,
        sourceheadurl,
        datafmt,
        duration,
        fullmd5,
        thumbfullmd5,
        md5,
        cdnthumbmd5,
        cdnurlstring,
        encrypturlstring,
        externurl,
        aeskey,
        fromnewmsgid,
        srcMsgLocalid,
        srcMsgCreateTime,
        renderType,
        title: outTitle,
        recordItem,
        url: outUrl,
        content
      }
    })

    return {
      info: { isChatRoom, title, desc },
      items: parsed
    }
  }

  const initChatHistoryModal = () => {
    const modal = document.getElementById('chatHistoryModal')
    const titleEl = document.getElementById('chatHistoryModalTitle')
    const closeBtn = document.getElementById('chatHistoryModalClose')
    const emptyEl = document.getElementById('chatHistoryModalEmpty')
    const listEl = document.getElementById('chatHistoryModalList')
    if (!modal || !titleEl || !closeBtn || !emptyEl || !listEl) return

    const mediaIndex = readMediaIndex()
    let historyStack = []
    let currentState = null
    let backBtn = null

    const updateBackVisibility = () => {
      if (!backBtn) return
      const show = Array.isArray(historyStack) && historyStack.length > 0
      try { backBtn.classList.toggle('hidden', !show) } catch {}
    }

    // Add a back button next to the title (created at runtime to avoid changing the HTML template).
    try {
      const header = titleEl.parentElement
      if (header) {
        const wrap = document.createElement('div')
        wrap.className = 'flex items-center gap-2 min-w-0'

        backBtn = document.createElement('button')
        backBtn.type = 'button'
        backBtn.className = 'p-2 rounded hover:bg-black/5 flex-shrink-0 hidden'
        try { backBtn.setAttribute('aria-label', '返回') } catch {}
        try { backBtn.setAttribute('title', '返回') } catch {}
        backBtn.innerHTML = '<svg class="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>'

        header.insertBefore(wrap, titleEl)
        wrap.appendChild(backBtn)
        wrap.appendChild(titleEl)
      }
    } catch {}

    const close = () => {
      try { modal.classList.add('hidden') } catch {}
      try { modal.style.display = 'none' } catch {}
      try { modal.setAttribute('aria-hidden', 'true') } catch {}
      try { document.body.style.overflow = '' } catch {}
      try { titleEl.textContent = '聊天记录' } catch {}
      try { listEl.textContent = '' } catch {}
      try { emptyEl.style.display = '' } catch {}
      historyStack = []
      currentState = null
      updateBackVisibility()
    }

    const buildChatHistoryState = (payload) => {
      const title = String(payload?.title || '聊天记录').trim() || '聊天记录'
      const xml = String(payload?.recordItem || '').trim()
      const parsed = parseChatHistoryRecord(xml)
      const info = (parsed && parsed.info) ? parsed.info : { isChatRoom: false }
      let records = (parsed && Array.isArray(parsed.items)) ? parsed.items : []

      if (!records.length) {
        const lines = Array.isArray(payload?.fallbackLines)
          ? payload.fallbackLines
          : String(payload?.content || '').trim().split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean)
        records = lines.map((line, idx) => ({ id: String(idx), renderType: 'text', content: line, sourcename: '', sourcetime: '' }))
      }

      return { title, info, records }
    }

    const renderRecordRow = (rec, info) => {
      const row = document.createElement('div')
      row.className = 'px-4 py-3 flex gap-3 border-b border-gray-100'

      const avatarWrap = document.createElement('div')
      avatarWrap.className = 'w-9 h-9 rounded-md overflow-hidden bg-gray-200 flex-shrink-0'
      const name0 = String(rec?.sourcename || '').trim() || '?'
      const avatarUrlRaw = normalizeChatHistoryUrl(rec?.sourceheadurl)
      const avatarLocal = (mediaIndex && mediaIndex.remote && mediaIndex.remote[avatarUrlRaw]) ? String(mediaIndex.remote[avatarUrlRaw] || '') : ''
      const avatarUrl = avatarLocal
      if (avatarUrl) {
        const img = document.createElement('img')
        img.src = avatarUrl
        img.alt = '头像'
        img.className = 'w-full h-full object-cover'
        try { img.referrerPolicy = 'no-referrer' } catch {}
        img.onerror = () => {
          try { avatarWrap.textContent = '' } catch {}
          const fb = document.createElement('div')
          fb.className = 'w-full h-full flex items-center justify-center text-xs font-bold text-gray-600'
          fb.textContent = String(name0.charAt(0) || '?')
          avatarWrap.appendChild(fb)
        }
        avatarWrap.appendChild(img)
      } else {
        const fb = document.createElement('div')
        fb.className = 'w-full h-full flex items-center justify-center text-xs font-bold text-gray-600'
        fb.textContent = String(name0.charAt(0) || '?')
        avatarWrap.appendChild(fb)
      }

      const main = document.createElement('div')
      main.className = 'min-w-0 flex-1'

      const header = document.createElement('div')
      header.className = 'flex items-start gap-2'

      const headerLeft = document.createElement('div')
      headerLeft.className = 'min-w-0 flex-1'
      const senderName = String(rec?.sourcename || '').trim()
      if (info && info.isChatRoom && senderName) {
        const sn = document.createElement('div')
        sn.className = 'text-xs text-gray-500 leading-none truncate mb-1'
        sn.textContent = senderName
        headerLeft.appendChild(sn)
      }

      const headerRight = document.createElement('div')
      headerRight.className = 'text-xs text-gray-400 flex-shrink-0 leading-none'
      const timeText = String(rec?.sourcetime || '').trim()
      headerRight.textContent = timeText

      header.appendChild(headerLeft)
      if (timeText) header.appendChild(headerRight)

      const body = document.createElement('div')
      body.className = 'mt-1'

      const rt = String(rec?.renderType || 'text')
      const content = String(rec?.content || '').trim()
      const serverId = String(rec?.fromnewmsgid || '').trim()
      const serverMd5 = resolveServerMd5(mediaIndex, serverId)

      if (rt === 'chatHistory') {
        const card = document.createElement('div')
        card.className = 'wechat-chat-history-card wechat-special-card msg-radius'

        const chBody = document.createElement('div')
        chBody.className = 'wechat-chat-history-body'

        const chTitle = document.createElement('div')
        chTitle.className = 'wechat-chat-history-title'
        chTitle.textContent = String(rec?.title || '聊天记录')
        chBody.appendChild(chTitle)

        const raw = String(rec?.content || '').trim()
        const lines = raw ? raw.split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4) : []
        if (lines.length) {
          const preview = document.createElement('div')
          preview.className = 'wechat-chat-history-preview'
          for (const line of lines) {
            const el = document.createElement('div')
            el.className = 'wechat-chat-history-line'
            el.textContent = line
            preview.appendChild(el)
          }
          chBody.appendChild(preview)
        }

        card.appendChild(chBody)

        const bottom = document.createElement('div')
        bottom.className = 'wechat-chat-history-bottom'
        const label = document.createElement('span')
        label.textContent = '聊天记录'
        bottom.appendChild(label)
        card.appendChild(bottom)

        const nestedXml = String(rec?.recordItem || '').trim()
        if (nestedXml) {
          card.classList.add('cursor-pointer')
          card.addEventListener('click', (ev) => {
            try { ev.preventDefault() } catch {}
            try { ev.stopPropagation() } catch {}
            openNestedChatHistory(rec)
          })
        }

        body.appendChild(card)
      } else if (rt === 'link') {
        const href = normalizeChatHistoryUrl(rec?.url) || normalizeChatHistoryUrl(rec?.externurl)
        const heading = String(rec?.title || '').trim() || content || href || '链接'
        const desc = String(rec?.content || '').trim()

        const thumbMd5 = pickFirstMd5(rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.md5, rec?.id)
        let previewUrl = resolveMediaMd5(mediaIndex, 'preview', thumbMd5)
        if (!previewUrl && serverMd5) previewUrl = resolveMediaMd5(mediaIndex, 'preview', serverMd5)
        if (!previewUrl) previewUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        const card = document.createElement(href ? 'a' : 'div')
        card.className = 'wechat-link-card wechat-special-card msg-radius cursor-pointer'
        if (href) {
          card.href = href
          card.target = '_blank'
          card.rel = 'noreferrer noopener'
        }
        try { card.style.textDecoration = 'none' } catch {}
        try { card.style.outline = 'none' } catch {}

        const linkContent = document.createElement('div')
        linkContent.className = 'wechat-link-content'

        const linkInfo = document.createElement('div')
        linkInfo.className = 'wechat-link-info'
        const titleEl = document.createElement('div')
        titleEl.className = 'wechat-link-title'
        titleEl.textContent = heading
        linkInfo.appendChild(titleEl)
        if (desc) {
          const descEl = document.createElement('div')
          descEl.className = 'wechat-link-desc'
          descEl.textContent = desc
          linkInfo.appendChild(descEl)
        }
        linkContent.appendChild(linkInfo)

        if (previewUrl) {
          const thumb = document.createElement('div')
          thumb.className = 'wechat-link-thumb'
          const img = document.createElement('img')
          img.src = previewUrl
          img.alt = heading || '链接预览'
          img.className = 'wechat-link-thumb-img'
          try { img.referrerPolicy = 'no-referrer' } catch {}
          thumb.appendChild(img)
          linkContent.appendChild(thumb)
        }

        card.appendChild(linkContent)

        const fromRow = document.createElement('div')
        fromRow.className = 'wechat-link-from'
        const fromText = (() => {
          const f0 = String(rec?.from || '').trim()
          if (f0) return f0
          try { return href ? (new URL(href).hostname || '') : '' } catch { return '' }
        })()
        const fromAvatarText = fromText ? (Array.from(fromText)[0] || '') : ''
        const fromAvatar = document.createElement('div')
        fromAvatar.className = 'wechat-link-from-avatar'
        fromAvatar.textContent = fromAvatarText || '\u200B'
        const fromName = document.createElement('div')
        fromName.className = 'wechat-link-from-name'
        fromName.textContent = fromText || '\u200B'
        fromRow.appendChild(fromAvatar)
        fromRow.appendChild(fromName)
        card.appendChild(fromRow)

        body.appendChild(card)
      } else if (rt === 'video') {
        const videoMd5 = pickFirstMd5(rec?.fullmd5, rec?.md5, rec?.id)
        const thumbMd5 = pickFirstMd5(rec?.thumbfullmd5, rec?.cdnthumbmd5) || videoMd5
        let videoUrl = resolveMediaMd5(mediaIndex, 'video', videoMd5)
        if (!videoUrl && serverMd5) videoUrl = resolveMediaMd5(mediaIndex, 'video', serverMd5)
        if (!videoUrl) videoUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        let thumbUrl = resolveMediaMd5(mediaIndex, 'videoThumb', thumbMd5)
        if (!thumbUrl && serverMd5) thumbUrl = resolveMediaMd5(mediaIndex, 'videoThumb', serverMd5)
        if (!thumbUrl) thumbUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        const wrap = document.createElement('div')
        wrap.className = 'msg-radius overflow-hidden relative bg-black/5 inline-block'

        if (thumbUrl) {
          const img = document.createElement('img')
          img.src = thumbUrl
          img.alt = '视频'
          img.className = 'block w-[220px] max-w-[260px] h-auto max-h-[260px] object-cover'
          wrap.appendChild(img)
        } else {
          const t = document.createElement(videoUrl ? 'a' : 'div')
          t.className = 'px-3 py-2 text-sm text-gray-700'
          t.textContent = videoUrl ? (content || '[视频]') : `${content || '[视频]'}（视频缺失）`
          if (videoUrl) {
            t.href = videoUrl
            t.target = '_blank'
            t.rel = 'noreferrer noopener'
          }
          wrap.appendChild(t)
        }

        if (thumbUrl) {
          const overlay = document.createElement(videoUrl ? 'a' : 'div')
          if (videoUrl) {
            overlay.href = videoUrl
            overlay.target = '_blank'
            overlay.rel = 'noreferrer noopener'
          }
          overlay.className = 'absolute inset-0 flex items-center justify-center'
          const btn = document.createElement('div')
          btn.className = 'w-12 h-12 rounded-full bg-black/45 flex items-center justify-center'
          btn.innerHTML = '<svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
          overlay.appendChild(btn)
          wrap.appendChild(overlay)
        }

        body.appendChild(wrap)
      } else if (rt === 'image') {
        const imageMd5 = pickFirstMd5(rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.md5, rec?.id)
        let imgUrl = resolveMediaMd5(mediaIndex, 'image', imageMd5)
        if (!imgUrl && serverMd5) imgUrl = resolveMediaMd5(mediaIndex, 'image', serverMd5)
        if (!imgUrl) imgUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)
        if (imgUrl) {
          const outer = document.createElement('div')
          outer.className = 'msg-radius overflow-hidden cursor-pointer inline-block'
          const a = document.createElement('a')
          a.href = imgUrl
          a.target = '_blank'
          a.rel = 'noreferrer noopener'
          const img = document.createElement('img')
          img.src = imgUrl
          img.alt = '图片'
          img.className = 'max-w-[240px] max-h-[240px] object-cover'
          a.appendChild(img)
          outer.appendChild(a)
          body.appendChild(outer)
        } else {
          const t = document.createElement('div')
          t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
          t.textContent = content || '[图片]'
          body.appendChild(t)
        }
      } else if (rt === 'file') {
        const fileKey = pickFirstMd5(rec?.fullmd5, rec?.md5, rec?.id, serverMd5) || String(rec?.id || '').trim()
        const fileUrl = resolveMediaMd5(mediaIndex, 'file', fileKey)
        const attachment = document.createElement(fileUrl ? 'a' : 'div')
        attachment.className = 'px-3 py-2 text-sm whitespace-pre-wrap break-words'
        const title = String(rec?.title || content || '文件')
        attachment.textContent = fileUrl ? title : `${title}（文件缺失）`
        if (fileUrl) {
          attachment.href = fileUrl
          attachment.download = title
        }
        body.appendChild(attachment)
      } else if (rt === 'emoji') {
        const emojiMd5 = pickFirstMd5(rec?.md5, rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.id)
        let emojiUrl = resolveMediaMd5(mediaIndex, 'emoji', emojiMd5)
        if (!emojiUrl && serverMd5) emojiUrl = resolveMediaMd5(mediaIndex, 'emoji', serverMd5)
        if (!emojiUrl) emojiUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)
        if (emojiUrl) {
          const img = document.createElement('img')
          img.src = emojiUrl
          img.alt = '表情'
          img.className = 'w-24 h-24 object-contain'
          body.appendChild(img)
        } else {
          const t = document.createElement('div')
          t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
          t.textContent = content || '[表情]'
          body.appendChild(t)
        }
      } else {
        const t = document.createElement('div')
        t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
        t.textContent = content || ''
        body.appendChild(t)
      }

      main.appendChild(header)
      main.appendChild(body)

      row.appendChild(avatarWrap)
      row.appendChild(main)
      return row
    }

    const applyChatHistoryState = (state) => {
      currentState = state
      const title = String(state?.title || '聊天记录').trim() || '聊天记录'
      const info = state?.info || { isChatRoom: false }
      const records = Array.isArray(state?.records) ? state.records : []

      try { titleEl.textContent = title } catch {}
      try { listEl.textContent = '' } catch {}

      if (!records.length) {
        try { emptyEl.style.display = '' } catch {}
      } else {
        try { emptyEl.style.display = 'none' } catch {}
        for (const rec of records) {
          try {
            listEl.appendChild(renderRecordRow(rec, info))
          } catch {}
        }
      }

      updateBackVisibility()
    }

    const openNestedChatHistory = (rec) => {
      const xml = String(rec?.recordItem || '').trim()
      if (!xml) return
      if (currentState) {
        historyStack = [...historyStack, currentState]
      }
      const state = buildChatHistoryState({
        title: String(rec?.title || '聊天记录'),
        recordItem: xml,
        content: String(rec?.content || ''),
      })
      applyChatHistoryState(state)
    }

    if (backBtn) {
      backBtn.addEventListener('click', (ev) => {
        try { ev.preventDefault() } catch {}
        if (!Array.isArray(historyStack) || !historyStack.length) return
        const prev = historyStack[historyStack.length - 1]
        historyStack = historyStack.slice(0, -1)
        applyChatHistoryState(prev)
      })
    }

    const openFromCard = (card) => {
      const title = String(card?.getAttribute('data-title') || '聊天记录').trim() || '聊天记录'
      const b64 = String(card?.getAttribute('data-record-item-b64') || '').trim()
      const xml = decodeBase64Utf8(b64)
      const lines = Array.from(card.querySelectorAll('.wechat-chat-history-line') || [])
        .map((el) => String(el?.textContent || '').trim())
        .filter(Boolean)

      historyStack = []
      const state = buildChatHistoryState({ title, recordItem: xml, fallbackLines: lines })
      applyChatHistoryState(state)

      try { modal.classList.remove('hidden') } catch {}
      try { modal.style.display = 'flex' } catch {}
      try { modal.setAttribute('aria-hidden', 'false') } catch {}
      try { document.body.style.overflow = 'hidden' } catch {}
    }

    closeBtn.addEventListener('click', (ev) => {
      try { ev.preventDefault() } catch {}
      close()
    })
    modal.addEventListener('click', (ev) => {
      const t = ev && ev.target
      if (t === modal) close()
    })

    document.addEventListener('keydown', (ev) => {
      const key = String(ev?.key || '')
      if (key === 'Escape' && !modal.classList.contains('hidden')) close()

      if ((key === 'Enter' || key === ' ') && modal.classList.contains('hidden')) {
        const target = ev && ev.target
        const card = target && target.closest ? target.closest('[data-wce-chat-history=\"1\"]') : null
        if (!card) return
        try { ev.preventDefault() } catch {}
        openFromCard(card)
      }
    }, true)

    document.addEventListener('click', (ev) => {
      const target = ev && ev.target
      const card = target && target.closest ? target.closest('[data-wce-chat-history=\"1\"]') : null
      if (!card) return
      try { ev.preventDefault() } catch {}
      openFromCard(card)
    }, true)
  }

  const initChatHistoryFloatingWindows = () => {
    const mediaIndex = readMediaIndex()
    let zIndex = 1000
    let cascade = 0
    let idSeed = 0

    const clampNumber = (value, min, max) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return min
      return Math.min(max, Math.max(min, n))
    }

    const getViewport = () => {
      const w = Math.max(320, window.innerWidth || 0)
      const h = Math.max(240, window.innerHeight || 0)
      return { w, h }
    }

    const getPoint = (ev) => {
      try {
        return (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev
      } catch {
        return ev
      }
    }

    const buildChatHistoryState = (payload) => {
      const title = String(payload?.title || '聊天记录').trim() || '聊天记录'
      const xml = String(payload?.recordItem || '').trim()
      const parsed = parseChatHistoryRecord(xml)
      const info = (parsed && parsed.info) ? parsed.info : { isChatRoom: false }
      let records = (parsed && Array.isArray(parsed.items)) ? parsed.items : []

      if (!records.length) {
        const lines = Array.isArray(payload?.fallbackLines)
          ? payload.fallbackLines
          : String(payload?.content || '').trim().split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean)
        records = lines.map((line, idx) => ({ id: String(idx), renderType: 'text', content: line, sourcename: '', sourcetime: '' }))
      }

      return { title, info, records }
    }

    const renderRecordRow = (rec, info, onOpenNested) => {
      const row = document.createElement('div')
      row.className = 'px-4 py-3 flex gap-3 border-b border-gray-100 bg-[#f7f7f7]'

      const avatarWrap = document.createElement('div')
      avatarWrap.className = 'w-9 h-9 rounded-md overflow-hidden bg-gray-200 flex-shrink-0'
      const name0 = String(rec?.sourcename || '').trim() || '?'
      const avatarUrlRaw = normalizeChatHistoryUrl(rec?.sourceheadurl)
      const avatarLocal = (mediaIndex && mediaIndex.remote && mediaIndex.remote[avatarUrlRaw]) ? String(mediaIndex.remote[avatarUrlRaw] || '') : ''
      const avatarUrl = avatarLocal
      if (avatarUrl) {
        const img = document.createElement('img')
        img.src = avatarUrl
        img.alt = '头像'
        img.className = 'w-full h-full object-cover'
        try { img.referrerPolicy = 'no-referrer' } catch {}
        img.onerror = () => {
          try { avatarWrap.textContent = '' } catch {}
          const fb = document.createElement('div')
          fb.className = 'w-full h-full flex items-center justify-center text-xs font-bold text-gray-600'
          fb.textContent = String(name0.charAt(0) || '?')
          avatarWrap.appendChild(fb)
        }
        avatarWrap.appendChild(img)
      } else {
        const fb = document.createElement('div')
        fb.className = 'w-full h-full flex items-center justify-center text-xs font-bold text-gray-600'
        fb.textContent = String(name0.charAt(0) || '?')
        avatarWrap.appendChild(fb)
      }

      const main = document.createElement('div')
      main.className = 'min-w-0 flex-1'

      const header = document.createElement('div')
      header.className = 'flex items-start gap-2'

      const headerLeft = document.createElement('div')
      headerLeft.className = 'min-w-0 flex-1'
      const senderName = String(rec?.sourcename || '').trim()
      if (info && info.isChatRoom && senderName) {
        const sn = document.createElement('div')
        sn.className = 'text-xs text-gray-500 leading-none truncate mb-1'
        sn.textContent = senderName
        headerLeft.appendChild(sn)
      }

      const headerRight = document.createElement('div')
      headerRight.className = 'text-xs text-gray-400 flex-shrink-0 leading-none'
      const timeText = String(rec?.sourcetime || '').trim()
      headerRight.textContent = timeText

      header.appendChild(headerLeft)
      if (timeText) header.appendChild(headerRight)

      const body = document.createElement('div')
      body.className = 'mt-1'

      const rt = String(rec?.renderType || 'text')
      const content = String(rec?.content || '').trim()
      const serverId = String(rec?.fromnewmsgid || '').trim()
      const serverMd5 = resolveServerMd5(mediaIndex, serverId)

      if (rt === 'chatHistory') {
        const card = document.createElement('div')
        card.className = 'wechat-chat-history-card wechat-special-card msg-radius'

        const chBody = document.createElement('div')
        chBody.className = 'wechat-chat-history-body'

        const chTitle = document.createElement('div')
        chTitle.className = 'wechat-chat-history-title'
        chTitle.textContent = String(rec?.title || '聊天记录')
        chBody.appendChild(chTitle)

        const raw = String(rec?.content || '').trim()
        const lines = raw ? raw.split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4) : []
        if (lines.length) {
          const preview = document.createElement('div')
          preview.className = 'wechat-chat-history-preview'
          for (const line of lines) {
            const el = document.createElement('div')
            el.className = 'wechat-chat-history-line'
            el.textContent = line
            preview.appendChild(el)
          }
          chBody.appendChild(preview)
        }

        card.appendChild(chBody)

        const bottom = document.createElement('div')
        bottom.className = 'wechat-chat-history-bottom'
        const label = document.createElement('span')
        label.textContent = '聊天记录'
        bottom.appendChild(label)
        card.appendChild(bottom)

        const nestedXml = String(rec?.recordItem || '').trim()
        if (nestedXml) {
          card.classList.add('cursor-pointer')
          card.addEventListener('click', (ev) => {
            try { ev.preventDefault() } catch {}
            try { ev.stopPropagation() } catch {}
            if (typeof onOpenNested === 'function') onOpenNested(rec)
          })
        }

        body.appendChild(card)
      } else if (rt === 'link') {
        const href = normalizeChatHistoryUrl(rec?.url) || normalizeChatHistoryUrl(rec?.externurl)
        const heading = String(rec?.title || '').trim() || content || href || '链接'
        const desc = String(rec?.content || '').trim()

        const thumbMd5 = pickFirstMd5(rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.md5, rec?.id)
        let previewUrl = resolveMediaMd5(mediaIndex, 'preview', thumbMd5)
        if (!previewUrl && serverMd5) previewUrl = resolveMediaMd5(mediaIndex, 'preview', serverMd5)
        if (!previewUrl) previewUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        const card = document.createElement(href ? 'a' : 'div')
        card.className = 'wechat-link-card wechat-special-card msg-radius cursor-pointer'
        if (href) {
          card.href = href
          card.target = '_blank'
          card.rel = 'noreferrer noopener'
        }
        try { card.style.textDecoration = 'none' } catch {}
        try { card.style.outline = 'none' } catch {}

        const linkContent = document.createElement('div')
        linkContent.className = 'wechat-link-content'

        const linkInfo = document.createElement('div')
        linkInfo.className = 'wechat-link-info'
        const titleEl = document.createElement('div')
        titleEl.className = 'wechat-link-title'
        titleEl.textContent = heading
        linkInfo.appendChild(titleEl)
        if (desc) {
          const descEl = document.createElement('div')
          descEl.className = 'wechat-link-desc'
          descEl.textContent = desc
          linkInfo.appendChild(descEl)
        }
        linkContent.appendChild(linkInfo)

        if (previewUrl) {
          const thumb = document.createElement('div')
          thumb.className = 'wechat-link-thumb'
          const img = document.createElement('img')
          img.src = previewUrl
          img.alt = heading || '链接预览'
          img.className = 'wechat-link-thumb-img'
          try { img.referrerPolicy = 'no-referrer' } catch {}
          thumb.appendChild(img)
          linkContent.appendChild(thumb)
        }

        card.appendChild(linkContent)

        const fromRow = document.createElement('div')
        fromRow.className = 'wechat-link-from'
        const fromAvatar = document.createElement('div')
        fromAvatar.className = 'wechat-link-from-avatar'

        const fromUrlRaw = normalizeChatHistoryUrl(rec?.sourceheadurl)
        const fromLocal = (mediaIndex && mediaIndex.remote && mediaIndex.remote[fromUrlRaw]) ? String(mediaIndex.remote[fromUrlRaw] || '') : ''
        const fromUrl = fromLocal
        const fromText = String(rec?.sourcename || '').trim()
        if (fromUrl) {
          const img = document.createElement('img')
          img.src = fromUrl
          img.alt = ''
          img.className = 'wechat-link-from-avatar-img'
          try { img.referrerPolicy = 'no-referrer' } catch {}
          img.onerror = () => {
            try { fromAvatar.textContent = '' } catch {}
            const span = document.createElement('span')
            span.textContent = String(fromText ? fromText.charAt(0) : '\u200B')
            fromAvatar.appendChild(span)
          }
          fromAvatar.appendChild(img)
        } else {
          const span = document.createElement('span')
          span.textContent = String(fromText ? fromText.charAt(0) : '\u200B')
          fromAvatar.appendChild(span)
        }
        const fromName = document.createElement('div')
        fromName.className = 'wechat-link-from-name'
        fromName.textContent = fromText || '\u200B'
        fromRow.appendChild(fromAvatar)
        fromRow.appendChild(fromName)
        card.appendChild(fromRow)

        body.appendChild(card)
      } else if (rt === 'video') {
        const videoMd5 = pickFirstMd5(rec?.fullmd5, rec?.md5, rec?.id)
        const thumbMd5 = pickFirstMd5(rec?.thumbfullmd5, rec?.cdnthumbmd5) || videoMd5
        let videoUrl = resolveMediaMd5(mediaIndex, 'video', videoMd5)
        if (!videoUrl && serverMd5) videoUrl = resolveMediaMd5(mediaIndex, 'video', serverMd5)
        if (!videoUrl) videoUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        let thumbUrl = resolveMediaMd5(mediaIndex, 'videoThumb', thumbMd5)
        if (!thumbUrl && serverMd5) thumbUrl = resolveMediaMd5(mediaIndex, 'videoThumb', serverMd5)
        if (!thumbUrl) thumbUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)

        const wrap = document.createElement('div')
        wrap.className = 'msg-radius overflow-hidden relative bg-black/5 inline-block'

        if (thumbUrl) {
          const img = document.createElement('img')
          img.src = thumbUrl
          img.alt = '视频'
          img.className = 'block w-[220px] max-w-[260px] h-auto max-h-[260px] object-cover'
          wrap.appendChild(img)
        } else {
          const t = document.createElement(videoUrl ? 'a' : 'div')
          t.className = 'px-3 py-2 text-sm text-gray-700'
          t.textContent = videoUrl ? (content || '[视频]') : `${content || '[视频]'}（视频缺失）`
          if (videoUrl) {
            t.href = videoUrl
            t.target = '_blank'
            t.rel = 'noreferrer noopener'
          }
          wrap.appendChild(t)
        }

        if (thumbUrl) {
          const overlay = document.createElement(videoUrl ? 'a' : 'div')
          if (videoUrl) {
            overlay.href = videoUrl
            overlay.target = '_blank'
            overlay.rel = 'noreferrer noopener'
          }
          overlay.className = 'absolute inset-0 flex items-center justify-center'
          const btn = document.createElement('div')
          btn.className = 'w-12 h-12 rounded-full bg-black/45 flex items-center justify-center'
          btn.innerHTML = '<svg class=\"w-6 h-6 text-white\" fill=\"currentColor\" viewBox=\"0 0 24 24\"><path d=\"M8 5v14l11-7z\"/></svg>'
          overlay.appendChild(btn)
          wrap.appendChild(overlay)
        }

        body.appendChild(wrap)
      } else if (rt === 'image') {
        const imageMd5 = pickFirstMd5(rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.md5, rec?.id)
        let imgUrl = resolveMediaMd5(mediaIndex, 'image', imageMd5)
        if (!imgUrl && serverMd5) imgUrl = resolveMediaMd5(mediaIndex, 'image', serverMd5)
        if (!imgUrl) imgUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)
        if (imgUrl) {
          const outer = document.createElement('div')
          outer.className = 'msg-radius overflow-hidden cursor-pointer inline-block'
          const a = document.createElement('a')
          a.href = imgUrl
          a.target = '_blank'
          a.rel = 'noreferrer noopener'
          const img = document.createElement('img')
          img.src = imgUrl
          img.alt = '图片'
          img.className = 'max-w-[240px] max-h-[240px] object-cover'
          a.appendChild(img)
          outer.appendChild(a)
          body.appendChild(outer)
        } else {
          const t = document.createElement('div')
          t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
          t.textContent = content || '[图片]'
          body.appendChild(t)
        }
      } else if (rt === 'file') {
        const fileKey = pickFirstMd5(rec?.fullmd5, rec?.md5, rec?.id, serverMd5) || String(rec?.id || '').trim()
        const fileUrl = resolveMediaMd5(mediaIndex, 'file', fileKey)
        const attachment = document.createElement(fileUrl ? 'a' : 'div')
        attachment.className = 'px-3 py-2 text-sm whitespace-pre-wrap break-words'
        const title = String(rec?.title || content || '文件')
        attachment.textContent = fileUrl ? title : `${title}（文件缺失）`
        if (fileUrl) {
          attachment.href = fileUrl
          attachment.download = title
        }
        body.appendChild(attachment)
      } else if (rt === 'emoji') {
        const emojiMd5 = pickFirstMd5(rec?.md5, rec?.fullmd5, rec?.thumbfullmd5, rec?.cdnthumbmd5, rec?.id)
        let emojiUrl = resolveMediaMd5(mediaIndex, 'emoji', emojiMd5)
        if (!emojiUrl && serverMd5) emojiUrl = resolveMediaMd5(mediaIndex, 'emoji', serverMd5)
        if (!emojiUrl) emojiUrl = resolveRemoteAny(mediaIndex, rec?.externurl, rec?.cdnurlstring, rec?.encrypturlstring)
        if (emojiUrl) {
          const img = document.createElement('img')
          img.src = emojiUrl
          img.alt = '表情'
          img.className = 'w-24 h-24 object-contain'
          body.appendChild(img)
        } else {
          const t = document.createElement('div')
          t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
          t.textContent = content || '[表情]'
          body.appendChild(t)
        }
      } else {
        const t = document.createElement('div')
        t.className = 'px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap break-words'
        t.textContent = content || ''
        body.appendChild(t)
      }

      main.appendChild(header)
      main.appendChild(body)

      row.appendChild(avatarWrap)
      row.appendChild(main)
      return row
    }

    const focusWindow = (wrap) => {
      zIndex += 1
      try { wrap.style.zIndex = String(zIndex) } catch {}
    }

    const openChatHistoryWindow = (payload, opts) => {
      const state = buildChatHistoryState(payload || {})
      const info = state.info || { isChatRoom: false }
      const records = Array.isArray(state.records) ? state.records : []

      const vp = getViewport()
      const width = Math.min(560, Math.max(320, Math.floor(vp.w * 0.92)))
      const height = Math.min(560, Math.max(240, Math.floor(vp.h * 0.8)))

      let x = Math.max(8, Math.floor((vp.w - width) / 2))
      let y = Math.max(8, Math.floor((vp.h - height) / 2))

      const spawnFrom = opts && opts.spawnFrom
      if (spawnFrom) {
        x = Number(spawnFrom.x || x) + 24
        y = Number(spawnFrom.y || y) + 24
      } else {
        x += cascade
        y += cascade
        cascade = (cascade + 24) % 120
      }

      x = clampNumber(x, 8, Math.max(8, vp.w - width - 8))
      y = clampNumber(y, 8, Math.max(8, vp.h - height - 8))

      const win = { id: String(++idSeed), x, y, width, height }

      const wrap = document.createElement('div')
      wrap.className = 'fixed'
      wrap.style.left = `${win.x}px`
      wrap.style.top = `${win.y}px`
      wrap.style.zIndex = String(++zIndex)

      const box = document.createElement('div')
      box.className = 'bg-[#f7f7f7] rounded-xl shadow-xl overflow-hidden border border-gray-200 flex flex-col'
      box.style.width = `${win.width}px`
      box.style.height = `${win.height}px`
      wrap.appendChild(box)

      const header = document.createElement('div')
      header.className = 'px-3 py-2 bg-[#f7f7f7] border-b border-gray-200 flex items-center justify-between select-none cursor-move'
      box.appendChild(header)

      const titleEl = document.createElement('div')
      titleEl.className = 'text-sm text-[#161616] truncate min-w-0'
      titleEl.textContent = String(state.title || '聊天记录')
      header.appendChild(titleEl)

      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'p-2 rounded hover:bg-black/5 flex-shrink-0'
      try { closeBtn.setAttribute('aria-label', '关闭') } catch {}
      try { closeBtn.setAttribute('title', '关闭') } catch {}
      closeBtn.innerHTML = '<svg class=\"w-5 h-5 text-gray-700\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M6 18L18 6M6 6l12 12\"/></svg>'
      header.appendChild(closeBtn)

      const body = document.createElement('div')
      body.className = 'flex-1 overflow-auto bg-[#f7f7f7]'
      box.appendChild(body)

      if (!records.length) {
        const empty = document.createElement('div')
        empty.className = 'text-sm text-gray-500 text-center py-10'
        empty.textContent = '没有可显示的聊天记录'
        body.appendChild(empty)
      } else {
        const onOpenNested = (rec) => {
          const xml = String(rec?.recordItem || '').trim()
          if (!xml) return
          openChatHistoryWindow({
            title: String(rec?.title || '聊天记录'),
            recordItem: xml,
            content: String(rec?.content || ''),
          }, { spawnFrom: win })
        }
        for (const rec of records) {
          try {
            body.appendChild(renderRecordRow(rec, info, onOpenNested))
          } catch {}
        }
      }

      const updatePos = () => {
        try { wrap.style.left = `${win.x}px` } catch {}
        try { wrap.style.top = `${win.y}px` } catch {}
      }

      closeBtn.addEventListener('click', (ev) => {
        try { ev.preventDefault() } catch {}
        try { ev.stopPropagation() } catch {}
        try { wrap.remove() } catch {
          try { if (wrap.parentElement) wrap.parentElement.removeChild(wrap) } catch {}
        }
      })

      const startDrag = (ev) => {
        const t = ev && ev.target
        if (t && t.closest && t.closest('button')) return

        focusWindow(wrap)
        const p0 = getPoint(ev)
        const ox = Number(p0?.clientX || 0) - win.x
        const oy = Number(p0?.clientY || 0) - win.y

        const onMove = (e2) => {
          const p = getPoint(e2)
          if (!p) return
          try { if (e2 && typeof e2.preventDefault === 'function') e2.preventDefault() } catch {}

          const vp2 = getViewport()
          const nx = Number(p.clientX || 0) - ox
          const ny = Number(p.clientY || 0) - oy
          win.x = clampNumber(nx, 8, Math.max(8, vp2.w - win.width - 8))
          win.y = clampNumber(ny, 8, Math.max(8, vp2.h - win.height - 8))
          updatePos()
        }

        const stop = () => {
          try { document.removeEventListener('mousemove', onMove) } catch {}
          try { document.removeEventListener('touchmove', onMove) } catch {}
        }

        try { document.addEventListener('mousemove', onMove) } catch {}
        try { document.addEventListener('mouseup', () => stop(), { once: true }) } catch {}
        try { document.addEventListener('touchmove', onMove, { passive: false }) } catch {}
        try { document.addEventListener('touchend', () => stop(), { once: true }) } catch {}

        try { ev.preventDefault() } catch {}
      }

      header.addEventListener('mousedown', startDrag)
      header.addEventListener('touchstart', startDrag, { passive: false })

      wrap.addEventListener('mousedown', () => focusWindow(wrap))
      wrap.addEventListener('touchstart', () => focusWindow(wrap), { passive: true })

      try { document.body.appendChild(wrap) } catch {}
      return win
    }

    document.addEventListener('keydown', (ev) => {
      const key = String(ev?.key || '')
      if (key !== 'Enter' && key !== ' ') return
      const target = ev && ev.target
      const card = target && target.closest ? target.closest('[data-wce-chat-history=\"1\"]') : null
      if (!card) return
      try { ev.preventDefault() } catch {}
      const title = String(card?.getAttribute('data-title') || '聊天记录').trim() || '聊天记录'
      const b64 = String(card?.getAttribute('data-record-item-b64') || '').trim()
      const xml = decodeBase64Utf8(b64)
      const lines = Array.from(card.querySelectorAll('.wechat-chat-history-line') || [])
        .map((el) => String(el?.textContent || '').trim())
        .filter(Boolean)
      openChatHistoryWindow({ title, recordItem: xml, fallbackLines: lines })
    }, true)

    document.addEventListener('click', (ev) => {
      const target = ev && ev.target
      const card = target && target.closest ? target.closest('[data-wce-chat-history=\"1\"]') : null
      if (!card) return
      try { ev.preventDefault() } catch {}
      const title = String(card?.getAttribute('data-title') || '聊天记录').trim() || '聊天记录'
      const b64 = String(card?.getAttribute('data-record-item-b64') || '').trim()
      const xml = decodeBase64Utf8(b64)
      const lines = Array.from(card.querySelectorAll('.wechat-chat-history-line') || [])
        .map((el) => String(el?.textContent || '').trim())
        .filter(Boolean)
      openChatHistoryWindow({ title, recordItem: xml, fallbackLines: lines })
    }, true)
  }

  const wceFolderRuntimeSrc = (() => {
    try {
      const currentSrc = String((document.currentScript && document.currentScript.src) || '')
      if (currentSrc) return currentSrc
      const scripts = Array.from(document.querySelectorAll('script[src]'))
      const runtimeScript = scripts.find((element) => {
        const src = String((element && element.src) || '')
        return /(^|\/)chat-export\.js(?:[?#].*)?$/.test(src)
      })
      return String((runtimeScript && runtimeScript.src) || '')
    } catch {
      return ''
    }
  })()

  async function loadFolderSessionCatalog() {
    const ready = window.__WCE_FOLDER_SESSIONS__
    if (ready && Array.isArray(ready.items)) return true
    if (!wceFolderRuntimeSrc) return false

    return await new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(Boolean(value))
      }
      let script = document.querySelector('script[data-wce-folder-sessions="1"]')
      if (!script) {
        script = document.createElement('script')
        script.defer = true
        script.setAttribute('data-wce-folder-sessions', '1')
        try {
          script.src = new URL('chat-sessions.js', wceFolderRuntimeSrc).href
        } catch {
          finish(false)
          return
        }
        document.head.appendChild(script)
      }
      if (window.__WCE_FOLDER_SESSIONS__ && Array.isArray(window.__WCE_FOLDER_SESSIONS__.items)) {
        finish(true)
        return
      }
      script.addEventListener('load', () => finish(
        window.__WCE_FOLDER_SESSIONS__ && Array.isArray(window.__WCE_FOLDER_SESSIONS__.items)
      ), { once: true })
      script.addEventListener('error', () => finish(false), { once: true })
      window.setTimeout(() => finish(false), 10000)
    })
  }

  function syncFolderSessionCatalog() {
    const catalog = window.__WCE_FOLDER_SESSIONS__
    const container = document.querySelector('[data-wce-session-list="1"]')
    if (!catalog || !Array.isArray(catalog.items) || !container || !wceFolderRuntimeSrc) return

    let exportRoot
    try {
      exportRoot = new URL('../', wceFolderRuntimeSrc)
    } catch {
      return
    }
    const currentPath = (() => {
      try { return decodeURIComponent(window.location.pathname || '').replace(/\\/g, '/') }
      catch { return String(window.location.pathname || '').replace(/\\/g, '/') }
    })()
    const fragment = document.createDocumentFragment()

    for (const rawItem of catalog.items) {
      const convDir = String((rawItem && rawItem.convDir) || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (!convDir) continue
      const displayName = String((rawItem && rawItem.displayName) || '').trim() || '会话'
      const username = String((rawItem && rawItem.username) || '').trim()
      const avatarPath = String((rawItem && rawItem.avatarPath) || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
      const lastTimeText = String((rawItem && rawItem.lastTimeText) || '').trim()
      const previewText = String((rawItem && rawItem.previewText) || '').trim()
      const messageSuffix = `/${convDir}/messages.html`
      const active = currentPath.endsWith(messageSuffix)

      const link = document.createElement('a')
      link.href = new URL(`${convDir}/messages.html`, exportRoot).href
      link.className = 'px-3 cursor-pointer transition-colors duration-150 border-b border-gray-100 h-[calc(80px/var(--dpr))] flex items-center '
        + (active ? 'bg-[#DEDEDE]' : 'hover:bg-[#F5F5F5]')
      link.setAttribute('data-wce-session-item', '1')
      link.setAttribute('data-wce-session-name', displayName)
      link.setAttribute('data-wce-session-username', username)
      if (active) link.setAttribute('aria-current', 'page')

      const avatarWrap = document.createElement('div')
      avatarWrap.className = 'relative'
      const avatarBox = document.createElement('div')
      avatarBox.className = 'w-[calc(45px/var(--dpr))] h-[calc(45px/var(--dpr))] rounded-md overflow-hidden bg-gray-300'
      if (avatarPath) {
        const image = document.createElement('img')
        image.src = new URL(avatarPath, exportRoot).href
        image.alt = displayName
        image.className = 'w-full h-full object-cover'
        image.referrerPolicy = 'no-referrer'
        avatarBox.appendChild(image)
      } else {
        const fallback = document.createElement('div')
        fallback.className = 'w-full h-full flex items-center justify-center text-white text-xs font-bold'
        fallback.style.backgroundColor = '#4B5563'
        fallback.textContent = (displayName.slice(0, 1).trim() || '?')
        avatarBox.appendChild(fallback)
      }
      avatarWrap.appendChild(avatarBox)
      link.appendChild(avatarWrap)

      const content = document.createElement('div')
      content.className = 'flex-1 min-w-0 ml-3'
      const heading = document.createElement('div')
      heading.className = 'flex items-center justify-between'
      const title = document.createElement('h3')
      title.className = 'text-sm font-medium text-gray-900 truncate'
      title.textContent = displayName
      heading.appendChild(title)
      const timeWrap = document.createElement('div')
      timeWrap.className = 'flex items-center flex-shrink-0 ml-2'
      const time = document.createElement('span')
      time.className = 'text-xs text-gray-500'
      time.textContent = lastTimeText
      timeWrap.appendChild(time)
      heading.appendChild(timeWrap)
      content.appendChild(heading)
      const preview = document.createElement('p')
      preview.className = 'text-xs text-gray-500 truncate mt-0.5 leading-tight'
      preview.textContent = previewText
      content.appendChild(preview)
      link.appendChild(content)
      fragment.appendChild(link)
    }

    container.replaceChildren(fragment)
    container.setAttribute('data-wce-session-catalog', '1')
  }

  document.addEventListener('DOMContentLoaded', async () => {
    hideJsMissingBanner()
    updateDprVar()
    try {
      window.addEventListener('resize', updateDprVar)
    } catch {}

    if (!await loadFolderSessionCatalog()) throw new Error('Export session catalog could not be loaded')
    syncFolderSessionCatalog()
    initSessionSearch()
    initVoicePlayback()
    initMessageSearchAndDateJump()
    initChatHistoryFloatingWindows()
    initPagedMessageLoading()

    const select = document.getElementById('messageTypeFilter')
    if (select) {
      select.addEventListener('change', applyMessageTypeFilter)
      applyMessageTypeFilter()
    }

    updateSessionMessageCount()
    scrollToBottom()
    try {
      window.addEventListener('load', () => {
        updateSessionMessageCount()
        scrollToBottom()
        setTimeout(scrollToBottom, 60)
      })
    } catch {}
  })

  // Best-effort: defer scripts execute after the DOM is parsed, so we can hide the banner immediately.
  hideJsMissingBanner()
})()
