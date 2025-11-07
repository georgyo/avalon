<template>
  <v-app-bar class='bg-blue-darken-1' elevation="1">
    <template v-if="avalon.lobby && avalon.lobby.name && avalon.user && avalon.user.name">
    <v-icon>
      room
    </v-icon>
     <span class="font-weight-bold text-cyan-lighten-5 ml-2">{{ avalon.lobby.name }}</span>
    <v-spacer></v-spacer>
    <ViewRoleButton :avalon='avalon'></ViewRoleButton>
    <v-spacer></v-spacer>
    <ToolbarQuitButton :avalon='avalon'></ToolbarQuitButton>
    </template>
    <template v-else>
      <span>{{ avalon.user.email }}</span>
      <v-spacer></v-spacer>
      <LogoutButton :avalon='avalon' />
    </template>
  </v-app-bar>
</template>

<script>
import ToolbarQuitButton from './ToolbarQuitButton.vue';
import ViewRoleButton from './ViewRoleButton.vue'
import LogoutButton from './LogoutButton.vue'

export default {
  name: 'Toolbar',
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
