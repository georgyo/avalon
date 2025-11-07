<template>
  <v-container justify-center class="bg-cyan-lighten-5">
    <div class="d-flex flex-column align-center justify-center fill-height">
    <template v-if='!showLobbyInput'>
      <v-text-field
        label="Your Name" @input="name = name.toUpperCase()" ref='nameTextField' v-model="name" :error-messages='errorMsg' autofocus>
      </v-text-field>
      <v-btn
       :disabled='!name' @click='createLobby()' :loading="isCreatingLobby">
        Create Lobby
      </v-btn>
      <v-btn :disabled='!name || isCreatingLobby' @click='showLobbyInput = true'>
        Join Lobby
      </v-btn>
  </template>
   <template v-else>
    <v-text-field ref="lobbyTextField"  @input="lobby = lobby.toUpperCase()" label="Lobby" :error-messages='errorMsg' v-model="lobby" @keyup.native.enter="joinLobby()"></v-text-field>
    <v-btn :disabled='!lobby' @click='joinLobby()' :loading="isJoiningLobby">
      Join Lobby
    </v-btn>
    <v-btn @click='showLobbyInput = false' :disabled='isJoiningLobby'>
      Cancel
    </v-btn>
   </template>
  <div style='padding-top: 30px'></div>
  <StatsDisplay :stats='avalon.user.stats' :globalStats='avalon.globalStats'></StatsDisplay>
  </div>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import type { Ref } from 'vue'
import { useAvalonStore } from '@/stores/avalon'
import StatsDisplay from './StatsDisplay.vue'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const nameTextField = ref<any>(null)
const lobbyTextField = ref<any>(null)

const name = ref<string>(avalon.value.user ? avalon.value.user.name : '')
const lobby = ref<string>('')
const alertTimeoutTimer = ref<NodeJS.Timeout | null>(null)
const errorMsg = ref<string>('')
const showLobbyInput = ref<boolean>(false)
const isJoiningLobby = ref<boolean>(false)
const isCreatingLobby = ref<boolean>(false)

function genericLogin(loadingValue: Ref<boolean>, loginPromise: Promise<any>): void {
  loadingValue.value = true
  loginPromise.catch(
    (err) => showErrorMessage(err)).finally(
      () => loadingValue.value = false)
}

function createLobby(): void {
  genericLogin(isCreatingLobby, avalon.value.createLobby(name.value))
}

function joinLobby(): void {
  genericLogin(isJoiningLobby, avalon.value.joinLobby(name.value, lobby.value))
}

function showErrorMessage(errMsg: any): void {
  if (alertTimeoutTimer.value != null) {
    clearTimeout(alertTimeoutTimer.value)
  }
  errorMsg.value = errMsg.toString()
  alertTimeoutTimer.value = setTimeout(() => {
    alertTimeoutTimer.value = null
    errorMsg.value = ''
  }, 5000)
}

function setInputWidth(field: string): void {
  const size = 20
  const fieldRef = field === 'nameTextField' ? nameTextField : lobbyTextField
  fieldRef.value.$el.getElementsByTagName('input')[0].setAttribute('size', size)
}

onMounted(() => {
  setInputWidth('nameTextField')
  document.title = 'Avalon - ' + (name.value ? name.value : avalon.value.user.email)
})

watch(showLobbyInput, () => {
  let textField: string = 'lobbyTextField'
  if (!showLobbyInput.value) {
    textField = 'nameTextField'
  }
  nextTick(() => {
    const fieldRef = textField === 'nameTextField' ? nameTextField : lobbyTextField
    fieldRef.value.$el.getElementsByTagName('input')[0].focus()
    setInputWidth(textField)
  })
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
