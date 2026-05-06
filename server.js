/**
 * FedEx Tracking Demo - Express backend
 *
 * Responsibilities:
 *   - Hide FedEx OAuth credentials from the browser.
 *   - Acquire and cache an OAuth bearer token.
 *   - Proxy /api/track requests to the FedEx Track v1 endpoint.
 *   - Normalize the response into a friendly shape for the React UI.
 *   - Serve the static frontend (public/index.html) on /.
 *
 * Endpoint reference: https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
//
// Hard-coded demo credentials are provided as fallbacks so the app runs
// out-of-the-box. In a real deployment, set them via environment variables
// (see .env.example) and remove the fallbacks below.
const FEDEX_API_KEY = process.env.FEDEX_API_KEY || 'l76c36bba49c73476c97064a77a9326194';
const FEDEX_API_SECRET = process.env.FEDEX_API_SECRET || '239223570dcb4235b186bd705fa764c0';
const FEDEX_ACCOUNT_NUMBER = process.env.FEDEX_ACCOUNT_NUMBER || '740561073';
const FEDEX_API_BASE = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';

const PORT = Number(process.env.PORT) || 3001;

// Tracking numbers FedEx accepts are 12 - 22 digits depending on service,
// but the spec for this demo restricts to 12 - 15 digits.
const TRACKING_NUMBER_PATTERN = /^\d{12,15}$/;

// ---------------------------------------------------------------------------
// OAuth token cache
// ---------------------------------------------------------------------------
//
// FedEx OAuth tokens are valid for ~1 hour. Cache the token in memory and
// refresh ~60 seconds before expiry to avoid unnecessary round-trips.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', FEDEX_API_KEY);
  params.append('client_secret', FEDEX_API_SECRET);

  const { data } = await axios.post(
    `${FEDEX_API_BASE}/oauth/token`,
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    },
  );

  if (!data || !data.access_token) {
    throw new Error('FedEx OAuth response did not include an access_token.');
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
  return cachedToken;
}

// ---------------------------------------------------------------------------
// Tracking helpers
// ---------------------------------------------------------------------------

async function fetchTracking(trackingNumber) {
  const token = await getAccessToken();

  const body = {
    includeDetailedScans: true,
    trackingInfo: [
      {
        trackingNumberInfo: { trackingNumber },
      },
    ],
  };

  const { data } = await axios.post(
    `${FEDEX_API_BASE}/track/v1/trackingnumbers`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
        Authorization: `Bearer ${token}`,
      },
      timeout: 20_000,
    },
  );

  return data;
}

/**
 * Convert the FedEx response into a friendlier shape for the UI.
 * Returns null if the response contains no usable tracking data.
 */
function normalizeTracking(rawResponse) {
  const completeResults = rawResponse?.output?.completeTrackResults;
  if (!Array.isArray(completeResults) || completeResults.length === 0) {
    return null;
  }

  const completeResult = completeResults[0];
  const trackResults = Array.isArray(completeResult.trackResults)
    ? completeResult.trackResults
    : [];

  if (trackResults.length === 0) {
    return null;
  }

  const trackResult = trackResults[0];

  // FedEx returns a notification-style error object inside trackResult when
  // a tracking number is invalid or unknown. Surface that to the caller.
  if (Array.isArray(trackResult.error) && trackResult.error.length > 0) {
    const err = trackResult.error[0];
    const message = err?.message || 'FedEx returned an error for this tracking number.';
    const e = new Error(message);
    e.code = err?.code || 'TRACKING_ERROR';
    e.statusCode = 404;
    throw e;
  }

  const status = trackResult.latestStatusDetail || {};
  const dateAndTimes = Array.isArray(trackResult.dateAndTimes)
    ? trackResult.dateAndTimes
    : [];
  const findDate = (type) => dateAndTimes.find((d) => d.type === type)?.dateTime || null;

  const serviceDetail = trackResult.serviceDetail || {};
  const shipperAddress = trackResult.shipperInformation?.address || {};
  const recipientAddress = trackResult.recipientInformation?.address || {};

  const scanEvents = Array.isArray(trackResult.scanEvents) ? trackResult.scanEvents : [];
  const timeline = scanEvents.map((event) => ({
    date: event.date || null,
    description: event.eventDescription || event.derivedStatus || 'Status update',
    location: formatScanLocation(event.scanLocation),
    exceptionDescription: event.exceptionDescription || null,
  }));

  return {
    trackingNumber: completeResult.trackingNumber,
    status: {
      code: status.code || null,
      description: status.description || status.statusByLocale || 'Unknown',
      ancillaryDetails: Array.isArray(status.ancillaryDetails)
        ? status.ancillaryDetails.map((d) => d.reasonDescription).filter(Boolean)
        : [],
    },
    estimatedDelivery: findDate('ESTIMATED_DELIVERY'),
    scheduledDelivery: findDate('SCHEDULED_DELIVERY') || findDate('APPOINTMENT_DELIVERY'),
    actualDelivery: findDate('ACTUAL_DELIVERY'),
    shipDate: findDate('SHIP') || findDate('ACTUAL_PICKUP'),
    serviceType: serviceDetail.description || serviceDetail.type || serviceDetail.shortDescription || 'Unknown',
    origin: formatAddress(shipperAddress),
    destination: formatAddress(recipientAddress),
    timeline,
  };
}

function formatAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const lineParts = [address.city, address.stateOrProvinceCode]
    .filter(Boolean)
    .join(', ');
  const country = address.countryName || address.countryCode || '';
  const zip = address.postalCode || '';
  const tail = [zip, country].filter(Boolean).join(' ');
  const combined = [lineParts, tail].filter(Boolean).join(' ');
  return combined.trim() || null;
}

function formatScanLocation(scanLocation) {
  if (!scanLocation || typeof scanLocation !== 'object') return null;
  const parts = [
    scanLocation.city,
    scanLocation.stateOrProvinceCode,
    scanLocation.countryCode,
  ].filter(Boolean);
  return parts.join(', ') || null;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/track/:trackingNumber', async (req, res) => {
  const { trackingNumber } = req.params;

  if (!TRACKING_NUMBER_PATTERN.test(trackingNumber)) {
    return res.status(400).json({
      error: 'INVALID_TRACKING_NUMBER',
      message: 'Tracking number must be 12 to 15 digits.',
    });
  }

  try {
    const raw = await fetchTracking(trackingNumber);
    const normalized = normalizeTracking(raw);

    if (!normalized) {
      return res.status(404).json({
        error: 'NO_TRACKING_DATA',
        message: 'FedEx returned no tracking data for this number.',
      });
    }

    return res.json(normalized);
  } catch (err) {
    return handleError(err, res);
  }
});

function handleError(err, res) {
  // Errors thrown by normalizeTracking carry a friendlier statusCode/code.
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.code || 'TRACKING_ERROR',
      message: err.message,
    });
  }

  // Axios HTTP errors from FedEx itself.
  if (err.response) {
    const status = err.response.status;
    const fedexErrors = err.response.data?.errors;
    const fedexMessage = Array.isArray(fedexErrors) && fedexErrors[0]?.message;

    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: 'AUTH_FAILED',
        message:
          'Could not authenticate with FedEx. Check API key/secret or that the credentials are enabled in the FedEx Developer portal.',
      });
    }
    if (status === 404) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: fedexMessage || 'Tracking number not found.',
      });
    }
    return res.status(502).json({
      error: 'FEDEX_API_ERROR',
      message: fedexMessage || `FedEx API responded with status ${status}.`,
    });
  }

  // Network/timeout errors.
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return res.status(504).json({
      error: 'TIMEOUT',
      message: 'FedEx API timed out. Please try again.',
    });
  }
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Could not reach the FedEx API. Please try again later.',
    });
  }

  console.error('[fedex-tracker] unexpected error:', err);
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred while fetching tracking information.',
  });
}

app.listen(PORT, () => {
  console.log(`FedEx tracker backend listening on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in a browser for the demo UI.`);
});
