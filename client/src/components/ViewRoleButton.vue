<template>
  <v-bottom-sheet v-model="sheet">
    <template v-slot:activator="{ props }">
      <v-btn v-bind="props">
        <v-icon start>
          perm_identity
          <!-- person -->
        </v-icon>
        {{ avalon.user.name }}
      </v-btn>
    </template>
    <v-card class="bg-cyan-lighten-4">
      <template v-if='!avalon.isGameInProgress'>
      <v-card-title>
        <div class="d-flex flex-column align-center justify-center w-100">
          <div class="font-weight-bold">When the game starts, you will see your role here.</div>
        </div>
      </v-card-title>
      <v-card-text>
        <div class="d-flex flex-column align-center justify-center">
          <p class='text-subtitle-1'>Your Stats</p>
          <StatsDisplay :stats='avalon.user.stats' :globalStats='avalon.globalStats' />
        </div>
      </v-card-text>
      </template>
      <template v-else>
      <v-card-title class="bg-cyan-lighten-2">
          <v-icon start v-if='avalon.lobby.role.role.team == "good"'>fab fa-old-republic</v-icon>
          <v-icon start v-else color="red">fas fa-empire</v-icon>
          <span class='text-h5'>{{ avalon.lobby.role.role.name }}</span>
      </v-card-title>
      <v-card-text>
           <p>Your role is <span class='font-weight-medium'>{{ avalon.lobby.role.role.name}}</span>.</p>
           <p>You are on the <span class='font-weight-medium'>{{ avalon.lobby.role.role.team }}</span> team.</p>
           <p>{{ avalon.lobby.role.role.description }}</p>
           <p v-if='avalon.lobby.role.assassin'>
             You are also the <span class='font-weight-medium'>ASSASSIN</span>!
             It will be up to you to identify MERLIN if the good team succeeds 3 missions.
           </p>
           <div v-if='avalon.lobby.role.sees.length'>
               <p>You see <span class='font-weight-bold'>{{ avalon.lobby.role.sees.joinWithAnd() }}</span>.</p>
           </div>
           <p v-else>
             You do not see anyone.
           </p>
      </v-card-text>
      </template>
    </v-card>
  </v-bottom-sheet>
</template>

<script setup>
import { ref, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import { useAvalonStore } from '@/stores/avalon'
import StatsDisplay from './StatsDisplay.vue'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())
const eventBus = inject('eventBus')

const sheet = ref(false)

onMounted(() => {
  eventBus.on('show-role', () => sheet.value = true)
  eventBus.on('GAME_ENDED', () => sheet.value = false)
})

onBeforeUnmount(() => {
  // Clean up is handled by parent EventHandler
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
