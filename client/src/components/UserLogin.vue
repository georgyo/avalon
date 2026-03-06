<template>
  <v-card class="welcome bg-cyan-lighten-5">
    <div class="d-flex flex-column align-center">
      <v-card-title class="welcome-title">

       <v-alert
        v-if="avalon.confirmingEmailError"
        type="error"
       >
        {{ avalon.confirmingEmailError }} Please try logging in again.
        </v-alert>


        <div class='welcome'>
            <span class="welcome-heading">Avalon: The Resistance <span class="font-weight-thin">Online</span></span>
            <p class='mt-4 pt-2'>
              <span class='text-subtitle-1'>
                A game of social deduction for 5 to 10 people, now on desktop and mobile.
              </span>
            </p>
        </div>
      </v-card-title>
        <v-tabs v-model="tab" center-active grow>
          <v-tab value="email" data-testid="email-tab">Email</v-tab>
          <v-tab value="anonymous" data-testid="anonymous-tab">Anonymous</v-tab>
        </v-tabs>
        <v-window v-model="tab">
          <v-window-item value="email">
          <div class="pa-4 login-form">
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
            <v-text-field
             label="Password"
             v-model='password'
             type="password"
             autocomplete="current-password"
             @keyup='clearErrorMessage()'
             @keyup.enter='submitEmailAddress()'
             :error-messages='errorMessage' />
            <v-btn
             @click='submitEmailAddress()' :loading="isSubmittingEmailAddr">
              Login
            </v-btn>
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
      password: '',
      errorMessage: '',
      isSubmittingEmailAddr: false,
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
        this.avalon!.submitEmailAddr(this.emailAddr, this.password).then(() => {
            // Successfully logged in
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

.welcome-title {
  width: 100%;
  white-space: normal;
  word-wrap: break-word;
}

.welcome-heading {
  font-size: 1.75rem;
  font-weight: 400;
  line-height: 1.3;
}

.login-form {
  width: 100%;
  max-width: 450px;
  min-width: 280px;
}

@media (min-width: 600px) {
  .welcome-heading {
    font-size: 3rem;
  }
}

</style>
