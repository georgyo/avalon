<template>
  <div>
    <v-dialog v-model="kickPlayerDialog" max-width='450'>
      <v-card class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
          <h3>Kick {{playerToKick}}?</h3>
        </v-card-title>
        <v-card-text>Do you wish to kick {{ playerToKick }} from the lobby?</v-card-text>
        <v-divider></v-divider>
        <v-card-actions>
          <v-btn @click="kickPlayer(playerToKick)">Kick {{ playerToKick }}</v-btn>
          <v-btn @click="kickPlayerDialog = false">Cancel</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-list class="bg-blue-grey-lighten-4">
      <draggable
        v-model="playerList"
        item-key="player"
        handle=".handle"
        :disabled=!canDrag
        @end="onReorderList()">
        <template #item="{ element }">
        <v-list-item :key="element">
          <v-icon start v-if="canDrag" class="handle">fas fa-bars</v-icon>
          <v-icon start v-if="element == avalon.lobby.admin.name">star</v-icon>
          <v-icon start v-else-if="element == avalon.user.name">perm_identity</v-icon>
          <v-icon start v-else>person</v-icon>
          <v-col cols="10">{{element}}</v-col>
          <v-col cols="1">
            <v-btn
              v-if="(avalon.isAdmin && element != avalon.user.name && !avalon.isGameInProgress)"
              :loading="playersBeingKicked.includes(element)"
              @click.stop="kickPlayerConfirm(element)"
              icon
              variant="text"
              color="black">
              <v-icon>clear</v-icon>
            </v-btn>
          </v-col>
        </v-list-item>
        </template>
      </draggable>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAvalonStore } from '../stores/avalon'
import draggable from "vuedraggable"

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const playerList = ref(avalon.value.config.playerList)
const kickPlayerDialog = ref(false)
const playerToKick = ref("")
const playersBeingKicked = ref([])

const canDrag = computed(() => {
  return avalon.value.isAdmin && !avalon.value.isGameInProgress
})

function onReorderList(): void {
  avalon.value.config.sortList(playerList.value)
}

function kickPlayerConfirm(player: string): void {
  playerToKick.value = player
  kickPlayerDialog.value = true
}

function kickPlayer(player: string): void {
  kickPlayerDialog.value = false
  playersBeingKicked.value.push(player)
  avalon.value.kickPlayer(player).finally(() =>
    playersBeingKicked.value.splice(
      playersBeingKicked.value.indexOf(player), 1
    )
  )
}

watch(() => avalon.value.config.playerList, (list) => {
  playerList.value = list
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>
