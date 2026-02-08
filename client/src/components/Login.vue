<template>
  <v-container class="d-flex justify-center bg-cyan-lighten-5">
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
    <v-text-field ref="lobbyTextField" @input="lobby = lobby.toUpperCase()" label="Lobby" :error-messages='errorMsg' v-model="lobby" @keyup.enter="joinLobby()"></v-text-field>
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

<script lang="ts">
import { defineComponent } from 'vue'
import StatsDisplay from './StatsDisplay.vue'

export default defineComponent({
  name: 'Login',
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
  methods: {
    genericLogin(loadingValue: string, loginPromise: Promise<any>) {
      (this as any)[loadingValue] = true;
      loginPromise.catch(
        (err: any) => this.showErrorMessage(err)).finally(
          () => (this as any)[loadingValue] = false);
    },
    createLobby() {
      this.genericLogin('isCreatingLobby', this.avalon.createLobby(this.name));
    },
    joinLobby() {
      this.genericLogin('isJoiningLobby', this.avalon.joinLobby(this.name, this.lobby));
    },
    showErrorMessage(errMsg: any) {
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
      const ref = (this.$refs as any)[field];
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
        const ref = (this.$refs as any)[textField];
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

</style>
