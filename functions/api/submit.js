// Cloudflare Pages Function — proxy for JotForm submissions
//
// Lives at:  https://draodhan.com.au/api/submit
// Receives:  POST application/x-www-form-urlencoded from the website forms
// Forwards:  to the JotForm REST API with the API key from env vars
// Also fires: a server-side Meta CAPI "Lead" event to the Meta Pixel
//             dataset (id 439427055594933) using META_CAPI_ACCESS_TOKEN.
//
// Both secrets are held server-side as Cloudflare Pages encrypted env vars:
//   JOTFORM_API_KEY            — required, write access to the form
//   META_CAPI_ACCESS_TOKEN     — optional; if missing, CAPI firing is skipped
//
// Meta Pixel ID is hardcoded below because it's public information (it
// already ships in the client-side pixel snippet on every page).

const FORM_ID = '261458624229058';
const META_PIXEL_ID = '439427055594933';
const META_API_VERSION = 'v18.0';

// =============================================================================
// CORS preflight
// =============================================================================
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

// =============================================================================
// POST /api/submit
// =============================================================================
export async function onRequestPost(context) {
  const { request, env } = context;

  // --- Origin allowlist -----------------------------------------------------
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://draodhan.com.au',
    'https://www.draodhan.com.au',
  ];
  const originOk =
    allowedOrigins.includes(origin) ||
    origin.endsWith('.draodhan-website.pages.dev');
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

  // --- Read the full body once so we can both forward AND inspect it -------
  // The site always POSTs application/x-www-form-urlencoded (even photo
  // submissions, since the photo travels as a base64 text field).
  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'failed to read body: ' + err.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // --- Forward to JotForm ---------------------------------------------------
  const jotformUrl =
    'https://api.jotform.com/form/' +
    FORM_ID +
    '/submissions?apiKey=' +
    env.JOTFORM_API_KEY;

  let upstreamText = '';
  let upstreamStatus = 502;
  let upstreamContentType = 'application/json';
  try {
    const upstream = await fetch(jotformUrl, {
      method: 'POST',
      headers: {
        'Content-Type':
          request.headers.get('Content-Type') ||
          'application/x-www-form-urlencoded',
      },
      body: bodyText,
    });
    upstreamStatus = upstream.status;
    upstreamContentType = upstream.headers.get('Content-Type') || 'application/json';
    upstreamText = await upstream.text();
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'upstream failed: ' + err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // --- Fire Meta CAPI Lead in the background (only if JotForm succeeded) ---
  // Run AFTER returning the response so it doesn't add latency.
  let upstreamOk = false;
  try {
    const parsed = JSON.parse(upstreamText);
    upstreamOk = parsed && parsed.responseCode === 200;
  } catch (_) {}

  if (upstreamOk && env.META_CAPI_ACCESS_TOKEN) {
    context.waitUntil(
      fireMetaLead(bodyText, request, env).catch((err) => {
        console.warn('Meta CAPI Lead failed:', err && err.message);
      })
    );
  }

  // --- Return JotForm's response to the browser ----------------------------
  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: {
      'Content-Type': upstreamContentType,
      ...(origin && originOk
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
          }
        : {}),
    },
  });
}

// =============================================================================
// Meta Conversions API — server-side Lead event
// =============================================================================
async function fireMetaLead(bodyText, request, env) {
  // Parse the JotForm submission fields out of the urlencoded body
  const params = new URLSearchParams(bodyText);
  const fullName = (params.get('submission[6]') || '').trim();
  const email = (params.get('submission[7]') || '').trim().toLowerCase();
  const phone = (params.get('submission[8_full]') || '').trim();

  // Split name on first space → first/last
  const nameParts = fullName.split(/\s+/);
  const firstName = (nameParts[0] || '').toLowerCase();
  const lastName = (nameParts.slice(1).join(' ') || '').toLowerCase();

  // Normalise phone to digits with country code (Australia = 61, drop leading 0)
  const phoneDigits = phone.replace(/\D/g, '');
  let phoneNorm = phoneDigits;
  if (phoneDigits.startsWith('0')) {
    phoneNorm = '61' + phoneDigits.slice(1);
  } else if (!phoneDigits.startsWith('61') && phoneDigits.length === 9) {
    phoneNorm = '61' + phoneDigits;
  }

  // Hash all PII per Meta CAPI spec: SHA-256 hex
  const user_data = {};
  if (email) user_data.em = [await sha256Hex(email)];
  if (phoneNorm) user_data.ph = [await sha256Hex(phoneNorm)];
  if (firstName) user_data.fn = [await sha256Hex(firstName)];
  if (lastName) user_data.ln = [await sha256Hex(lastName)];

  // Pass through the patient's IP + UA — Meta uses these to match the event
  // back to an ad click. Cloudflare provides cf-connecting-ip.
  const ip = request.headers.get('cf-connecting-ip');
  const ua = request.headers.get('user-agent');
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  // Pass through _fbp / _fbc cookies if present — improves match quality
  const cookieHeader = request.headers.get('cookie') || '';
  const fbp = parseCookie(cookieHeader, '_fbp');
  const fbc = parseCookie(cookieHeader, '_fbc');
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  // Event source URL is best-effort — the form may have been on either page
  const referer = request.headers.get('referer') || 'https://draodhan.com.au/';

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: referer,
        user_data,
        custom_data: {
          content_name: 'Smile Assessment',
          content_category: 'cosmetic_dentistry',
        },
        // event_id helps Meta dedupe against any client-side Lead that
        // happens to fire on the same submission. Using a stable id based
        // on email+timestamp(minute) to be safe.
        event_id:
          'lead_' +
          (await sha256Hex(email + '|' + Math.floor(Date.now() / 60000))).slice(
            0,
            16
          ),
      },
    ],
  };

  // If META_CAPI_TEST_EVENT_CODE is set, include it so events appear in
  // Events Manager → Test Events tab without affecting production metrics.
  if (env.META_CAPI_TEST_EVENT_CODE) {
    payload.test_event_code = env.META_CAPI_TEST_EVENT_CODE;
  }

  const url =
    'https://graph.facebook.com/' +
    META_API_VERSION +
    '/' +
    META_PIXEL_ID +
    '/events?access_token=' +
    encodeURIComponent(env.META_CAPI_ACCESS_TOKEN);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text();
    console.warn('Meta CAPI returned', r.status, errText);
  }
}

// SHA-256 hex digest using Web Crypto (available in Cloudflare Workers)
async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Extract a single cookie value from a Cookie header string
function parseCookie(cookieHeader, name) {
  const re = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)');
  const m = cookieHeader.match(re);
  return m ? decodeURIComponent(m[1]) : '';
}
