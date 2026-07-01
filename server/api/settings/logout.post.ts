export default defineEventHandler((event) => {
  deleteCookie(event, 'settings_session', { path: '/' })
  return { ok: true }
})
