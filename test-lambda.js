const { handler } = require('./src/handlers/index');

(async () => {
  const event = {
    body: JSON.stringify({ url: 'https://example.com' })
  };
  try {
    const result = await handler(event);
    console.log('Lambda result:', result);
  } catch (err) {
    console.error('Error:', err);
  }
})(); 