import { useToast as useToastification } from 'vue-toastification'

export function useToast() {
  const toast = useToastification()

  return {
    success: (message: string) => toast.success(message),
    error: (message: string) => toast.error(message),
    info: (message: string) => toast.info(message),
    warning: (message: string) => toast.warning(message),
    show: (message: string) => toast(message)
  }
}
