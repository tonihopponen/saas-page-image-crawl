// Simple test script for the Lambda handler
const { handler } = require('./dist/handlers/index.js');

// Test with a sample URL
const testEvent = {
  body: JSON.stringify({ 
    url: 'https://example.com' 
  })
};

console.log('Testing Lambda handler with URL: https://example.com');
console.log('Note: This will require API keys for Firecrawl and OpenAI to work properly.');

handler(testEvent)
  .then(result => {
    console.log('✅ Lambda executed successfully!');
    console.log('Status Code:', result.statusCode);
    console.log('Response Body:', result.body);
  })
  .catch(error => {
    console.error('❌ Lambda execution failed:');
    console.error(error.message);
    console.log('\nThis is expected if API keys are not configured.');
  }); 