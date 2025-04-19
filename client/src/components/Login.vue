<template>
  <v-container
    justify-center
    class="cyan lighten-5"
  >
    <v-layout
      align-center
      justify-center
      column
      fill-height
    >
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
          @keyup.native.enter="joinLobby()"
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
    </v-layout>
  </v-container>
</template>

<script>
import StatsDisplay from './StatsDisplay.vue'

export default {
  name: 'Login',
  components: {
    StatsDisplay
  },
  props: {
    avalon: Object
  },
  data() {
    return {
      name: this.avalon.user ? this.avalon.user.name : '',
      lobby: '',
      alertTimeoutTimer: null,
      errorMsg: '',
      showLobbyInput: false,
      isJoiningLobby: false,
      isCreatingLobby: false
    };
  },
  watch: {
    showLobbyInput: function() {
      const vm = this;
      let textField = 'lobbyTextField';
      if (!this.showLobbyInput) {
        textField = 'nameTextField';
      }
      this.$nextTick(() => {
        vm.$refs[textField].$el.getElementsByTagName('input')[0].focus();
        vm.setInputWidth(textField);
      });
    }
  },
  mounted: function() {
    this.setInputWidth('nameTextField');
    document.title = 'Avalon - ' + (this.name ? this.name : this.avalon.user.email);
  },
  methods: {
    genericLogin(loadingValue, loginPromise) {
      this[loadingValue] = true;
      loginPromise.catch(
        (err) => this.showErrorMessage(err)).finally(
          () => this[loadingValue] = false);
    },
    createLobby() {
      this.genericLogin('isCreatingLobby', this.avalon.createLobby(this.name));
    },
    joinLobby() {
      this.genericLogin('isJoiningLobby', this.avalon.joinLobby(this.name, this.lobby));
    },
    showErrorMessage(errMsg) {
      const vm = this;
      if (vm.alertTimeoutTimer != null) {
        clearTimeout(vm.alertTimeoutTimer);
      }
      vm.errorMsg = errMsg.toString();
      this.alertTimeoutTimer = setTimeout(() => {
        vm.alertTimeoutTimer = null;
        vm.errorMsg = '';
      }, 5000);
    },
    setInputWidth(field) {
      const size = 20;
      this.$refs[field].$el.getElementsByTagName('input')[0].setAttribute('size', size);
    }
  }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
