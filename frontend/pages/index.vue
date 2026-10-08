<template>
  <div class="landing-page theme-scope theme-page h-full min-h-0 overflow-auto">
    <main class="landing-content">
      <header class="landing-brand">
        <img src="/logo.png" alt="" width="36" height="36" />
        <div>
          <p class="landing-brand-name">xwechat</p>
          <p class="landing-brand-description">微信记录整理与备份</p>
        </div>
      </header>

      <section class="landing-workspace" aria-labelledby="landing-title">
        <div class="landing-start">
          <h1 id="landing-title">整理你的微信记录</h1>
          <p class="landing-description">从检测本机数据开始，<br />也可以直接导入已有备份。</p>

          <ol class="landing-steps" aria-label="本机数据整理流程">
            <li><Search aria-hidden="true" :size="18" :stroke-width="1.7" /><span>检测</span></li>
            <li><ArrowRight class="landing-step-arrow" aria-hidden="true" :size="14" /><LockKeyhole aria-hidden="true" :size="18" :stroke-width="1.7" /><span>解密</span></li>
            <li><ArrowRight class="landing-step-arrow" aria-hidden="true" :size="14" /><MessagesSquare aria-hidden="true" :size="18" :stroke-width="1.7" /><span>查看</span></li>
          </ol>

          <button type="button" class="landing-primary" @click="startDetection">
            <span>检测本机微信</span>
            <ArrowRight aria-hidden="true" :size="18" :stroke-width="1.7" />
          </button>
        </div>

        <nav class="landing-actions" aria-label="其他操作">
          <NuxtLink to="/import" class="landing-action">
            <FolderInput class="landing-action-icon" aria-hidden="true" :size="22" :stroke-width="1.7" />
            <div class="landing-action-copy">
              <h2>导入备份</h2>
              <p>接入已有的本地备份目录</p>
            </div>
            <ArrowRight class="landing-action-arrow" aria-hidden="true" :size="18" :stroke-width="1.7" />
          </NuxtLink>

          <NuxtLink to="/chat" class="landing-action">
            <MessagesSquare class="landing-action-icon" aria-hidden="true" :size="22" :stroke-width="1.7" />
            <div class="landing-action-copy">
              <h2>回看聊天</h2>
              <p>浏览会话，搜索需要的记录</p>
            </div>
            <ArrowRight class="landing-action-arrow" aria-hidden="true" :size="18" :stroke-width="1.7" />
          </NuxtLink>

          <button type="button" class="landing-action" aria-haspopup="dialog" @click="openExportDialog">
            <Archive class="landing-action-icon" aria-hidden="true" :size="22" :stroke-width="1.7" />
            <div class="landing-action-copy">
              <h2>导出归档</h2>
              <p>打包账号的数据库与资源文件</p>
            </div>
            <ArrowRight class="landing-action-arrow" aria-hidden="true" :size="18" :stroke-width="1.7" />
          </button>
        </nav>
      </section>
    </main>

    <GlobalExportDialog :open="exportDialogOpen" @close="closeExportDialog" />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Archive, ArrowRight, FolderInput, LockKeyhole, MessagesSquare, Search } from '@lucide/vue'
import { useApi } from '~/composables/useApi'
import { DESKTOP_SETTING_DEFAULT_TO_CHAT_KEY, readLocalBoolSetting } from '~/lib/desktop-settings'

const { listChatAccounts } = useApi()
const router = useRouter()
const exportDialogOpen = ref(false)

onMounted(async () => {
  if (!process.client || typeof window === 'undefined') return

  const enabled = readLocalBoolSetting(DESKTOP_SETTING_DEFAULT_TO_CHAT_KEY, true)
  if (!enabled) return

  try {
    const resp = await listChatAccounts()
    const accounts = resp?.accounts || []
    if (accounts.length) {
      // 提前获取路由实例，避免等待账号请求后丢失 Nuxt 上下文。
      await router.replace('/chat')
    }
  } catch (error) {
    console.warn('启动时自动进入聊天页失败：', error)
  }
})

const openExportDialog = () => {
  exportDialogOpen.value = true
}

const closeExportDialog = () => {
  exportDialogOpen.value = false
}

const startDetection = async () => {
  await navigateTo('/detection-result')
}
</script>

<style scoped>
.landing-page {
  padding-inline: clamp(24px, 5vw, 64px);
  color: var(--app-text-primary);
}

.landing-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 28px;
  width: min(100%, 1000px);
  min-height: 100%;
  margin-inline: auto;
  padding-block: 48px;
}

.landing-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.landing-brand-name {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.4;
}

.landing-brand-description {
  margin-top: 3px;
  color: var(--app-text-secondary);
  font-size: 13px;
}

.landing-workspace {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--chat-input-bg);
}

.landing-start {
  padding: 44px;
}

.landing-start h1 {
  font-size: 30px;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.landing-description {
  margin-top: 14px;
  color: var(--app-text-secondary);
  font-size: 15px;
  line-height: 1.8;
}

.landing-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-block: 28px;
  color: var(--chat-header-icon);
  font-size: 13px;
}

.landing-steps li {
  display: flex;
  align-items: center;
  gap: 7px;
}

.landing-step-arrow {
  margin-right: 9px;
}

.landing-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  min-height: 46px;
  padding: 11px 20px;
  border-radius: 10px;
  background: var(--chat-accent);
  color: var(--chat-input-bg);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 160ms ease;
}

.landing-primary:hover {
  background: var(--chat-accent-hover);
}

.landing-actions {
  display: flex;
  flex-direction: column;
  padding: 16px 28px;
  border-left: 1px solid var(--app-border);
}

.landing-action {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-height: 94px;
  padding: 20px 12px;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color 160ms ease;
}

.landing-action + .landing-action {
  border-top: 1px solid var(--app-border);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.landing-action:hover {
  background: var(--chat-subtle-bg);
}

.landing-action-icon {
  flex-shrink: 0;
  color: var(--chat-accent);
}

.landing-action-copy {
  flex: 1;
  min-width: 0;
}

.landing-action h2 {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.landing-action p {
  margin-top: 6px;
  color: var(--app-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.landing-action-arrow {
  flex-shrink: 0;
  color: var(--chat-header-icon);
}

.landing-primary:focus-visible,
.landing-action:focus-visible {
  outline: 2px solid var(--chat-focus-ring);
  outline-offset: 3px;
}

@media (max-width: 720px) {
  .landing-content { gap: 24px; padding-block: 32px; }
  .landing-workspace { grid-template-columns: 1fr; }
  .landing-start { padding: 28px; }
  .landing-start h1 { font-size: 26px; }
  .landing-actions { padding: 12px 16px; border-left: 0; border-top: 1px solid var(--app-border); }
  .landing-primary { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .landing-primary, .landing-action { transition: none; }
}
</style>
