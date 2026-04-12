// シンプルなテストAPI
export const prerender = false;

export async function GET() {
  console.log('[API] Simple test endpoint called');
  
  return new Response(JSON.stringify({ 
    message: 'Hello from API',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST({ request }) {
  console.log('[API] Simple POST endpoint called');
  console.log('[API] Request headers:', Object.fromEntries(request.headers));
  console.log('[API] Request method:', request.method);
  
  try {
    // request.json()の代わりに手動でパーシング
    console.log('[API] Reading request text...');
    const text = await request.text();
    console.log('[API] Request text:', text);
    
    let body;
    if (text) {
      try {
        body = JSON.parse(text);
        console.log('[API] Parsed body:', body);
      } catch (parseError) {
        console.log('[API] JSON parse error:', parseError.message);
        body = { rawText: text };
      }
    } else {
      console.log('[API] Empty request body');
      body = {};
    }
    
    return new Response(JSON.stringify({ 
      message: 'POST received successfully',
      data: body,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('[API] Error:', error);
    
    return new Response(JSON.stringify({ 
      error: 'Bad request',
      message: error.message
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}