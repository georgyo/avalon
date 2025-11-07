<template>
  <div>
  <v-list class="bg-blue-grey-lighten-4">
    <v-list-item
     v-for="(role, index) in roles"
      :key="index">
    <v-col v-if="allowSelect" cols="1">
      <v-checkbox
       color="black"
       v-model='role.selected'
       ></v-checkbox>
    </v-col>
      <v-col cols="10">
        <!-- setting 'end' property if we allow select to give space between checkbox at the start -->
        <v-icon :end='allowSelect' v-if='role.team == "good"'>fab fa-old-republic</v-icon>
        <v-icon :end='allowSelect' v-else color="red">fas fa-empire</v-icon>
        {{role.name}}
      </v-col>
    <v-col cols="2">
      <v-btn icon @click='showRoleInfo(role)'><v-icon>info</v-icon>
      </v-btn>
    </v-col>
  </v-list-item>
  </v-list>
  <v-dialog v-model="roleInfo" max-width='450'>
    <v-card class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
          <v-icon start v-if='selectedRole.team == "good"'>fab fa-old-republic</v-icon>
          <v-icon start v-else color="red">fas fa-empire</v-icon>
          <h3>{{ selectedRole.name }}</h3>
        </v-card-title>
        <v-card-text>
          {{ selectedRole.description }}
        </v-card-text>
    </v-card>
  </v-dialog>
  </div>
</template>

<script>
export default {
  name: 'RoleList',
  props: [ 'roles', 'allowSelect'],
  data() {
    return {
      roleInfo: false,
      selectedRole: 'blah'
    }
  },
  methods: {
    showRoleInfo(role) {
      this.roleInfo = true;
      this.selectedRole = role;
    }
  }
 }
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
