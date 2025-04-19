<template>
  <v-toolbar class="blue darken-1">
    <template v-if="avalon.lobby && avalon.lobby.name && avalon.user && avalon.user.name">
      <v-icon left>
        room
      </v-icon>
      <span class="font-weight-bold cyan--text text--lighten-5">{{ avalon.lobby.name }}</span>
      <v-spacer />
      <ViewRoleButton :avalon="avalon" />
      <v-spacer />
      <ToolbarQuitButton :avalon="avalon" />
    </template>
    <template v-else>
      <span>{{ avalon.user.email }}</span>
      <v-spacer />
      <LogoutButton :avalon="avalon" />
    </template>
  </v-toolbar>
</template>

<script>
import ToolbarQuitButton from './ToolbarQuitButton.vue';
import ViewRoleButton from './ViewRoleButton.vue'
import LogoutButton from './LogoutButton.vue'

export default {
  name: 'AvalonToolbar',
  components: {
    ToolbarQuitButton,
    ViewRoleButton,
    LogoutButton
  },
  props: [ 'avalon' ]
 }
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
