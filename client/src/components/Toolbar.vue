<template>
  <v-app-bar class='bg-blue-darken-1' elevation="1">
    <template v-if="avalon.lobby && avalon.lobby.name && avalon.user && avalon.user.name">
    <v-icon>
      room
    </v-icon>
     <span class="font-weight-bold text-cyan-lighten-5 ml-2">{{ avalon.lobby.name }}</span>
    <v-spacer></v-spacer>
    <ViewRoleButton />
    <v-spacer></v-spacer>
    <ToolbarQuitButton />
    </template>
    <template v-else>
      <span>{{ avalon.user.email }}</span>
      <v-spacer></v-spacer>
      <LogoutButton />
    </template>
  </v-app-bar>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAvalonStore } from '@/stores/avalon'
import ToolbarQuitButton from './ToolbarQuitButton.vue'
import ViewRoleButton from './ViewRoleButton.vue'
import LogoutButton from './LogoutButton.vue'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
