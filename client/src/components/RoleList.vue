<template>
  <div>
    <v-list class="blue-grey lighten-4">
      <v-list-item
        v-for="(role, index) in roles"
        :key="index"
      >
        <v-flex
          v-if="allowSelect"
          xs1
        >
          <v-checkbox
            v-model="role.selected"
            color="black"
          />
        </v-flex>
        <v-flex xs10>
          <!-- setting 'right' property if we allow select to give space between checkbox at the left -->
          <v-icon
            v-if="role.team == &quot;good&quot;"
            :right="allowSelect"
          >
            fab fa-old-republic
          </v-icon>
          <v-icon
            v-else
            :right="allowSelect"
            color="red"
          >
            fas fa-empire
          </v-icon>
          {{ role.name }}
        </v-flex>
        <v-flex xs2>
          <v-btn
            icon
            @click="showRoleInfo(role)"
          >
            <v-icon>info</v-icon>
          </v-btn>
        </v-flex>
      </v-list-item> 
    </v-list>
    <v-dialog
      v-model="roleInfo"
      max-width="450"
    >
      <v-card class="cyan lighten-4">
        <v-card-title class="cyan lighten-2">
          <v-icon
            v-if="selectedRole.team == &quot;good&quot;"
            left
          >
            fab fa-old-republic
          </v-icon>
          <v-icon
            v-else
            left
            color="red"
          >
            fas fa-empire
          </v-icon>
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
