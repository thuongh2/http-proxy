addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const startTime = Date.now()
  const url = new URL(request.url)
  const requestId = generateRequestId()
  
  // Log incoming request
  console.log(`[${requestId}] Incoming: ${request.method} ${url.pathname}${url.search}`)
  console.log(`[${requestId}] Headers:`, Object.fromEntries(request.headers.entries()))
  console.log(`[${requestId}] User-Agent:`, request.headers.get('user-agent') || 'unknown')
  console.log(`[${requestId}] CF-Connecting-IP:`, request.headers.get('cf-connecting-ip') || 'unknown')
  
  // Xử lý OPTIONS request cho CORS
  if (request.method === 'OPTIONS') {
    console.log(`[${requestId}] CORS preflight request`)
    const response = handleCORS()
    logResponse(requestId, response, startTime)
    return response
  }
  
  // Lấy target URL từ query parameter hoặc header
  let targetUrl = url.searchParams.get('url') || 
                  url.searchParams.get('target') ||
                  request.headers.get('X-Target-URL')
  
  // Nếu không có target URL, trả về hướng dẫn sử dụng
  if (!targetUrl) {
    console.log(`[${requestId}] ERROR: Missing target URL`)
    const response = new Response(JSON.stringify({
      error: 'Missing target URL',
      usage: {
        method1: 'Add ?url=https://example.com to your request',
        method2: 'Add ?target=https://example.com to your request', 
        method3: 'Add X-Target-URL header with target URL',
        example: 'https://your-worker.workers.dev?url=https://jsonplaceholder.typicode.com/posts'
      }
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
    logResponse(requestId, response, startTime)
    return response
  }
  
  // Validate URL
  try {
    new URL(targetUrl)
    console.log(`[${requestId}] Target URL: ${targetUrl}`)
  } catch (e) {
    console.log(`[${requestId}] ERROR: Invalid target URL: ${targetUrl}`)
    const response = new Response(JSON.stringify({
      error: 'Invalid target URL',
      provided: targetUrl
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
    logResponse(requestId, response, startTime)
    return response
  }
  
  // Xóa proxy parameters khỏi URL
  const cleanUrl = new URL(request.url)
  cleanUrl.searchParams.delete('url')
  cleanUrl.searchParams.delete('target')
  
  // Tạo target URL với path và query string
  const finalTargetUrl = new URL(targetUrl)
  finalTargetUrl.pathname = cleanUrl.pathname === '/' ? finalTargetUrl.pathname : cleanUrl.pathname
  finalTargetUrl.search = cleanUrl.search
  
  // Copy headers và xử lý
  const proxyHeaders = new Headers(request.headers)
  
  // Xóa headers không cần thiết
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')
  proxyHeaders.delete('cf-ipcountry')
  proxyHeaders.delete('x-target-url')
  
  // Thêm headers proxy thông tin
  proxyHeaders.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || 'unknown')
  proxyHeaders.set('X-Forwarded-Proto', 'https')
  proxyHeaders.set('X-Forwarded-Host', url.hostname)
  
  try {
    // Tạo và gửi request
    const proxyRequest = new Request(finalTargetUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    })
    
    console.log(`[${requestId}] Proxying to: ${finalTargetUrl.toString()}`)
    console.log(`[${requestId}] Proxy headers:`, Object.fromEntries(proxyHeaders.entries()))
    
    const fetchStart = Date.now()
    const response = await fetch(proxyRequest)
    const fetchTime = Date.now() - fetchStart
    
    console.log(`[${requestId}] Target response: ${response.status} ${response.statusText}`)
    console.log(`[${requestId}] Target response time: ${fetchTime}ms`)
    console.log(`[${requestId}] Target response headers:`, Object.fromEntries(response.headers.entries()))
    
    // Copy response
    const proxyResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
    
    // Thêm CORS headers
    proxyResponse.headers.set('Access-Control-Allow-Origin', '*')
    proxyResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    proxyResponse.headers.set('Access-Control-Allow-Headers', '*')
    proxyResponse.headers.set('Access-Control-Expose-Headers', '*')
    
    // Thêm proxy info headers
    proxyResponse.headers.set('X-Proxy-By', 'Cloudflare-Worker')
    proxyResponse.headers.set('X-Target-URL', targetUrl)
    proxyResponse.headers.set('X-Request-ID', requestId)
    proxyResponse.headers.set('X-Proxy-Time', `${fetchTime}ms`)
    
    logResponse(requestId, proxyResponse, startTime)
    return proxyResponse
    
  } catch (error) {
    console.log(`[${requestId}] ERROR: Proxy request failed - ${error.message}`)
    console.log(`[${requestId}] Error stack:`, error.stack)
    
    const response = new Response(JSON.stringify({
      error: 'Proxy request failed',
      message: error.message,
      target: finalTargetUrl.toString(),
      requestId: requestId
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Request-ID': requestId
      }
    })
    logResponse(requestId, response, startTime)
    return response
  }
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }
  })
}

// Health check endpoint
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === '/health' || url.pathname === '/ping') {
    event.respondWith(new Response(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'HTTP Proxy Worker'
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }))
  }
})