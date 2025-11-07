<template>
  <v-card class="blue-grey lighten-4">
    <v-card-title>
      Assassination Attempt
     </v-card-title>
     <v-card-text class="light-blue lighten-4">
      <div v-if='avalon.lobby.role.assassin'>
        <v-btn
         v-bind:disabled='!isValidSelection'
         v-bind:loading='isAssassinating'
         @click='assassinate()'>
                {{ assassinateButtonText }}
        </v-btn>
       </div>
       <div v-else>
           Waiting for target selection
       </div>
     </v-card-text>
  </v-card>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const props = defineProps({
  playerList: Array
})

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const isAssassinating = ref(false)

const isValidSelection = computed(() => {
  return (props.playerList.length == 1) &&
          (props.playerList[0] != avalon.value.user.name)
})

const assassinateButtonText = computed(() => {
  if (isValidSelection.value) {
    return "Assassinate " + props.playerList[0]
  } else {
    return "Select target"
  }
})

function assassinate() {
  isAssassinating.value = true
  avalon.value.assassinate(props.playerList[0])
}
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>