<template>
  <v-btn :loading='loggingOut' @click='logoutButtonClicked()'>
    <v-icon start>$exitToApp</v-icon>
      Logout
  </v-btn>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'

export default defineComponent({
  name: 'LogoutButton',
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
      return {
          loggingOut: false
      };
  },
  methods: {
      logoutButtonClicked() {
          // forgets this device's anonymous key (refused while a game is running)
          this.loggingOut = true;
          this.avalon.logout()
            .catch((err: Error) => this.toast.error(err.message))
            .finally(() => { this.loggingOut = false; });
      }
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
