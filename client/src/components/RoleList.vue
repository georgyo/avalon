<template>
  <div>
    <v-list class="bg-blue-grey-lighten-4">
      <v-list-item
        v-for="(role, index) in roles"
        :key="index"
      >
        <v-col
          v-if="allowSelect"
          cols="1"
        >
          <v-checkbox
            v-model="role.selected"
            color="black"
          />
        </v-col>
        <v-col cols="10">
          <!-- setting 'end' property if we allow select to give space between checkbox at the start -->
          <v-icon
            v-if="role.team == &quot;good&quot;"
            :end="allowSelect"
            icon="fa:fab fa-old-republic"
          />
          <v-icon
            v-else
            :end="allowSelect"
            color="red"
            icon="fa:fas fa-empire"
          />
          {{ role.name }}
        </v-col>
        <v-col cols="2">
          <v-btn
            icon
            @click="showRoleInfo(role)"
          >
            <v-icon icon="info" />
          </v-btn>
        </v-col>
      </v-list-item>
    </v-list>
    <v-dialog
      v-model="roleInfo"
      max-width="450"
    >
      <v-card class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
          <v-icon
            v-if="selectedRole.team == &quot;good&quot;"
            start
            icon="fa:fab fa-old-republic"
          />
          <v-icon
            v-else
            start
            color="red"
            icon="fa:fas fa-empire"
          />
          <h3>{{ selectedRole.name }}</h3>
        </v-card-title>
        <v-card-text>
          {{ selectedRole.description }}
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface Role {
  name: string
  team: 'good' | 'evil'
  description: string
  selected?: boolean
}

defineProps<{
  roles: Role[]
  allowSelect: boolean
}>()

const roleInfo = ref(false)
const selectedRole = ref<Role>({
  name: '',
  team: 'good',
  description: ''
})

function showRoleInfo(role: Role): void {
  roleInfo.value = true
  selectedRole.value = role
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
