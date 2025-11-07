<template>
  <v-container justify-center class="bg-cyan-lighten-5">
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
    <v-text-field ref="lobbyTextField"  @input="lobby = lobby.toUpperCase()" label="Lobby" :error-messages='errorMsg' v-model="lobby" @keyup.native.enter="joinLobby()"></v-text-field>
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

<script>
import StatsDisplay from './StatsDisplay.vue'

export default {
  name: 'Login',
  components: {
    StatsDisplay
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
  props: {
    avalon: Object
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
  },
  mounted: function() {
    this.setInputWidth('nameTextField');
    document.title = 'Avalon - ' + (this.name ? this.name : this.avalon.user.email);
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
  }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
