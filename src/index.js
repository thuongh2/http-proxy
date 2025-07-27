// Configuration will be loaded from environment variables

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  
  // Health check endpoints - no auth required
  if (url.pathname === '/health' || url.pathname === '/ping') {
    event.respondWith(handleHealthCheck(event.request))
    return
  }
  
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const url = new URL(request.url)
  
  try {
    // Log incoming request (single log entry)
    console.log(`[${requestId}] REQUEST: ${request.method} ${url.pathname}${url.search} | User-Agent: ${request.headers.get('user-agent') || 'unknown'} | IP: ${request.headers.get('cf-connecting-ip') || 'unknown'}`)
    
    // Basic Authentication Check
    const requireAuth = getEnvVar('REQUIRE_AUTH', 'true') === 'true'
    if (requireAuth && !isAuthenticated(request)) {
      const response = new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Proxy API"',
          'Access-Control-Allow-Origin': '*'
        }
      })
      logResponse(requestId, response, startTime, 'AUTH_FAILED')
      return response
    }
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const response = handleCORS()
      logResponse(requestId, response, startTime, 'CORS_PREFLIGHT')
      return response
    }
    
    // Get target URL
    const targetUrl = getTargetUrl(url, request.headers)
    if (!targetUrl.success) {
      const response = createErrorResponse(targetUrl.error, 400)
      logResponse(requestId, response, startTime, 'INVALID_TARGET')
      return response
    }
    
    // Build final target URL
    const finalTargetUrl = buildFinalTargetUrl(targetUrl.url, url)
    
    // Create and send proxy request
    const proxyRequest = createProxyRequest(request, finalTargetUrl, url)
    const fetchStart = Date.now()
    const response = await fetch(proxyRequest)
    const fetchTime = Date.now() - fetchStart
    
    // Create proxy response with CORS headers
    const proxyResponse = createProxyResponse(response, targetUrl.url, requestId, fetchTime)
    
    logResponse(requestId, proxyResponse, startTime, 'SUCCESS', fetchTime)
    return proxyResponse
    
  } catch (error) {
    // Log error
    console.error(`[${requestId}] ERROR: ${error.message} | Stack: ${error.stack}`)
    
    const response = createErrorResponse({
      error: 'Proxy request failed',
      message: error.message,
      requestId: requestId
    }, 502)
    
    logResponse(requestId, response, startTime, 'ERROR')
    return response
  }
}

function isAuthenticated(request) {
  const requireAuth = getEnvVar('REQUIRE_AUTH', 'true') === 'true'
  if (!requireAuth) return true
  
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false
  }
  
  try {
    const credentials = atob(authHeader.slice(6))
    const [username, password] = credentials.split(':')
    
    // Get credentials from environment variables
    const validUser = getEnvVar('BASIC_AUTH_USER', 'admin')
    const validPass = getEnvVar('BASIC_AUTH_PASS', 'password')
    
    return username === validUser && password === validPass
  } catch (e) {
    return false
  }
}

function getTargetUrl(url, headers) {
  const targetUrl = url.searchParams.get('url') || 
                   url.searchParams.get('target') ||
                   headers.get('X-Target-URL')
  
  if (!targetUrl) {
    return {
      success: false,
      error: {
        error: 'Missing target URL',
        usage: {
          method1: 'Add ?url=https://example.com to your request',
          method2: 'Add ?target=https://example.com to your request', 
          method3: 'Add X-Target-URL header with target URL',
          example: 'https://your-worker.workers.dev?url=https://jsonplaceholder.typicode.com/posts'
        }
      }
    }
  }
  
  try {
    new URL(targetUrl)
    return { success: true, url: targetUrl }
  } catch (e) {
    return {
      success: false,
      error: {
        error: 'Invalid target URL',
        provided: targetUrl
      }
    }
  }
}

function buildFinalTargetUrl(targetUrl, originalUrl) {
  const cleanUrl = new URL(originalUrl)
  cleanUrl.searchParams.delete('url')
  cleanUrl.searchParams.delete('target')
  
  const finalTargetUrl = new URL(targetUrl)
  finalTargetUrl.pathname = cleanUrl.pathname === '/' ? finalTargetUrl.pathname : cleanUrl.pathname
  finalTargetUrl.search = cleanUrl.search
  
  return finalTargetUrl
}

function createProxyRequest(request, finalTargetUrl, originalUrl) {
  const proxyHeaders = new Headers(request.headers)
  
  // Remove Cloudflare-specific headers
  const headersToRemove = [
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
    'x-target-url', 'authorization' // Remove auth header from proxied request
  ]
  headersToRemove.forEach(header => proxyHeaders.delete(header))
  
  // Add forwarding headers
  proxyHeaders.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || 'unknown')
  proxyHeaders.set('X-Forwarded-Proto', 'https')
  proxyHeaders.set('X-Forwarded-Host', originalUrl.hostname)
  
  return new Request(finalTargetUrl.toString(), {
    method: request.method,
    headers: proxyHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
  })
}

function createProxyResponse(response, targetUrl, requestId, fetchTime) {
  const proxyResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  
  // Add CORS headers
  proxyResponse.headers.set('Access-Control-Allow-Origin', '*')
  proxyResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  proxyResponse.headers.set('Access-Control-Allow-Headers', '*')
  proxyResponse.headers.set('Access-Control-Expose-Headers', '*')
  
  // Add proxy info headers
  proxyResponse.headers.set('X-Proxy-By', 'Cloudflare-Worker')
  proxyResponse.headers.set('X-Target-URL', targetUrl)
  proxyResponse.headers.set('X-Request-ID', requestId)
  proxyResponse.headers.set('X-Proxy-Time', `${fetchTime}ms`)
  
  return proxyResponse
}

function createErrorResponse(errorData, status) {
  return new Response(JSON.stringify(errorData), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
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

async function handleHealthCheck(request) {
  const requestId = generateRequestId()
  const requireAuth = getEnvVar('REQUIRE_AUTH', 'true') === 'true'
  const environment = getEnvVar('ENVIRONMENT', 'production')
  
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'HTTP Proxy Worker',
    environment: environment,
    requestId: requestId,
    auth_required: requireAuth
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Request-ID': requestId
    }
  })
}

function generateRequestId() {
  return Math.random().toString(36).substr(2, 9) + '-' + Date.now().toString(36)
}

function logResponse(requestId, response, startTime, status, fetchTime = null) {
  const totalTime = Date.now() - startTime
  const fetchTimeStr = fetchTime ? ` | Fetch: ${fetchTime}ms` : ''
  console.log(`[${requestId}] RESPONSE: ${response.status} ${response.statusText || ''} | Status: ${status} | Total: ${totalTime}ms${fetchTimeStr}`)
}

// Utility function to get environment variables
function getEnvVar(name, defaultValue = null) {
  // In Cloudflare Workers, environment variables are available on globalThis
  return globalThis[name] || defaultValue
}