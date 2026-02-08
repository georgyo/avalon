<template>
  <v-card class="welcome bg-cyan-lighten-5">
    <div class="d-flex flex-column align-center justify-center fill-height">
      <v-card-title>

       <v-alert
        v-if="avalon.confirmingEmailError"
        type="error"
       >
        {{ avalon.confirmingEmailError }} Please try logging in again.
        </v-alert>


        <div class='welcome'>
            <span class="text-h3">Avalon: The Resistance <span class="font-weight-thin">Online</span></span>
            <p class='mt-4 pt-2'>
              <span class='text-subtitle-1'>
                A game of social deduction for 5 to 10 people, now on desktop and mobile.
              </span>
            </p>
        </div>
      </v-card-title>
        <v-tabs v-model="tab" center-active grow>
          <v-tab value="email">Email</v-tab>
          <v-tab value="anonymous">Anonymous</v-tab>
        </v-tabs>
        <v-window v-model="tab">
          <v-window-item value="email">
          <div class="pa-4">
          <template v-if='!emailSubmitted'>
            <v-text-field
             label="Email Address"
             ref='userEmailField'
             v-model='emailAddr'
             type="email"
             autocomplete="email"
             @keyup='clearErrorMessage()'
             @keyup.enter='submitEmailAddress()'
             :error-messages='errorMessage'
             autofocus />
            <v-btn
             @click='submitEmailAddress()' :loading="isSubmittingEmailAddr">
              Login
            </v-btn>
          </template>
          <template v-else>
            <v-card class="bg-blue-grey-lighten-4">
              <v-card-text class="text-center">
                  <p>Check your email for the verification link</p>
              </v-card-text>
            </v-card>
            <v-btn class='mt-4'
             @click='resetForm()'>
              Try Again
            </v-btn>
          </template>
          </div>
        </v-window-item>
      <v-window-item value="anonymous">
        <div class="pa-4">
        <v-btn
             @click='signInAnonymously()'>
              Login
          </v-btn>
        </div>
      </v-window-item>
        </v-window>

        </div>
      <div class="d-flex flex-column align-end">
        <div class='mt-4 pt-4'>
          <v-btn size="small" href='mailto:avalon@shamm.as' target="_blank" color='grey-lighten-2'>
            <v-icon start size="small" icon="fa:fas fa-envelope-square" />
            <span>Email</span>
          </v-btn>
        </div>
      </div>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'UserLogin',
  data() {
    return {
      tab: 'email',
      emailAddr: '',
      errorMessage: '',
      isSubmittingEmailAddr: false,
      emailSubmitted: false
    };
  },
  props: {
    avalon: Object
  },
  mounted() {
    document.title = 'Avalon (Not Logged In)'
  },
  methods: {
    clearErrorMessage() {
        this.errorMessage = '';
    },
    submitEmailAddress() {
        this.isSubmittingEmailAddr = true;
        this.clearErrorMessage();
        this.avalon!.confirmingEmailError = '';
        this.avalon!.submitEmailAddr(this.emailAddr).then(() => {
            this.emailSubmitted = true;
        }).catch((err: Error) => {
            this.errorMessage = err.message;
        }).finally(() => {
            this.isSubmittingEmailAddr = false;
        });
    },
    signInAnonymously() {
      this.clearErrorMessage();
      this.avalon!.signInAnonymously()
      .then()
      .catch((err: Error) => this.errorMessage = err.message)
    },
    resetForm() {
        this.emailSubmitted = false;
    }
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

.welcome {
  padding-top: 30px;
  padding-bottom: 30px;
  text-align: center;
}

</style>
