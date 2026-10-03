import { createApp, ref } from 'vue'
import Preview from './live-recognition-preview.vue'
import GuideDialog from '../../components/GuideDialog.vue'
import '../../assets/css/tailwind.css'
import '../../assets/css/chat.css'

// Standalone Vite provides the Nuxt state primitive used by the real input component.
const states = new Map()
globalThis.useState = (key, factory) => { if (!states.has(key)) states.set(key, ref(factory())); return states.get(key) }
const app = createApp(Preview)
app.component('GuideDialog', GuideDialog)
app.directive('chat-lazy-src', { mounted: (element, binding) => { element.src = binding.value } })
app.directive('chat-media-perf', {})
app.mount('#app')
