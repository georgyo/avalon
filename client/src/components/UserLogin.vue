<template>
  <v-card class="welcome cyan lighten-5">
    <v-layout
      align-center
      justify-center
      column
      fill-height
    >
      <v-card-title>
        <v-alert
          :value="avalon.confirmingEmailError"
          type="error"
        >
          {{ avalon.confirmingEmailError }} Please try logging in again.
        </v-alert>

        
        <div class="welcome">
          <span class="dtext-h3Avalon:"> The Resistance <span class="font-weight-thin">Online</span></span>
          <p class="mt-4 pt-2">
            <span class="subheading">
              A game of social deduction for 5 to 10 people, now on desktop and mobile.
            </span>
          </p>
        </div>
      </v-card-title>
      <v-tabs
        v-model="tab"
        center-active
        align-center
        fill-height
        centered
        grow
      >
        <v-tabs-slider />
        <v-tab key="email">
          Email
        </v-tab>
        <v-tab key="anonymous">
          Anonymous
        </v-tab>
      </v-tabs>
      <v-tabs-items
        v-model="tab"
        continuous
        center-active
        align-center
        fill-height
        centered
      >
        <v-tab-item key="email">
          <template v-if="!emailSubmitted">
            <v-text-field
              ref="userEmailField" 
              v-model="emailAddr"
              label="Email Address"
              type="email"
              autocomplete="email"
              :error-messages="errorMessage"
              autofocus
              @keyup="clearErrorMessage()"
              @keyup.enter="submitEmailAddress()"
            />
            <v-btn
              :loading="isSubmittingEmailAddr"
              @click="submitEmailAddress()"
            >
              Login
            </v-btn>
          </template>
          <template v-else>
            <v-card
              xs6
              md3
              class="blue-grey lighten-4"
            >
              <v-card-text class="text-center">
                <p>Check your email for the verification link</p>
              </v-card-text>
            </v-card>
            <v-btn
              class="mt-4"
              @click="resetForm()"
            >
              Try Again
            </v-btn>
          </template>
        </v-tab-item>
        <v-tab-item key="anonymous">
          <v-btn
            @click="signInAnonymously()"
          >
            Login
          </v-btn>
        </v-tab-item>
      </v-tabs-items>
    </v-layout>
    <v-layout
      column
      align-end
    >
      <v-flex class="mt-4 pt-4">
        <v-btn
          small
          href="mailto:avalon@shamm.as"
          target="_blank"
          color="grey lighten-2"
        >
          <v-icon
            left
            small
          >
            fas fa-envelope-square
          </v-icon>
          <span>Email</span>
        </v-btn>
      </v-flex>
    </v-layout>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  name: 'UserLogin',
  props: {
    avalon: Object
  },
  data() {
    return {
      tab: null,
      emailAddr: '',
      errorMessage: '',
      isSubmittingEmailAddr: false,
      emailSubmitted: false
    };
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
        this.avalon.submitEmailAddr(this.emailAddr).then(function() {
            this.emailSubmitted = true;
        }.bind(this)).catch(function(err) {
            this.errorMessage = err.message;
        }.bind(this)).finally(function() {
            this.isSubmittingEmailAddr = false;
        }.bind(this));
    },
    signInAnonymously() {
      this.clearErrorMessage();
      this.avalon.signInAnonymously()
      .then()
      .catch((err) => this.errorMessage = err.message)
    },
    resetForm() {
        this.emailSubmitted = false;
    }
  }
}
);
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

.welcome {
  padding-top: 30px;
  padding-bottom: 30px;
  text-align: center;
}

</style>
