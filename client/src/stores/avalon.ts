import { defineStore } from 'pinia'
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import type { AvalonInstance, User, Lobby, Game, Config, GlobalStats } from '../types/avalon'
import AvalonGame from '../avalon.js'
import { eventBus } from '../main'

export const useAvalonStore = defineStore('avalon', () => {
  // State
  const avalonInstance: Ref<AvalonInstance | null> = ref(null)
  const initialized = ref(false)

  // Computed
  const isLoggedIn: ComputedRef<boolean> = computed(() => avalonInstance.value?.isLoggedIn ?? false)
  const isInLobby: ComputedRef<boolean> = computed(() => avalonInstance.value?.isInLobby ?? false)
  const isGameInProgress: ComputedRef<boolean> = computed(() => avalonInstance.value?.isGameInProgress ?? false)
  const isAdmin: ComputedRef<boolean> = computed(() => avalonInstance.value?.isAdmin ?? false)

  const user: ComputedRef<User | null> = computed(() => avalonInstance.value?.user ?? null)
  const lobby: ComputedRef<Lobby | null> = computed(() => avalonInstance.value?.lobby ?? null)
  const game: ComputedRef<Game | null> = computed(() => avalonInstance.value?.game ?? null)
  const config: ComputedRef<Config | null> = computed(() => avalonInstance.value?.config ?? null)
  const globalStats: ComputedRef<GlobalStats | null> = computed(() => avalonInstance.value?.globalStats ?? null)

  // Actions
  function init(): void {
    if (!avalonInstance.value) {
      const eventCallback = (...args: any[]) => {
        console.debug('event callback', ...args)
        eventBus.emit(...args)
      }

      avalonInstance.value = new AvalonGame(eventCallback) as AvalonInstance
      avalonInstance.value.init()
      initialized.value = true
    }
  }

  function getAvalon(): AvalonInstance | null {
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
