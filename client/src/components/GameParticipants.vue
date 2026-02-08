<template>
    <v-tabs v-model="activeTab" grow>
      <v-tab value="players" class="bg-light-blue-lighten-4">
          Players
      </v-tab>
      <v-tab value="roles" class="bg-light-blue-lighten-4">
          Roles
      </v-tab>
    </v-tabs>
    <v-window v-model="activeTab">
      <v-window-item value="players">
          <GamePlayerList :avalon='avalon' @selected-players='$emit("selected-players", $event)'></GamePlayerList>
      </v-window-item>
      <v-window-item value="roles">
          <RoleList
           :roles='avalon.lobby.game.roles.map(r => avalon.config.roleMap[r])'
           :allowSelect='false'></RoleList>
      </v-window-item>
    </v-window>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import GamePlayerList from './GamePlayerList.vue'
import RoleList from './RoleList.vue'

export default defineComponent({
  name: 'GameParticipants',
  props: [ 'avalon' ],
  emits: ['selected-players'],
  components: { GamePlayerList, RoleList },
  data() {
    return {
      activeTab: 'players'
    }
  }
})
</script>
