<template>
  <div>
  <v-list class="bg-blue-grey-lighten-4">
    <v-list-item
     v-for="(role, index) in roles"
      :key="index">
      <template v-slot:prepend>
        <v-checkbox
         v-if="allowSelect"
         color="black"
         v-model='role.selected'
         hide-details
         density="compact"
         class="mr-2"
         ></v-checkbox>
        <v-icon v-if='role.team == "good"' icon="fa:fab fa-old-republic" />
        <v-icon v-else color="red" icon="fa:fab fa-empire" />
      </template>
      <v-list-item-title>{{role.name}}</v-list-item-title>
      <template v-slot:append>
        <v-btn icon variant="text" @click='showRoleInfo(role)' size="small"><v-icon>mdi-information</v-icon></v-btn>
      </template>
  </v-list-item>
  </v-list>
  <v-dialog v-model="roleInfo" max-width='450'>
    <v-card class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
          <v-icon start v-if='selectedRole.team == "good"' icon="fa:fab fa-old-republic" />
          <v-icon start v-else color="red" icon="fa:fab fa-empire" />
          <h3>{{ selectedRole.name }}</h3>
        </v-card-title>
        <v-card-text>
          {{ selectedRole.description }}
        </v-card-text>
    </v-card>
  </v-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'RoleList',
  props: [ 'roles', 'allowSelect'],
  data() {
    return {
      roleInfo: false,
      selectedRole: { name: '', team: '', description: '' } as any
    }
  },
  methods: {
    showRoleInfo(role: any) {
      this.roleInfo = true;
      this.selectedRole = role;
    }
  }
 })
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
