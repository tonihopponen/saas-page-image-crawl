import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

/**
 * Temporary stub — proves the wiring works.
 * Replace with real logic in Step 2.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Lambda skeleton is alive!',
      received: event.body ?? null
    })
  };
};
