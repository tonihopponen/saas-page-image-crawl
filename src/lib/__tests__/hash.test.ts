const { sha256 } = require('../s3');

test('sha256 produces 64-char hex', () => {
  expect(sha256('https://a.com').length).toBe(64);
});
