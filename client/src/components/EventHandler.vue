<template>
  <div>
    <StartGameEventHandler />
    <MissionResultEventHandler />
    <EndGameEventHandler />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, inject } from 'vue'
import type { Emitter } from 'mitt'
import { useAvalonStore } from '../stores/avalon'
import { useToast } from '../composables/useToast'
import StartGameEventHandler from './StartGameEventHandler.vue'
import EndGameEventHandler from './EndGameEventHandler.vue'
import MissionResultEventHandler from './MissionResultEventHandler.vue'

const eventBus = inject<Emitter<any>>('eventBus')!
const avalonStore = useAvalonStore()
const toast = useToast()

onMounted(() => {
  eventBus.on('LOBBY_CONNECTED', () => {
    const avalon = avalonStore.getAvalon()
    document.title = `Avalon - ${avalon.lobby.name} - ${avalon.user.name}`
  })

  eventBus.on('LOBBY_NEW_ADMIN', () => {
    const avalon = avalonStore.getAvalon()
    if (avalon.isAdmin) {
      toast.show("You are now lobby administrator")
    } else {
      toast.show(`${avalon.lobby.admin.name} became lobby administrator`)
    }
  })

  eventBus.on('PROPOSAL_REJECTED', () => {
    const avalon = avalonStore.getAvalon()
    toast.show(`${avalon.lobby.game.lastProposal.proposer}'s team rejected`)
  })

  eventBus.on('PROPOSAL_APPROVED', () => {
    const avalon = avalonStore.getAvalon()
    toast.show(`${avalon.lobby.game.currentProposal.proposer}'s team approved`)
  })

  eventBus.on('TEAM_PROPOSED', () => {
    const avalon = avalonStore.getAvalon()
    toast.show(`${avalon.lobby.game.currentProposal.proposer} has proposed a team`)
  })

  eventBus.on('PLAYER_LEFT', (name) => {
    toast.show(`${name} left the lobby`)
  })

  eventBus.on('PLAYER_JOINED', (name) => {
    toast.show(`${name} joined the lobby`)
  })

  eventBus.on('DISCONNECTED_FROM_LOBBY', (lobby) => {
    toast.show(`You've been disconnected from ${lobby}`)
  })
})

onBeforeUnmount(() => {
  // Clean up event listeners
  eventBus.all.clear()
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
