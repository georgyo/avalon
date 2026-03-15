<template>
  <v-card class="welcome bg-cyan-lighten-5">
    <div class="d-flex flex-column align-center">
      <v-card-title class="welcome-title">
        <div class='welcome'>
            <span class="welcome-heading">Avalon: The Resistance <span class="font-weight-thin">Online</span></span>
            <p class='mt-4 pt-2'>
              <span class='text-subtitle-1'>
                A game of social deduction for 5 to 10 people, now on desktop and mobile.
              </span>
            </p>
        </div>
      </v-card-title>
      <div class="pa-4">
        <v-btn
          @click='signInAnonymously()'
          :loading="isLoggingIn"
          :error-messages='errorMessage'
          data-testid="anonymous-login"
          size="large"
          color="primary"
        >
          Play Now
        </v-btn>
        <div v-if="errorMessage" class="text-error mt-2">{{ errorMessage }}</div>
      </div>
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
      errorMessage: '',
      isLoggingIn: false,
    };
  },
  props: {
    avalon: Object
  },
  mounted() {
    document.title = 'Avalon (Not Logged In)'
  },
  methods: {
    signInAnonymously() {
      this.errorMessage = '';
      this.isLoggingIn = true;
      this.avalon!.signInAnonymously()
        .catch((err: Error) => {
          this.errorMessage = err.message;
        })
        .finally(() => {
          this.isLoggingIn = false;
        });
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

@media (min-width: 600px) {
  .welcome-heading {
    font-size: 3rem;
  }
}

</style>
