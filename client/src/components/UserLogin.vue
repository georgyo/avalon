<template>
  <v-card class="welcome bg-cyan-lighten-5">
    <div class="d-flex flex-column align-center justify-center fill-height">
      <v-card-title>

       <v-alert
        :value="avalon.confirmingEmailError"
        type="error"
       >
        {{ avalon.confirmingEmailError }} Please try logging in again.
        </v-alert>

        
        <div class='welcome'>
            <span class=dtext-h3Avalon:> The Resistance <span class="font-weight-thin">Online</span></span>
            <p class='mt-4 pt-2'>
              <span class='subheading'>
                A game of social deduction for 5 to 10 people, now on desktop and mobile.
              </span>
            </p>
        </div>
      </v-card-title>
        <v-tabs v-model="tab" align-tabs="center" grow>
          <v-tab value="email">Email</v-tab>
          <v-tab value="anonymous">Anonymous</v-tab>
      </v-tabs>
      <v-window v-model="tab">
        <v-window-item value="email">
        <template v-if='!emailSubmitted'>
          <v-text-field
           label="Email Address" 
           ref='userEmailField'
           v-model='emailAddr'
           type="email"
           autocomplete="email"
           @keyup='clearErrorMessage()'
           @keyup.native.enter='submitEmailAddress()'
           :error-messages='errorMessage'
           autofocus />
          <v-btn
           @click='submitEmailAddress()' :loading="isSubmittingEmailAddr">
            Login
          </v-btn>
        </template>
        <template v-else>
          <v-card xs6 md3 class="bg-blue-grey-lighten-4">
            <v-card-text class="text-center">
                <p>Check your email for the verification link</p>
            </v-card-text>
          </v-card>
          <v-btn class='mt-4'
           @click='resetForm()'>
            Try Again
          </v-btn>
        </template>
      </v-window-item>
    <v-window-item value="anonymous">
      <v-btn
           @click='signInAnonymously()'>
            Login
        </v-btn>
    </v-window-item>
      </v-window>

        </div>
      <div class="d-flex flex-column align-end">
        <v-col cols="12" class='mt-4 pt-4'>
          <v-btn size="small" href='mailto:avalon@shamm.as' target="_blank" color='grey-lighten-2'>
            <v-icon start small>
              fas fa-envelope-square
            </v-icon>
            <span>Email</span>
          </v-btn>
        </v-col>
      </div>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAvalonStore } from '@/stores/avalon'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const tab = ref<string>('email')
const emailAddr = ref<string>('')
const errorMessage = ref<string>('')
const isSubmittingEmailAddr = ref<boolean>(false)
const emailSubmitted = ref<boolean>(false)

onMounted(() => {
  document.title = 'Avalon (Not Logged In)'
})

function clearErrorMessage(): void {
  errorMessage.value = ''
}

function submitEmailAddress(): void {
  isSubmittingEmailAddr.value = true
  clearErrorMessage()
  avalon.value.confirmingEmailError = '' // this is not very clean but eh
  avalon.value.submitEmailAddr(emailAddr.value)
    .then(() => {
      emailSubmitted.value = true
    })
    .catch((err: any) => {
      errorMessage.value = err.message
    })
    .finally(() => {
      isSubmittingEmailAddr.value = false
    })
}

function signInAnonymously(): void {
  clearErrorMessage()
  avalon.value.signInAnonymously()
    .then()
    .catch((err: any) => errorMessage.value = err.message)
}

function resetForm(): void {
  emailSubmitted.value = false
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

.welcome {
  padding-top: 30px;
  padding-bottom: 30px;
  text-align: center;
}

</style>
