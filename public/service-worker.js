self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Signal Alert', body: 'New signal triggered!' };
  const options = {
    body: data.body,
    icon: '/star-icon.png', // Placeholder
    badge: '/star-icon.png',
    data: data.url || '/',
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data)
  );
});
