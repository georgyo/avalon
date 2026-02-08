import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import 'vuetify/styles'
import { aliases, fa } from 'vuetify/iconsets/fa'
import { mdi } from 'vuetify/iconsets/mdi'
import App from './App.vue'
import Toast from 'vue-toastification'
import 'vue-toastification/dist/index.css'
import '@mdi/font/css/materialdesignicons.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import { library } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon, FontAwesomeLayers, FontAwesomeLayersText } from '@fortawesome/vue-fontawesome'

// importing icons which we need for layering and manipulations
import { faCrown, faCircle as faSolidCircle, faEllipsisH, faVoteYea } from '@fortawesome/free-solid-svg-icons'
import { faCircle, faTimesCircle, faCheckCircle, faThumbsUp, faThumbsDown } from '@fortawesome/free-regular-svg-icons'
import { faOldRepublic, faEmpire } from '@fortawesome/free-brands-svg-icons'

library.add(faCrown, faSolidCircle, faCircle,
  faTimesCircle, faCheckCircle, faThumbsDown, faThumbsUp,
  faEllipsisH, faVoteYea, faOldRepublic, faEmpire);

const vuetify = createVuetify({
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: {
      mdi,
      fa,
    },
  },
  theme: {
    defaultTheme: 'light',
  },
})

const app = createApp(App)

app.use(vuetify)

app.use(Toast, {
  position: 'top-center',
  timeout: 2000,
  maxToasts: 3,
})

app.component('font-awesome-icon', FontAwesomeIcon)
app.component('font-awesome-layers', FontAwesomeLayers)
app.component('font-awesome-layers-text', FontAwesomeLayersText)

app.mount('#app')
