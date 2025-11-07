import { createApp } from 'vue'
import { createPinia } from 'pinia'
import type { Emitter } from 'mitt'
import App from './App.vue'
import vuetify from './plugins/vuetify'
import Toast, { type PluginOptions } from 'vue-toastification'
import 'vue-toastification/dist/index.css'
import '@mdi/font/css/materialdesignicons.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import { library } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon, FontAwesomeLayers, FontAwesomeLayersText } from '@fortawesome/vue-fontawesome'
import mitt from 'mitt'

// importing icons which we need for layering and manipulations
import { faCrown, faCircle as faSolidCircle, faEllipsisH, faVoteYea } from '@fortawesome/free-solid-svg-icons'
import { faCircle, faTimesCircle, faCheckCircle, faThumbsUp, faThumbsDown } from '@fortawesome/free-regular-svg-icons'

library.add(faCrown, faSolidCircle, faCircle,
  faTimesCircle, faCheckCircle, faThumbsDown, faThumbsUp,
  faEllipsisH, faVoteYea)
// the line below would add EVERYTHING, so would bloat the size
//library.add(far, fas);

// Create mitt event emitter for EventBus replacement
export const eventBus: Emitter<any> = mitt()

const app = createApp(App)
const pinia = createPinia()

// Register FontAwesome components globally
app.component('font-awesome-icon', FontAwesomeIcon)
app.component('font-awesome-layers', FontAwesomeLayers)
app.component('font-awesome-layers-text', FontAwesomeLayersText)

// Provide event bus globally
app.provide('eventBus', eventBus)

// Use Pinia
app.use(pinia)

// Configure toast
const toastOptions: PluginOptions = {
  position: 'top-center',
  timeout: 2000,
  closeOnClick: true,
  pauseOnFocusLoss: true,
  pauseOnHover: true,
  draggable: true,
  draggablePercent: 0.6,
  showCloseButtonOnHover: false,
  hideProgressBar: false,
  closeButton: 'button',
  icon: true,
  rtl: false,
  transition: 'Vue-Toastification__bounce',
  maxToasts: 20,
  newestOnTop: true
}
app.use(Toast, toastOptions)

app.use(vuetify)

app.mount('#app')
