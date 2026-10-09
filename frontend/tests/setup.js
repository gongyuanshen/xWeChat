import { beforeEach, vi } from 'vitest'

const { createPinia, setActivePinia } = await vi.importActual('pinia')
const { ref } = await vi.importActual('vue')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('ref', ref)
})
