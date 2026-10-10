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
        <v-tabs v-model="tab" center-active grow>
          <v-tab value="anonymous" data-testid="anonymous-tab">Choose a name</v-tab>
        </v-tabs>
        <v-window v-model="tab">
      <v-window-item value="anonymous">
        <div class="pa-4 login-form">
          <v-text-field
            label="Your Name"
            data-testid="login-name"
            :model-value="name"
            @update:model-value="val => name = val.toUpperCase()"
            :rules="nameRules"
            :error-messages="errorMessage"
            @keyup.enter="signInAnonymously()"
            autofocus
            class="login-name" />
          <v-btn
             data-testid="login-button"
             :disabled="!nameValid"
             :loading="signingIn"
             @click='signInAnonymously()'>
              Login
          </v-btn>
          <p class="text-caption mt-4 login-note">
            No account needed: this browser creates its own anonymous key. Your games and stats stay on
            this device; clearing the site data starts you over.
          </p>
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
import { ROLES } from '@avalon/common/avalonlib'

export default defineComponent({
  name: 'UserLogin',
  data() {
    return {
      tab: 'anonymous',
      name: (this.avalon && this.avalon.preferredName) || '',
      errorMessage: '',
      signingIn: false,
    };
  },
  props: {
    avalon: { type: Object, required: true }
  },
  computed: {
    nameRules() {
      const roleNames = ROLES.map(r => r.name);
      return [
        (v: string) => !!v || 'Name is required',
        (v: string) => /^[A-Z]+$/.test(v) || 'Name must contain only letters (A-Z)',
        (v: string) => v.length <= 20 || 'Name must be 20 characters or fewer',
        (v: string) => !roleNames.includes(v) || 'Name cannot be a role name',
      ];
    },
    nameValid(): boolean {
      return this.nameRules.every(rule => rule(this.name) === true);
    }
  },
  mounted() {
    document.title = 'Avalon (Not Logged In)'
  },
  methods: {
    signInAnonymously() {
      if (!this.nameValid || this.signingIn) return;
      this.errorMessage = '';
      this.signingIn = true;
      this.avalon.signInAnonymously(this.name)
        .catch((err: Error) => { this.errorMessage = err.message; })
        .finally(() => { this.signingIn = false; });
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

.login-name :deep(input) {
  text-transform: uppercase;
}

.login-note {
  max-width: 400px;
}

@media (min-width: 600px) {
  .welcome-heading {
    font-size: 3rem;
  }
}

</style>
