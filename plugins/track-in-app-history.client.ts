// Lets any page decide whether router.back() has a real in-app destination,
// without the window.history.length footgun (it counts the browser's
// initial about:blank entry too, so it's 2 even in a brand-new tab).
export default defineNuxtPlugin(() => {
  const router = useRouter()
  const hasInAppHistory = useState('has-in-app-history', () => false)
  let navigations = 0
  router.afterEach(() => {
    navigations++
    if (navigations > 1) hasInAppHistory.value = true
  })
})
