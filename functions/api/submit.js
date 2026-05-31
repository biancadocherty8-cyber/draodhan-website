// Cloudflare Pages Function — proxy for JotForm submissions
// v2 — rebuild trigger after API key rotation
//
// Lives at:  https://draodhan.com.au/api/submit
// Receives:  POST form-urlencoded or multipart from the website forms
// Forwards:  to the JotForm REST API with the API key from env vars
//
// The JotForm API key is held server-side as a Cloudflare Pages encrypted
// environment variable (JOTFORM_API_KEY). It never reaches the browser, so
// the GitHub repo stays free of secrets.

export async function onRequestPost(context) {
  const { request, env } = context;

  // Lock down to our own domain. Browsers send Origin on POST; we accept
  // requests originating from draodhan.com.au only (plus the Cloudflare
  // Pages preview domain for testing).
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://draodhan.com.au',
    'https://www.draodhan.com.au',
  ];
  const allowedSuffix = '.draodhan-website.pages.dev'; // CF Pages previews
  const originOk =
    allowedOrigins.includes(origin) ||
    origin.endsWith(allowedSuffix);

  // Allow same-origin requests with no Origin header (some browsers omit it
  // for same-origin POSTs). Only block when an Origin IS present and is
  // not on our allowlist.
  if (origin && !originOk) {
    return new Response(
      JSON.stringify({ ok: false, error: 'origin not allowed' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!env.JOTFORM_API_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: 'server not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Hardcoded form ID — only one form is allowed to be submitted through
  // this proxy. If we ever add a second form we'd parameterise via path.
  const FORM_ID = '261458624229058';
  const jotformUrl =
    'https://api.jotform.com/form/' +
    FORM_ID +
    '/submissions?apiKey=' +
    env.JOTFORM_API_KEY;

  try {
    // Forward the body to JotForm as-is. The Content-Type that the browser
    // set (urlencoded or multipart) is preserved.
    const upstream = await fetch(jotformUrl, {
      method: 'POST',
      headers: {
        'Content-Type':
          request.headers.get('Content-Type') ||
          'application/x-www-form-urlencoded',
      },
      body: request.body,
      // Required when forwarding a streamed request body in Workers
      duplex: 'half',
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type':
          upstream.headers.get('Content-Type') || 'application/json',
        // Echo the origin back so the browser accepts the response
        ...(origin && originOk
          ? {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Credentials': 'true',
            }
          : {}),
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'upstream failed: ' + err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Handle CORS preflight from the browser
export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
