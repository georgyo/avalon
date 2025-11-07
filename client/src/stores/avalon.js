import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import AvalonGame from '../avalon.js'
import { eventBus } from '../main.js'

export const useAvalonStore = defineStore('avalon', () => {
  // State
  const avalonInstance = ref(null)
  const initialized = ref(false)

  // Computed
  const isLoggedIn = computed(() => avalonInstance.value?.isLoggedIn ?? false)
  const isInLobby = computed(() => avalonInstance.value?.isInLobby ?? false)
  const isGameInProgress = computed(() => avalonInstance.value?.isGameInProgress ?? false)
  const isAdmin = computed(() => avalonInstance.value?.isAdmin ?? false)

  const user = computed(() => avalonInstance.value?.user ?? null)
  const lobby = computed(() => avalonInstance.value?.lobby ?? null)
  const game = computed(() => avalonInstance.value?.game ?? null)
  const config = computed(() => avalonInstance.value?.config ?? null)
  const globalStats = computed(() => avalonInstance.value?.globalStats ?? null)

  // Actions
  function init() {
    if (!avalonInstance.value) {
      const eventCallback = (...args) => {
        console.debug('event callback', ...args)
        eventBus.emit(...args)
      }

      avalonInstance.value = new AvalonGame(eventCallback)
      avalonInstance.value.init().then(() => {
        initialized.value = true
      })
    }
  }

  function getAvalon() {
    return avalonInstance.value
  }

  return {
    // State
    avalonInstance,
    initialized,

    // Computed
    isLoggedIn,
    isInLobby,
    isGameInProgress,
    isAdmin,
    user,
    lobby,
    game,
    config,
    globalStats,

    // Actions
    init,
    getAvalon
  }
})
