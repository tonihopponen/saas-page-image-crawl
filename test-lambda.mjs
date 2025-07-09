(async () => {
  const { handler } = await import('./dist/handlers/index.js');
  
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