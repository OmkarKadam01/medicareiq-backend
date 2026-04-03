'use strict';

const admin = require('firebase-admin');

let messaging = null;
let initialized = false;

/**
 * Initialize Firebase Admin SDK.
 * Called once at app startup.
 * Skips initialization gracefully if env vars are missing (dev mode).
 */
function initializeFirebase() {
  if (initialized) return;

  const projectId    = process.env.FIREBASE_PROJECT_ID;
  const privateKey   = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail  = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    console.warn(
      '[FCM] WARNING: Firebase credentials not fully configured. ' +
      'Push notifications will be disabled. ' +
      'Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, and FIREBASE_CLIENT_EMAIL.'
    );
    initialized = true;
    return;
  }

  try {
    // Avoid re-initializing if the default app already exists
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          // The private key in .env is typically a single line with \n literals
          privateKey: privateKey.replace(/\\n/g, '\n'),
          clientEmail,
        }),
      });
    }

    messaging = admin.messaging();
    initialized = true;
    console.log('[FCM] Firebase Admin SDK initialized successfully');
  } catch (err) {
    console.error('[FCM] Failed to initialize Firebase Admin SDK:', err.message);
    initialized = true; // Mark as initialized to avoid retry loops
  }
}

/**
 * Send an FCM push notification to a specific device token.
 *
 * @param {string} fcmToken - The recipient device FCM registration token
 * @param {string} title    - Notification title
 * @param {string} body     - Notification body
 * @param {Object} data     - Additional key-value data payload (all values must be strings)
 * @returns {Promise<string|null>} Message ID on success, null on failure
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!messaging) {
    console.warn('[FCM] Messaging not initialized. Skipping notification:', title);
    return null;
  }

  if (!fcmToken) {
    console.warn('[FCM] No FCM token provided. Skipping notification:', title);
    return null;
  }

  // Ensure all data values are strings (FCM requirement)
  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = String(value);
  }

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const messageId = await messaging.send(message);
    console.log(`[FCM] Notification sent successfully. Message ID: ${messageId}`);
    return messageId;
  } catch (err) {
    // Handle specific FCM errors gracefully — don't crash the server
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      console.warn(`[FCM] Invalid or expired token for notification '${title}'. Token should be removed.`);
    } else if (err.code === 'messaging/message-rate-exceeded') {
      console.warn(`[FCM] Message rate exceeded for token. Notification '${title}' dropped.`);
    } else {
      console.error(`[FCM] Failed to send notification '${title}':`, err.message);
    }
    return null;
  }
}

/**
 * Send FCM notification to multiple tokens at once (batch).
 *
 * @param {string[]} fcmTokens - Array of FCM tokens
 * @param {string}   title
 * @param {string}   body
 * @param {Object}   data
 * @returns {Promise<Object>} { successCount, failureCount }
 */
async function sendMulticastNotification(fcmTokens, title, body, data = {}) {
  if (!messaging) {
    console.warn('[FCM] Messaging not initialized. Skipping multicast notification.');
    return { successCount: 0, failureCount: fcmTokens.length };
  }

  const validTokens = fcmTokens.filter(Boolean);
  if (validTokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = String(value);
  }

  const message = {
    tokens: validTokens,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high' },
  };

  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log(
      `[FCM] Multicast result: ${response.successCount} sent, ${response.failureCount} failed`
    );
    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error('[FCM] Multicast notification error:', err.message);
    return { successCount: 0, failureCount: validTokens.length };
  }
}

module.exports = { initializeFirebase, sendNotification, sendMulticastNotification };
