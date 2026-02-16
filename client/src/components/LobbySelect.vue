<template>
  <v-container class="d-flex justify-center bg-cyan-lighten-5 lobby-select-container">
    <div class="d-flex flex-column align-center justify-center fill-height lobby-select-inner">
    <template v-if='!showLobbyInput'>
      <v-text-field
        label="Your Name" @update:model-value="val => name = val.toUpperCase()" ref='nameTextField' v-model="name" :rules="nameRules" :error-messages='errorMsg' autofocus
        class="lobby-input">
      </v-text-field>
      <div class="d-flex flex-column flex-sm-row ga-2 lobby-buttons">
        <v-btn
         :disabled='!name' @click='createLobby()' :loading="isCreatingLobby" block>
          Create Lobby
        </v-btn>
        <v-btn :disabled='!name || isCreatingLobby' @click='showLobbyInput = true' block>
          Join Lobby
        </v-btn>
      </div>
  </template>
   <template v-else>
    <v-text-field ref="lobbyTextField" @update:model-value="val => lobby = val.toUpperCase()" label="Lobby" :error-messages='errorMsg' v-model="lobby" @keyup.enter="joinLobby()"
      class="lobby-input"></v-text-field>
    <div class="d-flex flex-column flex-sm-row ga-2 lobby-buttons">
      <v-btn :disabled='!lobby' @click='joinLobby()' :loading="isJoiningLobby" block>
        Join Lobby
      </v-btn>
      <v-btn @click='showLobbyInput = false' :disabled='isJoiningLobby' block>
        Cancel
      </v-btn>
    </div>
   </template>
  <div style='padding-top: 30px'></div>
  <StatsDisplay :stats='avalon.user.stats' :globalStats='avalon.globalStats'></StatsDisplay>
  </div>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { ROLES } from '@avalon/common/avalonlib'
import StatsDisplay from './StatsDisplay.vue'

export default defineComponent({
  name: 'LobbySelect',
  components: {
    StatsDisplay
  },
  data() {
    return {
      name: this.avalon.user ? this.avalon.user.name : '',
      lobby: '',
      alertTimeoutTimer: null as ReturnType<typeof setTimeout> | null,
      errorMsg: '',
      showLobbyInput: false,
      isJoiningLobby: false,
      isCreatingLobby: false
    };
  },
  props: {
    avalon: Object
  },
  computed: {
    nameRules() {
      const roleNames = ROLES.map(r => r.name);
      return [
        (v: string) => !!v || 'Name is required',
        (v: string) => /^[A-Z]+$/.test(v) || 'Name must contain only letters (A-Z)',
        (v: string) => !roleNames.includes(v) || 'Name cannot be a role name',
      ];
    }
  },
  methods: {
    genericLogin(loadingValue: 'isCreatingLobby' | 'isJoiningLobby', loginPromise: Promise<void>) {
      this[loadingValue] = true;
      loginPromise.catch(
        (err: Error) => this.showErrorMessage(err)).finally(
          () => this[loadingValue] = false);
    },
    createLobby() {
      this.genericLogin('isCreatingLobby', this.avalon.createLobby(this.name));
    },
    joinLobby() {
      this.genericLogin('isJoiningLobby', this.avalon.joinLobby(this.name, this.lobby));
    },
    showErrorMessage(errMsg: Error | string) {
      if (this.alertTimeoutTimer != null) {
        clearTimeout(this.alertTimeoutTimer);
      }
      this.errorMsg = errMsg.toString();
      this.alertTimeoutTimer = setTimeout(() => {
        this.alertTimeoutTimer = null;
        this.errorMsg = '';
      }, 5000);
    },
    setInputWidth(field: string) {
      const size = 20;
      const ref = (this.$refs as Record<string, { $el?: HTMLElement }>)[field];
      if (ref && ref.$el) {
        const input = ref.$el.querySelector('input');
        if (input) input.setAttribute('size', size.toString());
      }
    }
  },
  mounted: function() {
    this.setInputWidth('nameTextField');
    document.title = 'Avalon - ' + (this.name ? this.name : this.avalon.user.email);
  },
  watch: {
    showLobbyInput: function() {
      let textField = 'lobbyTextField';
      if (!this.showLobbyInput) {
        textField = 'nameTextField';
      }
      this.$nextTick(() => {
        const ref = (this.$refs as Record<string, { $el?: HTMLElement }>)[textField];
        if (ref && ref.$el) {
          const input = ref.$el.querySelector('input');
          if (input) {
            input.focus();
            input.setAttribute('size', '20');
          }
        }
      });
    }
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.lobby-select-container {
  padding: 12px;
}

.lobby-select-inner {
  width: 100%;
  max-width: 450px;
}

.lobby-input {
  width: 100%;
}

.lobby-buttons {
  width: 100%;
}

@media (min-width: 600px) {
  .lobby-select-container {
    padding: 16px;
  }
}
</style>
