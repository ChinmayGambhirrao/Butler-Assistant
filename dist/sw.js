self.addEventListener('push', event => {
  let data = { title: 'Butler Assistant', body: 'Good morning sir!' }
  try {
    if (event.data) data = event.data.json()
  } catch {}

  const options = {
    body: data.body,
    icon: '/butler-icon-192.png',
    badge: '/butler-icon-192.png',
    tag: 'morning-briefing',
    renotify: true,
    data: { url: '/' },
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(clients.openWindow(url))
})
