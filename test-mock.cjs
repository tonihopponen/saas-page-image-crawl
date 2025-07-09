// Mock test script for the Lambda handler
const { handler } = require('./dist/handlers/index.js');

// Mock the environment variables
process.env.OPENAI_API_KEY = 'mock-openai-key';
process.env.FIRECRAWL_API_KEY = 'mock-firecrawl-key';
process.env.S3_BUCKET = 'mock-s3-bucket';

// Mock the external dependencies
const originalRequire = require;
require = function(id) {
  if (id === 'openai') {
    return {
      default: class MockOpenAI {
        constructor() {}
        chat = {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '["https://example.com/page1", "https://example.com/page2"]' } }]
            })
          }
        }
      }
    };
  }
  if (id === 'axios') {
    return {
      default: {
        post: async () => ({ data: { rawHTML: '<html><img src="test.jpg" alt="test"/></html>', links: ['https://example.com/page1'], metadata: {} } }),
        head: async () => ({ headers: { 'content-length': '10000' } })
      }
    };
  }
  if (id === '@aws-sdk/client-s3') {
    return {
      S3Client: class MockS3Client {
        send() { return Promise.resolve(); }
      },
      PutObjectCommand: class {},
      GetObjectCommand: class {}
    };
  }
  if (id === 'probe-image-size') {
    return async () => ({ width: 800, height: 600 });
  }
  return originalRequire(id);
};

// Test with a sample URL
const testEvent = {
  body: JSON.stringify({ 
    url: 'https://example.com' 
  })
};

console.log('🧪 Testing Lambda handler with mocked dependencies...');
console.log('URL: https://example.com');

handler(testEvent)
  .then(result => {
    console.log('✅ Lambda executed successfully!');
    console.log('Status Code:', result.statusCode);
    console.log('Response Body:', result.body);
  })
  .catch(error => {
    console.error('❌ Lambda execution failed:');
    console.error(error.message);
  }); 