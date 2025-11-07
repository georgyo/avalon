<template>
  <v-container
    justify-center
    class="bg-cyan-lighten-5"
  >
    <div class="d-flex flex-column align-center justify-center fill-height">
      <template v-if="!showLobbyInput">
        <v-text-field
          ref="nameTextField"
          v-model="name"
          label="Your Name"
          :error-messages="errorMsg"
          autofocus
          @input="name = name.toUpperCase()"
        />
        <v-btn
          :disabled="!name"
          :loading="isCreatingLobby"
          @click="createLobby()"
        >
          Create Lobby
        </v-btn>
        <v-btn
          :disabled="!name || isCreatingLobby"
          @click="showLobbyInput = true"
        >
          Join Lobby
        </v-btn>
      </template>
      <template v-else>
        <v-text-field
          ref="lobbyTextField"
          v-model="lobby"
          label="Lobby"
          :error-messages="errorMsg"
          @input="lobby = lobby.toUpperCase()"
          @keyup.enter="joinLobby()"
        />
        <v-btn
          :disabled="!lobby"
          :loading="isJoiningLobby"
          @click="joinLobby()"
        >
          Join Lobby
        </v-btn>
        <v-btn
          :disabled="isJoiningLobby"
          @click="showLobbyInput = false"
        >
          Cancel
        </v-btn>
      </template>
      <div style="padding-top: 30px" />
      <StatsDisplay
        :stats="avalon.user.stats"
        :global-stats="avalon.globalStats"
      />
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
